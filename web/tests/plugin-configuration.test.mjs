import { describe, expect, test } from "bun:test";
import {
  checkPluginConfiguration,
  configurationDeclarationIndex,
  configurationDeclarationDescriptors,
  validateConfigurationSchema,
} from "../compiler/plugin-configuration.mjs";

const sym = name => ({ _tag: "Sym", name });
const kw = name => ({ _tag: "Kw", name: `:${name}` });
const record = (...items) => ({ _tag: "SexprVec", items });

const schema = {
  enabled: { required: false, type: { kind: "boolean" } },
  entity: {
    required: true,
    type: {
      declarationId: "document",
      declarationKind: "entity",
      kind: "symbol",
    },
  },
  limits: {
    required: true,
    type: {
      closed: true,
      fields: [
        {
          name: "items",
          required: true,
          type: { kind: "integer", maximum: 247, minimum: 1 },
        },
        {
          name: "label",
          required: true,
          type: { kind: "string", maxBytes: 8, maxLength: 4, minLength: 1 },
        },
      ],
      kind: "record",
    },
  },
  state: { required: true, type: { kind: "keyword" } },
};

describe("checked plugin configuration", () => {
  test("validates, canonicalizes, and indexes typed reference paths", () => {
    expect(validateConfigurationSchema(schema)).toBe(schema);
    const checked = checkPluginConfiguration([
      { key: "entity", value: sym("entry") },
      {
        key: "limits",
        value: record(sym("label"), "界面", sym("items"), 20),
      },
      { key: "state", value: kw("draft") },
      { key: "enabled", value: sym("true") },
    ], schema, "use 'fixture'");

    expect(checked.canonical).toEqual({
      enabled: true,
      entity: { symbol: "entry" },
      limits: { items: 20, label: "界面" },
      state: { keyword: ":draft" },
    });
    expect(checked.references.get("entity")).toEqual(sym("entry"));
    expect(checked.references.get("limits.items")).toBe(20);
    expect(checked.references.get("limits.label")).toBe("界面");
    expect(checked.references.get("enabled")).toEqual(sym("true"));
    expect(checked.declarations).toEqual([{
      alias: "entry",
      declarationId: "document",
      declarationKind: "entity",
      path: "entity",
    }]);
    expect(configurationDeclarationDescriptors(schema)).toEqual([{
      declarationId: "document",
      declarationKind: "entity",
      path: "entity",
    }]);
    const declarations = configurationDeclarationIndex([
      ...checked.declarations,
      {
        alias: "entry-id",
        declarationId: "document/id",
        declarationKind: "field",
        path: "identity",
      },
    ]);
    expect(declarations.alias("entity", "document")).toBe("entry");
    expect(declarations.alias("entity", "external")).toBe("external");
    expect(declarations.declarationId("entity", "entry")).toBe("document");
    expect(declarations.declarationId("field", "entry-id", { ownerId: "document" }))
      .toBe("document/id");
    expect(declarations.declarationId("field", "title", { ownerId: "document" }))
      .toBe("document/title");
  });

  test("rejects malformed descriptors and contradictory bounds", () => {
    expect(() => validateConfigurationSchema({
      value: { required: true, type: { kind: "integer", minimum: 2, maximum: 1 } },
    })).toThrow("minimum must not exceed maximum");
    expect(() => validateConfigurationSchema({
      value: { required: true, type: { kind: "string", surprise: 1 } },
    })).toThrow("contains unknown key 'surprise'");
    expect(() => validateConfigurationSchema({
      value: { required: true, type: { kind: "record", closed: false, fields: [] } },
    })).toThrow("closed must be true");
    expect(() => validateConfigurationSchema({
      value: {
        required: true,
        type: {
          kind: "symbol",
          declarationKind: "capability",
          declarationId: "read",
        },
      },
    })).toThrow("supported only for entity, field, or state declarations");
    expect(() => validateConfigurationSchema({
      first: {
        required: true,
        type: { kind: "symbol", declarationKind: "entity", declarationId: "document" },
      },
      second: {
        required: true,
        type: { kind: "symbol", declarationKind: "entity", declarationId: "document" },
      },
    })).toThrow("repeats entity 'document'");
  });

  test("enforces recursive closed records, integer ceilings, and string bounds", () => {
    const base = [
      { key: "entity", value: sym("entry") },
      { key: "state", value: kw("draft") },
    ];
    expect(() => checkPluginConfiguration([
      ...base,
      { key: "limits", value: record(sym("items"), 248, sym("label"), "ok") },
    ], schema, "use 'fixture'")).toThrow("must be at most 247");
    expect(() => checkPluginConfiguration([
      ...base,
      { key: "limits", value: record(sym("items"), 20, sym("label"), "abcde") },
    ], schema, "use 'fixture'")).toThrow("exceeds 4 scalar values");
    expect(() => checkPluginConfiguration([
      ...base,
      { key: "limits", value: record(sym("items"), 20, sym("label"), "界界界") },
    ], schema, "use 'fixture'")).toThrow("exceeds 8 UTF-8 bytes");
    expect(() => checkPluginConfiguration([
      ...base,
      {
        key: "limits",
        value: record(sym("items"), 20, sym("label"), "ok", sym("extra"), 1),
      },
    ], schema, "use 'fixture'")).toThrow("limits'.extra is unknown");
  });

  test("rejects absent, unknown, and incorrectly typed roles", () => {
    expect(() => checkPluginConfiguration([], schema, "use 'fixture'"))
      .toThrow("requires configuration 'entity'");
    expect(() => checkPluginConfiguration([
      { key: "unknown", value: 1 },
    ], schema, "use 'fixture'")).toThrow("supplies unknown configuration 'unknown'");
    expect(() => checkPluginConfiguration([
      { key: "entity", value: "entry" },
      { key: "limits", value: record(sym("items"), 20, sym("label"), "ok") },
      { key: "state", value: kw("draft") },
    ], schema, "use 'fixture'")).toThrow("configuration 'entity' must be a symbol");
  });
});
