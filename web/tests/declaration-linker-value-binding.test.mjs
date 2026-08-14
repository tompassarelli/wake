import assert from "node:assert/strict";
import { beforeAll, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { checkedDeclarationProgramFromBundle } from "../compiler/checked-declarations.mjs";
import { linkCheckedDeclarations } from "../compiler/declaration-linker.mjs";

const webRoot = `${import.meta.dir}/..`;
const repositoryRoot = join(webRoot, "..");
const beagleRoot = process.env.BEAGLE_PROJECTION_ROOT
  ?? process.env.BEAGLE_ROOT
  ?? join(homedir(), "code", "beagle", "main");
const beagle = join(beagleRoot, "bin", "beagle");
const BEAGLE_PROCESS_TIMEOUT_MS = 40_000;
const BUNDLE_SETUP_TIMEOUT_MS = 60_000;
const sourceIds = Object.freeze({
  application: "web/tests/fixtures/macro-provenance/application.bjs",
  plugin: "web/tests/fixtures/macro-provenance/plugin.bjs",
  wakeCore: "web/wake/core.bjs",
  wakeIr: "web/compiler/ir.bjs",
});
const sourceTexts = Object.freeze(Object.fromEntries(
  Object.entries(sourceIds).map(([name, path]) => [name, readFileSync(join(repositoryRoot, path), "utf8")]),
));

function suppliedSource(sourceId, text, authority) {
  return { sourceId, bytesBase64: Buffer.from(text).toString("base64"), authority };
}

function checkedBundle(entrySourceId, sources) {
  const result = Bun.spawnSync([beagle, "ast-bundle"], {
    cwd: repositoryRoot,
    stdin: Buffer.from(JSON.stringify({
      kind: "beagle.checked-bundle.request",
      schemaVersion: 3,
      entrySourceId,
      sources,
    })),
    stdout: "pipe",
    stderr: "pipe",
    timeout: BEAGLE_PROCESS_TIMEOUT_MS,
  });
  assert.equal(result.exitCode, 0, result.stderr.toString());
  return JSON.parse(result.stdout.toString());
}

function sourceClosure(bundle, coreBundle, irBundle) {
  const available = {
    [sourceIds.application]: sourceTexts.application,
    [sourceIds.plugin]: sourceTexts.plugin,
    [sourceIds.wakeCore]: sourceTexts.wakeCore,
    [sourceIds.wakeIr]: sourceTexts.wakeIr,
  };
  return Object.fromEntries(
    [...new Set([...bundle.modules, ...coreBundle.modules, ...irBundle.modules]
      .map((module) => module.sourceId))]
      .map((sourceId) => [sourceId, available[sourceId]]),
  );
}

const literal = Object.freeze({
  boolean: (value) => ({ _tag: "IrLiteralBooleanValue", value }),
  integer: (value) => ({ _tag: "IrLiteralIntegerValue", value }),
  keyword: (value) => ({ _tag: "IrLiteralKeywordValue", value }),
  list: (items) => ({ _tag: "IrListValue", items }),
  nil: () => ({ _tag: "IrLiteralNilValue", unit: null }),
  record: (entries) => ({
    _tag: "IrRecordValue",
    fields: entries.map(([name, value]) => ({ _tag: "IrValueRecordEntry", name, value })),
  }),
  string: (value) => ({ _tag: "IrLiteralStringValue", value }),
});

const bound = Object.freeze({
  literal: (value) => ({ _tag: "IrLiteralBound", value }),
  role: (role) => ({ _tag: "IrConfiguredBound", role }),
  projection: (role, path) => ({
    _tag: "IrConfiguredProjectionBound",
    projection: { _tag: "IrConfigProjection", role, path },
  }),
});

const valueType = Object.freeze({
  boolean: () => ({ _tag: "IrBooleanValueType", unit: null }),
  digest: () => ({ _tag: "IrDigestValueType", unit: null }),
  entity: (entity) => ({ _tag: "IrEntityReferenceValueType", entity }),
  enum: (allowed) => ({ _tag: "IrEnumValueType", allowed }),
  instant: () => ({ _tag: "IrInstantValueType", unit: null }),
  integer: (minimum = null, maximum = null) => ({
    _tag: "IrIntegerValueType", minimum, maximum,
  }),
  keyword: (allowed) => ({ _tag: "IrKeywordValueType", allowed }),
  list: (item, minimumItems = null, maximumItems = null, normalization = null) => ({
    _tag: "IrListValueType",
    item,
    minimum_items: minimumItems,
    maximum_items: maximumItems,
    normalization,
  }),
  literal: (literalValue) => ({ _tag: "IrLiteralValueType", literal: literalValue }),
  named: (reference) => ({ _tag: "IrNamedValueType", value_type: reference }),
  nullable: (nested) => ({ _tag: "IrNullableValueType", value_type: nested }),
  record: (fields) => ({ _tag: "IrRecordValueType", fields }),
  state: (state) => ({ _tag: "IrStateValueType", state }),
  string: (minimumScalars = null, maximumScalars = null, maximumBytes = null) => ({
    _tag: "IrStringValueType",
    minimum_scalars: minimumScalars,
    maximum_scalars: maximumScalars,
    maximum_bytes: maximumBytes,
  }),
  tagged: (tagField, variants) => ({
    _tag: "IrTaggedValueType", tag_field: tagField, variants,
  }),
});

function field(name, type, required = true) {
  return { _tag: "IrValueRecordField", name, value_type: type, required };
}

function variant(tag, fields) {
  return { _tag: "IrValueTaggedVariant", tag, fields };
}

let baseApplication;
let basePlugin;

beforeAll(() => {
  const coreBundle = checkedBundle(sourceIds.wakeCore, [
    suppliedSource(sourceIds.wakeCore, sourceTexts.wakeCore, "trusted"),
  ]);
  const irBundle = checkedBundle(sourceIds.wakeIr, [
    suppliedSource(sourceIds.wakeIr, sourceTexts.wakeIr, "trusted"),
  ]);
  const decode = (name) => {
    const bundle = checkedBundle(sourceIds[name], [
      suppliedSource(sourceIds[name], sourceTexts[name], "package"),
      suppliedSource(sourceIds.wakeCore, sourceTexts.wakeCore, "trusted"),
    ]);
    return checkedDeclarationProgramFromBundle(bundle, {
      compilerVersion: "0.1.0",
      sourceTexts: sourceClosure(bundle, coreBundle, irBundle),
      wakeCoreModelBundle: coreBundle,
      wakeIrModelBundle: irBundle,
    });
  };
  baseApplication = decode("application");
  basePlugin = decode("plugin");
}, { timeout: BUNDLE_SETUP_TIMEOUT_MS });

function linkWith(change = () => {}) {
  const state = structuredClone({ application: baseApplication, plugin: basePlugin });
  change(state);
  const identity = state.plugin.program.root.plugin.identity;
  const manifest = {
    compatibleWake: "0.1.0",
    durableSchemaVersion: identity.durable_schema_version,
    entry: sourceIds.plugin,
    packageId: identity.package_id,
    pluginAbiVersion: identity.plugin_abi_version,
    schemaVersion: 1,
    sources: [sourceIds.plugin],
    version: identity.version,
  };
  return linkCheckedDeclarations({
    application: state.application,
    compilerVersion: "0.1.0",
    plugins: [{
      artifact: { files: [{ path: sourceIds.plugin }], manifest, schemaVersion: 1 },
      checked: state.plugin,
      lockEntry: {
        artifact: "macro-provenance.wakepkg.json",
        digest: `sha256:${"1".repeat(64)}`,
        packageId: identity.package_id,
        source: { commit: "2".repeat(40), kind: "git" },
        version: identity.version,
      },
    }],
  });
}

function replaceFirstValueRole(state, type, value) {
  state.plugin.program.root.plugin.configuration.values[0].value_type = type;
  state.application.program.root.application.plugins[0].use.bindings.values[0].value = value;
}

function removeReceipt(program) {
  program.receipt_entity = null;
  program.receipt_fields = [];
}

function removePluginCommands(program) {
  program.commands = [];
  program.root.plugin.exports.commands = [];
}

function comprehensiveValue(state) {
  const program = state.plugin.program;
  const configuration = program.root.plugin.configuration;
  const pageLimit = configuration.ints[0].ref;
  const contentLimits = configuration.values[1].ref;
  const entity = program.entities[0].ref;
  const stateRef = program.states[0].ref;
  const stateValue = program.states[0].values[0].value;
  const named = program.value_types[0];
  named.definitions[0].spec = valueType.record([
    field("payload", valueType.string(bound.literal(1), bound.literal(8), bound.literal(8))),
  ]);
  named.envelope = {
    _tag: "IrValueEnvelopeSpec",
    maximum_bytes: bound.projection(contentLimits, ["links"]),
    maximum_depth: bound.role(pageLimit),
    maximum_nodes: bound.projection(contentLimits, ["links"]),
  };

  return {
    type: valueType.record([
      field("string", valueType.string(bound.literal(1), bound.role(pageLimit),
        bound.projection(contentLimits, ["links"]))),
      field("integer", valueType.integer(bound.literal(-2), bound.literal(2))),
      field("boolean", valueType.boolean()),
      field("digest", valueType.digest()),
      field("instant", valueType.instant()),
      field("keyword", valueType.keyword(["working", "released"])),
      field("enum", valueType.enum([
        { _tag: "IrIntegerLiteral", value: 2 },
        { _tag: "IrStringLiteral", value: "two" },
      ])),
      field("entity", valueType.entity(entity)),
      field("state", valueType.state(stateRef)),
      field("record", valueType.record([
        field("required", valueType.integer()),
        field("optional", valueType.string(), false),
      ])),
      field("tagged", valueType.tagged("tag", [
        variant("alpha", [field("payload", valueType.integer())]),
        variant("empty", []),
      ])),
      field("list", valueType.list(
        valueType.string(),
        bound.literal(1),
        bound.literal(3),
        { _tag: "IrSortUniqueList", unit: null },
      )),
      field("nullable", valueType.nullable(valueType.string())),
      field("named", valueType.named(named.root)),
      field("literal", valueType.literal({ _tag: "IrStringLiteral", value: "fixed" })),
    ]),
    value: literal.record([
      ["string", literal.string("hello")],
      ["integer", literal.integer(2)],
      ["boolean", literal.boolean(true)],
      ["digest", literal.string(`sha256:${"a".repeat(64)}`)],
      ["instant", literal.record([
        ["epochSeconds", literal.integer(1_775_174_400)],
        ["nanos", literal.integer(123_000_000)],
      ])],
      ["keyword", literal.keyword("working")],
      ["enum", literal.integer(2)],
      ["entity", literal.string("article-1")],
      ["state", literal.keyword(stateValue)],
      ["record", literal.record([["required", literal.integer(1)]])],
      ["tagged", literal.record([
        ["tag", literal.string("alpha")],
        ["payload", literal.integer(1)],
      ])],
      ["list", literal.list([literal.string("a"), literal.string("b")])],
      ["nullable", literal.nil()],
      ["named", literal.record([["payload", literal.string("ok")]])],
      ["literal", literal.string("fixed")],
    ]),
  };
}

test("checks every closed value constructor recursively before linking", () => {
  const linked = linkWith((state) => {
    const { type, value } = comprehensiveValue(state);
    replaceFirstValueRole(state, type, value);
  });
  assert.equal(linked._tag, "IrLinkedDeclarationProgram");
  assert.equal(linked.plugins.length, 1);
});

test("rejects record, tagged, list, scalar, literal, and envelope violations", () => {
  const cases = [
    ["unknown record field", (value) => value.fields.push({
      _tag: "IrValueRecordEntry", name: "unknown", value: literal.nil(),
    }), /unknown field 'unknown'/u],
    ["missing record field", (value) => {
      value.fields = value.fields.filter((entry) => entry.name !== "boolean");
    }, /\.boolean is required/u],
    ["duplicate record field", (value) => value.fields.push(structuredClone(value.fields[0])),
      /repeats field 'string'/u],
    ["unknown tagged variant", (value) => {
      value.fields.find((entry) => entry.name === "tagged")
        .value.fields.find((entry) => entry.name === "tag").value.value = "unknown";
    }, /unknown tag 'unknown'/u],
    ["unsorted normalized list", (value) => {
      value.fields.find((entry) => entry.name === "list").value.items.reverse();
    }, /canonical sort-unique order/u],
    ["integer bound", (value) => {
      value.fields.find((entry) => entry.name === "integer").value.value = 3;
    }, /outside its integer bounds/u],
    ["string byte bound", (value) => {
      value.fields.find((entry) => entry.name === "string").value.value = "😀".repeat(20);
    }, /outside its string bounds/u],
    ["literal mismatch", (value) => {
      value.fields.find((entry) => entry.name === "literal").value.value = "changed";
    }, /does not match its exact literal/u],
    ["digest spelling", (value) => {
      value.fields.find((entry) => entry.name === "digest").value.value = "not-a-digest";
    }, /canonical sha256 digest/u],
    ["instant shape", (value) => {
      value.fields.find((entry) => entry.name === "instant").value.fields.pop();
    }, /exactly epochSeconds and nanos/u],
    ["instant nanos", (value) => {
      value.fields.find((entry) => entry.name === "instant").value.fields
        .find((entry) => entry.name === "nanos").value.value = 1_000_000_000;
    }, /outside the nanosecond range/u],
    ["envelope", (_value, state) => {
      state.plugin.program.value_types[0].envelope.maximum_nodes = bound.literal(1);
    }, /exceeds its 1-node envelope/u],
  ];

  for (const [name, mutate, expected] of cases) {
    assert.throws(
      () => linkWith((state) => {
        const { type, value } = comprehensiveValue(state);
        replaceFirstValueRole(state, type, value);
        mutate(value, state);
      }),
      expected,
      name,
    );
  }
});

test("accepts the canonical decoded macro-provenance bindings unchanged", () => {
  const linked = linkWith();
  assert.equal(linked.plugins[0].use.bindings.values.length, 2);
});

test("links receiptless commandless application and plugin programs", () => {
  const linked = linkWith((state) => {
    removeReceipt(state.application.program);
    removeReceipt(state.plugin.program);
    state.application.program.commands = [];
    removePluginCommands(state.plugin.program);
  });
  assert.equal(linked._tag, "IrLinkedDeclarationProgram");
  assert.equal(linked.plugins.length, 1);
});

test("adopts a plugin receipt core when the application has none", () => {
  const linked = linkWith((state) => {
    removeReceipt(state.application.program);
    state.application.program.commands = [];
  });
  assert.equal(linked._tag, "IrLinkedDeclarationProgram");
  assert.equal(linked.plugins.length, 1);
});

test("rejects a command-bearing plugin without a receipt core", () => {
  assert.throws(
    () => linkWith((state) => removeReceipt(state.plugin.program)),
    /checked source lacks the sealed command receipt entity/u,
  );
});

test("rejects a plugin receipt core that diverges from the application", () => {
  assert.throws(
    () => linkWith((state) => {
      state.plugin.program.receipt_entity.storage_id = "wake/core/entity/divergent-receipt";
    }),
    /checked source diverges from the linked command receipt core/u,
  );
});

test("requires exact nominal references and fails closed on unsupported constructors", () => {
  const cases = [
    ["entity reference", (type) => {
      type.fields.find((entry) => entry.name === "entity").value_type.entity =
        structuredClone(type.fields.find((entry) => entry.name === "entity").value_type.entity);
    }, /not an exact IrEntityRef reference/u],
    ["state reference", (type) => {
      type.fields.find((entry) => entry.name === "state").value_type.state =
        structuredClone(type.fields.find((entry) => entry.name === "state").value_type.state);
    }, /not an exact IrStateRef reference/u],
    ["named reference", (type) => {
      type.fields.find((entry) => entry.name === "named").value_type.value_type =
        structuredClone(type.fields.find((entry) => entry.name === "named").value_type.value_type);
    }, /non-exact value type reference/u],
    ["unsupported type", (type) => {
      type.fields.find((entry) => entry.name === "boolean").value_type = {
        _tag: "IrOpaqueValueType",
      };
    }, /unsupported value type 'IrOpaqueValueType'/u],
    ["unsupported value", (_type, value) => {
      value.fields.find((entry) => entry.name === "boolean").value = {
        _tag: "IrConfigValue",
      };
    }, /must be IrLiteralBooleanValue/u],
  ];

  for (const [name, mutate, expected] of cases) {
    assert.throws(
      () => linkWith((state) => {
        const { type, value } = comprehensiveValue(state);
        replaceFirstValueRole(state, type, value);
        mutate(type, value, state);
      }),
      expected,
      name,
    );
  }
});

test("forbids compile-time values for extension-owned types", () => {
  assert.throws(
    () => linkWith((state) => {
      const port = state.plugin.program.entity_fields_ports[0].ref;
      replaceFirstValueRole(
        state,
        { _tag: "IrExtensionValueType", port },
        literal.record([]),
      );
    }),
    /cannot bind an extension value at compile time/u,
  );
});
