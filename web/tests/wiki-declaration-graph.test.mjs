import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { toBeagleValue } from "../compiler/beagle-host-adapter.mjs";
import { afterAll, beforeAll, test } from "bun:test";
import {
  checkedDeclarationProgramFromBundle,
} from "../compiler/checked-declarations.mjs";
import { linkCheckedDeclarations } from "../compiler/declaration-linker.mjs";
import { packPlugin } from "../compiler/plugin-package.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");
const repositoryRoot = join(webRoot, "..");
const pluginRoot = join(webRoot, "plugins", "wiki");
const beagleRoot = process.env.BEAGLE_PROJECTION_ROOT
  ?? process.env.BEAGLE_ROOT
  ?? join(homedir(), "code", "beagle", "main");
const beagle = process.env.BEAGLE ?? join(beagleRoot, "bin", "beagle");
const beagleRuntime = process.env.BEAGLE_RUNTIME_DIR
  ?? join(beagleRoot, "beagle-lib", "lib", "beagle");
const compilerVersion = "0.1.0";
const sourcePaths = Object.freeze({
  plugin: join(pluginRoot, "plugin.bjs"),
  substrate: join(pluginRoot, "fixtures", "substrate", "substrate.bjs"),
  wakeCore: join(webRoot, "wake", "core.bjs"),
  wakeIr: join(webRoot, "wake", "ir.bjs"),
});
const sourceIds = Object.freeze({
  plugin: "plugin.bjs",
  substrate: "substrate.bjs",
  wakeCore: "web/wake/core.bjs",
  wakeIr: "web/wake/ir.bjs",
});
const sourceTexts = Object.freeze(Object.fromEntries(
  Object.entries(sourcePaths).map(([name, path]) => [
    sourceIds[name],
    readFileSync(path, "utf8"),
  ]),
));

function run(command, args, { cwd = repositoryRoot, env = process.env } = {}) {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    env,
    stderr: "pipe",
    stdout: "pipe",
  });
  assert.equal(
    result.exitCode,
    0,
    result.stderr.toString() || result.stdout.toString(),
  );
  return result.stdout.toString();
}

function suppliedSource(sourceId, authority) {
  return {
    authority,
    bytesBase64: Buffer.from(sourceTexts[sourceId]).toString("base64"),
    sourceId,
  };
}

function checkedBundle(entrySourceId, sources) {
  const result = Bun.spawnSync([beagle, "ast-bundle"], {
    cwd: repositoryRoot,
    stdin: Buffer.from(JSON.stringify({
      entrySourceId,
      kind: "beagle.checked-bundle.request",
      schemaVersion: 4,
      sources,
    })),
    stderr: "pipe",
    stdout: "pipe",
  });
  assert.equal(
    result.exitCode,
    0,
    result.stderr.toString() || result.stdout.toString(),
  );
  return JSON.parse(result.stdout.toString());
}

function checkedDeclarations(entrySourceId, wakeCoreModelBundle, wakeIrModelBundle) {
  const bundle = checkedBundle(entrySourceId, [
    suppliedSource(entrySourceId, "package"),
    suppliedSource(sourceIds.wakeCore, "trusted"),
  ]);
  const bundledSourceIds = new Set([
    ...bundle.modules.map((module) => module.sourceId),
    ...wakeCoreModelBundle.modules.map((module) => module.sourceId),
    ...wakeIrModelBundle.modules.map((module) => module.sourceId),
  ]);
  return checkedDeclarationProgramFromBundle(bundle, {
    compilerVersion,
    sourceTexts: Object.fromEntries(
      [...bundledSourceIds].map((sourceId) => [sourceId, sourceTexts[sourceId]]),
    ),
    wakeCoreModelBundle,
    wakeIrModelBundle,
  });
}

function appendFunctionExports(source) {
  const names = [...source.matchAll(/^function ([A-Za-z_$][\w$]*)/gmu)]
    .map((match) => match[1]);
  return `${source}\nexport { ${names.join(", ")} };\n`;
}

let buildDir;
let graph;

beforeAll(async () => {
  buildDir = mkdtempSync(join(tmpdir(), "wake-wiki-declaration-graph-"));
  const environment = {
    ...process.env,
    BEAGLE_JS_RUNTIME_PREFIX: "./beagle/",
  };
  for (const moduleName of ["ir", "graph"]) {
    const output = join(buildDir, `${moduleName}.js.tmp`);
    run(
      beagle,
      ["build", "--module-root", `web=${webRoot}`, join(webRoot, "wake", `${moduleName}.bjs`), output],
      { env: environment },
    );
  }

  writeFileSync(
    join(buildDir, "ir.js"),
    appendFunctionExports(readFileSync(join(buildDir, "ir.js.tmp"), "utf8")),
  );
  writeFileSync(
    join(buildDir, "graph.js"),
    appendFunctionExports(
      readFileSync(join(buildDir, "graph.js.tmp"), "utf8")
        .replace("from './wake/ir.js';", "from './ir.js';"),
    ),
  );
  writeFileSync(join(buildDir, "package.json"), '{"type":"module"}\n');
  mkdirSync(join(buildDir, "beagle"));
  for (const runtimeModule of readdirSync(beagleRuntime).filter((name) => name.endsWith(".js"))) {
    copyFileSync(
      join(beagleRuntime, runtimeModule),
      join(buildDir, "beagle", runtimeModule),
    );
  }
  const compiledGraph = await import(pathToFileURL(join(buildDir, "graph.js")).href);
  const { clj_to_js: cljToJs, js_to_clj: jsToClj } = await import(
    pathToFileURL(join(buildDir, "beagle", "host.js")).href
  );
  graph = {
    ...compiledGraph,
    check_linked_declaration_program: (value) =>
      cljToJs(compiledGraph.check_linked_declaration_program(toBeagleValue(value, jsToClj))),
  };
}, 30_000);

afterAll(() => {
  rmSync(buildDir, { force: true, recursive: true });
});

test("lowers the real wiki plugin and typed substrate into one checked graph", async () => {
  const wakeCoreModelBundle = checkedBundle(sourceIds.wakeCore, [
    suppliedSource(sourceIds.wakeCore, "trusted"),
  ]);
  const wakeIrModelBundle = checkedBundle(sourceIds.wakeIr, [
    suppliedSource(sourceIds.wakeIr, "trusted"),
  ]);
  const application = checkedDeclarations(
    sourceIds.substrate,
    wakeCoreModelBundle,
    wakeIrModelBundle,
  );
  const plugin = checkedDeclarations(
    sourceIds.plugin,
    wakeCoreModelBundle,
    wakeIrModelBundle,
  );
  const packed = await packPlugin(pluginRoot);
  const revision = run("git", ["rev-parse", "HEAD"]).trim();
  const linked = linkCheckedDeclarations({
    application,
    compilerVersion,
    plugins: [{
      artifact: packed.artifact,
      checked: plugin,
      lockEntry: {
        artifact: "wake-wiki.wakepkg.json",
        digest: packed.digest,
        packageId: "wake-wiki",
        source: { commit: revision, kind: "git" },
        version: "0.1.0",
      },
    }],
  });

  const checked = graph.check_linked_declaration_program(linked);
  const repeated = graph.check_linked_declaration_program(linked);
  assert.strictEqual(checked.linked_declarations, linked);
  assert.equal(checked.application_id, "wake-wiki-substrate-fixture");
  assert.equal(checked.plugin_closure.length, 1);
  assert.deepEqual(repeated.plugin_closure, checked.plugin_closure);
  assert.deepEqual(checked.plugin_closure[0], {
    alias: "wiki",
    artifact_digest: packed.digest,
    artifact_path: "wake-wiki.wakepkg.json",
    configuration_digest: linked.plugins[0].evidence.configuration_digest,
    durable_schema_version: 1,
    entry_path: "plugin.bjs",
    migration_ordinal: 0,
    package_id: "wake-wiki",
    source_kind: "git",
    source_revision: revision,
    version: "0.1.0",
  });

  assert.deepEqual(checked.entities.map((entity) => entity.name), [
    "member",
    "wiki.entry",
    "wiki.edition",
    "wake.core/command-receipt",
  ]);
  assert.equal(
    checked.entities.filter(
      (entity) => entity.storage_id === "wake/core/entity/command-receipt",
    ).length,
    1,
  );
  const edition = checked.entities.find((entity) => entity.name === "wiki.edition");
  assert.ok(edition);
  assert.equal(
    edition.fields.find((field) => field.name === "audience")?.storage_id,
    "wake-wiki-substrate-fixture/field/edition/audience",
  );
  const receipt = checked.entities.find(
    (entity) => entity.name === "wake.core/command-receipt",
  );
  assert.equal(
    receipt.fields.find((field) => field.name === "policy-digest")?.storage_id,
    "wake-wiki-substrate-fixture/field/receipt/policy-digest",
  );

  assert.deepEqual(
    checked.providers.map(({ name, package_id, port_name }) => ({
      name,
      package_id,
      port_name,
    })),
    [{ name: "plain-text", package_id: "wake-wiki", port_name: "content-parser" }],
  );
  assert.deepEqual(checked.mounts.map((mount) => mount.path), [
    "/library",
    "/library/new",
    "/library/:entry-id",
    "/library/:entry-id/edit",
    "/library/:entry-id/review",
    "/library/:entry-id/history",
  ]);
  assert.deepEqual(checked.queries.map((query) => query.name), [
    "wiki.browse-published",
    "wiki.read-published",
    "wiki.read-source-for-draft",
    "wiki.read-draft",
    "wiki.review",
    "wiki.history-current",
    "wiki.history-superseded",
    "wiki.backlinks",
  ]);
  assert.deepEqual(checked.commands.map((command) => command.name), [
    "wiki.create-resource-draft",
    "wiki.start-revision-draft",
    "wiki.replace-draft",
    "wiki.abandon-draft",
    "wiki.publish",
  ]);
}, 30_000);
