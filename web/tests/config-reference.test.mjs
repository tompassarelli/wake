import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const wakeRoot = join(import.meta.dir, "..", "..");
const beagleRoot = process.env.BEAGLE_ROOT ?? join(homedir(), "code", "beagle", "main");

let buildDir;
let parseAll;
let resolveSourceForms;

function compile(source, output) {
  const result = Bun.spawnSync([join(beagleRoot, "bin", "beagle-build"), source, output], {
    env: { ...process.env, BEAGLE_JS_RUNTIME_PREFIX: "./beagle/" },
    stderr: "pipe",
    stdout: "pipe",
  });
  assert.equal(result.exitCode, 0, result.stderr.toString() || result.stdout.toString());
}

async function appendExport(path, names) {
  const source = await Bun.file(path).text();
  await Bun.write(path, `${source}\nexport { ${names.join(", ")} };\n`);
}

beforeAll(async () => {
  buildDir = mkdtempSync(join(tmpdir(), "wake-config-reference-"));
  mkdirSync(join(buildDir, "beagle"));
  copyFileSync(
    join(beagleRoot, "beagle-lib", "lib", "beagle", "core.js"),
    join(buildDir, "beagle", "core.js"),
  );
  copyFileSync(
    join(beagleRoot, "beagle-lib", "lib", "beagle", "hamt.js"),
    join(buildDir, "beagle", "hamt.js"),
  );
  await Bun.write(join(buildDir, "package.json"), '{"type":"module"}\n');
  const sexprPath = join(buildDir, "sexpr.js");
  const referencePath = join(buildDir, "config-reference.js");
  compile(join(wakeRoot, "web", "compiler", "sexpr.bjs"), sexprPath);
  compile(join(wakeRoot, "web", "compiler", "config-reference.bjs"), referencePath);
  await appendExport(sexprPath, ["parse_all"]);
  await appendExport(referencePath, ["resolve_source_forms"]);
  ({ parse_all: parseAll } = await import(sexprPath));
  ({ resolve_source_forms: resolveSourceForms } = await import(referencePath));
});

afterAll(() => rmSync(buildDir, { recursive: true, force: true }));

function sourceValue(source) {
  return parseAll(source)[0].value;
}

test("configuration references resolve recursively before declaration parsing", () => {
  const forms = parseAll(`(entity (config entity)
    ((config fields.identity) : String))
  (query browse
    :params []
    :from [(item : (config entity))]
    :where []
    :select [(id (field item (config fields.identity)))]
    :result :page
    :page [default (config limits.default) max (config limits.max)])`);
  const references = new Map([
    ["entity", sourceValue("entry")],
    ["fields.identity", sourceValue("entry-id")],
    ["limits.default", 10],
    ["limits.max", 20],
  ]);
  const resolved = resolveSourceForms(forms, references);
  const entity = resolved[0].value;
  const query = resolved[1].value;
  assert.equal(entity[1].name, "entry");
  assert.equal(entity[2][0].name, "entry-id");
  assert.equal(query[5].items[0][2].name, "entry");
  assert.equal(query[9].items[0][1][2].name, "entry-id");
  assert.deepEqual(
    query[13].items.map(value => value?._tag === "Sym" ? value.name : value),
    ["default", 10, "max", 20],
  );
});

test("configuration references are closed and plugin-only", () => {
  const configured = parseAll("(entity (config missing))");
  assert.throws(
    () => resolveSourceForms(configured, new Map()),
    /unknown configuration reference 'missing'/,
  );
  assert.throws(
    () => resolveSourceForms(configured, null),
    /available only in a configured plugin source/,
  );
  assert.throws(
    () => resolveSourceForms(parseAll("(entity (config a b))"), new Map()),
    /must be \(config PATH\)/,
  );
  assert.throws(
    () => resolveSourceForms(parseAll("(entity (config \"a\"))"), new Map()),
    /PATH must be a dotted symbol/,
  );
});
