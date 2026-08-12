import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { compileCheckedValue } from "../runtime/checked-value.mjs";

const wakeRoot = join(import.meta.dir, "..", "..");
const beagleRoot = process.env.BEAGLE_ROOT ?? join(homedir(), "code", "beagle", "main");

let buildDir;
let parseAll;
let parseProviderPort;
let parseValueType;

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
  buildDir = mkdtempSync(join(tmpdir(), "wake-value-type-"));
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
  const valueTypePath = join(buildDir, "value-type.js");
  compile(join(wakeRoot, "web", "compiler", "sexpr.bjs"), sexprPath);
  compile(join(wakeRoot, "web", "compiler", "value-type.bjs"), valueTypePath);
  await appendExport(sexprPath, ["parse_all"]);
  await appendExport(valueTypePath, ["parse_provider_port", "parse_value_type"]);
  ({ parse_all: parseAll } = await import(sexprPath));
  ({
    parse_provider_port: parseProviderPort,
    parse_value_type: parseValueType,
  } = await import(valueTypePath));
});

afterAll(() => rmSync(buildDir, { force: true, recursive: true }));

function form(source) {
  return parseAll(source)[0].value;
}

test("parses a bounded closed tagged recursive value declaration", () => {
  const parsed = parseValueType(form(`(value-type SafeDocument
    :bounds [maxBytes 4096 maxDepth 16 maxNodes 128]
    :definitions [
      (SafeDocument (Record [
        (tag : (Literal "document"))
        (blocks : (List Block :max 128))]))
      (Block (Tagged tag [
        (paragraph [(inlines : (List Inline :max 128))])
        (heading [(level : (Enum [2 3 4]))
                  (inlines : (List Inline :max 128))])]))
      (Inline (Tagged tag [
        (text [(text : String)])
        (link [(href : SafeUrl)
               (inlines : (List Inline :max 128))])]))
      (SafeUrl (Tagged kind [
        (external [(href : (String :min 1))])
        (internal [(reference : (String :min 1))])]))]
    :root SafeDocument)`));
  assert.equal(parsed.name, "SafeDocument");
  assert.equal(parsed.descriptor.kind, "bounded");
  assert.deepEqual(
    [parsed.descriptor.maxBytes, parsed.descriptor.maxDepth, parsed.descriptor.maxNodes],
    [4096, 16, 128],
  );
  assert.equal(parsed.descriptor.definitions[1].value.kind, "tagged");
  assert.deepEqual(
    parsed.descriptor.definitions[1].value.variants.map(variant => variant.tag),
    ["paragraph", "heading"],
  );
  const checked = compileCheckedValue(parsed.descriptor);
  assert.deepEqual(checked.normalize({
    tag: "document",
    blocks: [{ tag: "paragraph", inlines: [{ tag: "text", text: "safe" }] }],
  }), {
    tag: "document",
    blocks: [{ tag: "paragraph", inlines: [{ tag: "text", text: "safe" }] }],
  });
});

test("parses exact provider input and named recursive output", () => {
  const parsed = parseProviderPort(form(`(provider-port content-parser
    :input (Record [
      (contentSource : String)
      (safeDocumentLimits : (Record [
        (maxBytes : (Integer :min 1 :max 1048576))
        (maxDepth : (Integer :min 3 :max 256))
        (maxNodes : (Integer :min 1 :max 65536))]))])
    :output SafeDocument)`));
  assert.equal(parsed.name, "content-parser");
  assert.equal(parsed.input.kind, "record");
  assert.deepEqual(parsed.input.fields.map(field => field.name), [
    "contentSource",
    "safeDocumentLimits",
  ]);
  assert.deepEqual(parsed.output, { kind: "ref", name: "SafeDocument" });
});

test("rejects unbounded lists, open records, repeated tags, and incomplete roots", () => {
  assert.throws(
    () => parseValueType(form(`(value-type Bad
      :bounds [maxBytes 10 maxDepth 2 maxNodes 2]
      :definitions [(Bad (List String))]
      :root Bad)`)),
    /List must be/,
  );
  assert.throws(
    () => parseValueType(form(`(value-type Bad
      :bounds [maxBytes 10 maxDepth 2 maxNodes 2]
      :definitions [(Bad (Record [] :open true))]
      :root Bad)`)),
    /Record requires one field vector/,
  );
  assert.throws(
    () => parseValueType(form(`(value-type Bad
      :bounds [maxBytes 10 maxDepth 2 maxNodes 2]
      :definitions [(Bad (Tagged tag [(same []) (same [])]))]
      :root Bad)`)),
    /repeats 'same'/,
  );
  assert.throws(
    () => parseValueType(form(`(value-type Bad
      :bounds [maxBytes 10 maxDepth 2 maxNodes 2]
      :definitions [(Known String)]
      :root Missing)`)),
    /root names unknown definition/,
  );
});
