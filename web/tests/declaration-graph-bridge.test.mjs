import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "bun:test";
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

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");
const beagleRoot = process.env.BEAGLE_ROOT
  ?? join(homedir(), "code", "beagle", "main");
const beagle = process.env.BEAGLE ?? join(beagleRoot, "bin", "beagle");
const beagleRuntime = process.env.BEAGLE_RUNTIME_DIR
  ?? join(beagleRoot, "beagle-lib", "lib", "beagle");

function spawnSync(command, args, { cwd, env = process.env } = {}) {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function appendFunctionExports(source) {
  const names = [...source.matchAll(/^function ([A-Za-z_$][\w$]*)/gmu)]
    .map((match) => match[1]);
  return `${source}\nexport { ${names.join(", ")} };\n`;
}

function ref(tag, declarationId, name) {
  return {
    _tag: tag,
    declaration_id: declarationId,
    name,
    provenance_token: `wake:test:${declarationId}`,
  };
}

function receiptCore() {
  const entityRef = ref(
    "IrReceiptEntityRef",
    "wake.core/command-receipt",
    "wake.core/command-receipt",
  );
  const field = (name, valueType) => ({
    _tag: "IrReceiptFieldDeclarationSpec",
    ref: ref(
      "IrReceiptFieldRef",
      `wake.core/command-receipt/${name}`,
      name,
    ),
    owner: entityRef,
    value_type: valueType,
    target: null,
    storage_id: `wake/core/field/command-receipt/${name}`,
  });
  return {
    entity: {
      _tag: "IrReceiptEntitySpec",
      ref: entityRef,
      storage_id: "wake/core/entity/command-receipt",
    },
    fields: [
      field("id", { _tag: "IrDigestValueType", unit: null }),
      field("actor", {
        _tag: "IrStringValueType",
        minimum_scalars: null,
        maximum_scalars: null,
        maximum_bytes: null,
      }),
      field("command", {
        _tag: "IrStringValueType",
        minimum_scalars: null,
        maximum_scalars: null,
        maximum_bytes: null,
      }),
      field("input-digest", { _tag: "IrDigestValueType", unit: null }),
      field("created-at", { _tag: "IrInstantValueType", unit: null }),
    ],
  };
}

function linkedApplication({ titleValueTypeTag = "IrStringField" } = {}) {
  const sourceUnit = {
    _tag: "IrSourceUnit",
    source_id: "wake:test:declaration-graph-bridge",
    path: "web/tests/declaration-graph-bridge.test.mjs",
    package_id: "",
    package_version: "",
  };
  const pageRef = ref("IrEntityRef", "test/entity/page", "page");
  const idRef = ref("IrFieldRef", "test/entity/page/field/id", "id");
  const titleRef = ref("IrFieldRef", "test/entity/page/field/title", "title");
  const documentRef = ref(
    "IrValueTypeRef",
    "test/value-type/document",
    "Document",
  );
  const receipt = receiptCore();
  const application = {
    _tag: "IrCheckedDeclarationProgram",
    program: {
      _tag: "IrDeclarationProgram",
      source_unit: sourceUnit,
      ns: "wake.tests.declaration-graph-bridge",
      root: {
        _tag: "IrApplicationDeclarationRoot",
        application: {
          _tag: "IrApplicationRootSpec",
          id: "bridge-fixture",
          authority: { _tag: "IrStoreAuthority", service: "store" },
          storage: [{
            _tag: "IrStorageSpec",
            entity: pageRef,
            storage_id: "bridge/page",
          }],
          identities: [{
            _tag: "IrIdentitySpec",
            entity: pageRef,
            field: idRef,
          }],
          plugins: [],
          default_route: null,
          theme: null,
          publications: [],
          forms: [],
          list_details: [],
        },
      },
      entities: [{
        _tag: "IrEntityDeclarationSpec",
        ref: pageRef,
        record_name: "Page",
        fields: [
          {
            _tag: "IrFieldSpec",
            ref: idRef,
            owner: pageRef,
            value_type: { _tag: "IrStringField", unit: null },
            cardinality: { _tag: "IrSingleField", unit: null },
            write: { _tag: "IrIdentityWrite", unit: null },
            storage_id: "bridge/page/id",
            required: true,
          },
          {
            _tag: "IrFieldSpec",
            ref: titleRef,
            owner: pageRef,
            value_type: { _tag: titleValueTypeTag, unit: null },
            cardinality: { _tag: "IrSingleField", unit: null },
            write: { _tag: "IrCreateWrite", unit: null },
            storage_id: "bridge/page/title",
            required: true,
          },
        ],
        derived_fields: [],
        storage_id: "bridge/page",
      }],
      states: [],
      publications: [],
      forms: [],
      list_details: [],
      value_types: [{
        _tag: "IrValueTypeDeclarationSpec",
        root: documentRef,
        definitions: [{
          _tag: "IrValueTypeDefinition",
          ref: documentRef,
          spec: {
            _tag: "IrRecordValueType",
            fields: [{
              _tag: "IrValueRecordField",
              name: "title",
              value_type: {
                _tag: "IrStringValueType",
                minimum_scalars: null,
                maximum_scalars: null,
                maximum_bytes: null,
              },
              required: true,
            }],
          },
        }],
        envelope: {
          _tag: "IrValueEnvelopeSpec",
          maximum_bytes: { _tag: "IrLiteralBound", value: 1024 },
          maximum_depth: { _tag: "IrLiteralBound", value: 4 },
          maximum_nodes: { _tag: "IrLiteralBound", value: 16 },
        },
      }],
      provider_ports: [],
      renderers: [],
      capabilities: [],
      queries: [],
      commands: [],
      components: [],
      views: [],
      route_templates: [],
      entity_fields_ports: [],
      component_slots: [],
      route_slots: [],
      receipt_entity: receipt.entity,
      receipt_fields: receipt.fields,
    },
    declaration_provenance: [],
  };
  const linked = {
    _tag: "IrLinkedDeclarationProgram",
    application,
    plugins: [],
  };
  return { linked, sourceUnit };
}

let buildDir;
let graph;

beforeAll(async () => {
  buildDir = mkdtempSync(join(tmpdir(), "wake-declaration-graph-bridge-"));
  const environment = {
    ...process.env,
    BEAGLE_JS_RUNTIME_PREFIX: "./beagle/",
  };
  for (const moduleName of ["ir", "graph"]) {
    const output = join(buildDir, `${moduleName}.js.tmp`);
    const built = spawnSync(
      beagle,
      ["build", "--module-root", `web=${webRoot}`, join(webRoot, "wake", `${moduleName}.bjs`), output],
      { cwd: join(webRoot, ".."), env: environment },
    );
    assert.equal(built.status, 0, built.stderr || built.stdout);
  }

  const compiledIr = readFileSync(join(buildDir, "ir.js.tmp"), "utf8");
  writeFileSync(join(buildDir, "ir.js"), appendFunctionExports(compiledIr));

  const compiledGraph = readFileSync(join(buildDir, "graph.js.tmp"), "utf8")
    .replace("from './wake/ir.js';", "from './ir.js';");
  writeFileSync(join(buildDir, "graph.js"), appendFunctionExports(compiledGraph));
  writeFileSync(join(buildDir, "package.json"), '{"type":"module"}\n');
  mkdirSync(join(buildDir, "beagle"));
  for (const runtimeModule of readdirSync(beagleRuntime).filter((name) => name.endsWith(".js"))) {
    copyFileSync(
      join(beagleRuntime, runtimeModule),
      join(buildDir, "beagle", runtimeModule),
    );
  }

  const graphModule = await import(pathToFileURL(join(buildDir, "graph.js")).href);
  const { clj_to_js: cljToJs, js_to_clj: jsToClj } = await import(
    pathToFileURL(join(buildDir, "beagle", "host.js")).href
  );
  graph = {
    ...graphModule,
    check_linked_declaration_program: (value) =>
      cljToJs(graphModule.check_linked_declaration_program(jsToClj(value))),
  };
}, 30_000);

afterAll(() => {
  rmSync(buildDir, { force: true, recursive: true });
});

test("lowers an exact linked declaration program without erasing its typed sidecar", () => {
  assert.equal(typeof graph.check_linked_declaration_program, "function");

  const { linked, sourceUnit } = linkedApplication();
  const checked = graph.check_linked_declaration_program(linked);

  assert.equal(checked._tag, "CheckedApplication");
  assert.equal(checked.application_id, "bridge-fixture");
  assert.deepEqual(checked.linked_declarations, linked);
  assert.deepEqual(checked.source_units, [sourceUnit]);
  assert.equal(checked.backend.kind, "store");
  assert.deepEqual(checked.value_types, [{
    name: "Document",
    descriptor: {
      kind: "bounded",
      definitions: [{
        name: "Document",
        value: {
          kind: "record",
          fields: [{
            name: "title",
            required: true,
            value: { kind: "string" },
          }],
        },
      }],
      maxBytes: 1024,
      maxDepth: 4,
      maxNodes: 16,
      value: { kind: "ref", name: "Document" },
    },
  }]);

  const page = checked.entities.find((entity) => entity.name === "page");
  assert.ok(page, "direct lowering must retain the typed page entity");
  assert.equal(page.storage_id, "bridge/page");
  assert.deepEqual(page.fields.map((field) => field.name), ["id", "title"]);
  assert.equal(page.identity_field.name, "id");
  assert.equal(page.identity_field.storage_id, "bridge/page/id");
  assert.equal(page.identity_field.identity, true);
  assert.equal(page.identity_field.write_policy, "set");
  assert.equal(page.fields[1].storage_id, "bridge/page/title");
  assert.equal(page.fields[1].type, "String");
  assert.equal(page.fields[1].write_policy, "create");
});

test("fails closed on an unsupported typed declaration constructor", () => {
  const { linked } = linkedApplication({ titleValueTypeTag: "IrOpaqueField" });
  assert.throws(
    () => graph.check_linked_declaration_program(linked),
    /IrOpaqueField/u,
  );
});
