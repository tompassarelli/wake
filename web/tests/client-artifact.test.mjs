import { describe, expect, test } from "bun:test";
import { generateWakeClient } from "../compiler/emit-client.mjs";

const fingerprint = `sha256:${"a".repeat(64)}`;

const field = (name, value) => ({ name, required: true, value });
const ref = name => ({ kind: "ref", name });
const safeDocumentDescriptor = Object.freeze({
  definitions: [{
    name: "Document",
    value: { fields: [
      field("tag", { kind: "literal", value: "document" }),
      field("blocks", { items: ref("Block"), kind: "list", maxItems: 8 }),
    ], kind: "record" },
  }, {
    name: "Block",
    value: { kind: "tagged", tag: "tag", variants: [
      { tag: "paragraph", fields: [field("inlines", {
        items: ref("Inline"), kind: "list", maxItems: 8,
      })] },
      { tag: "thematicBreak", fields: [] },
    ] },
  }, {
    name: "Inline",
    value: { kind: "tagged", tag: "tag", variants: [
      { tag: "text", fields: [field("text", { kind: "string" })] },
      { tag: "link", fields: [
        field("href", ref("SafeUrl")),
        field("inlines", { items: ref("Inline"), kind: "list", maxItems: 8 }),
      ] },
    ] },
  }, {
    name: "SafeUrl",
    value: { kind: "tagged", tag: "kind", variants: [
      { tag: "external", fields: [field("href", { kind: "string", minLength: 1 })] },
      { tag: "internal", fields: [field("reference", { kind: "string", minLength: 1 })] },
    ] },
  }],
  kind: "bounded",
  maxBytes: 256,
  maxDepth: 8,
  maxNodes: 32,
  value: ref("Document"),
});

const identity = Object.freeze({
  name: "id",
  type: "String",
  value_kind: "literal",
});

const checked = Object.freeze({
  application_id: "greywrought-wiki",
  commands: [{
    capabilities: [{ capability: "edit" }],
    input: [{
      name: "body",
      required: true,
      type: { kind: "string", maxBytes: 8, maxLength: 2, minLength: 1 },
    }, {
      name: "meta",
      required: true,
      type: {
        fields: [{
          name: "tags",
          required: true,
          type: { items: { kind: "keyword" }, kind: "list", maxItems: 2 },
        }, {
          name: "note",
          required: false,
          type: { kind: "nullable", value: { kind: "string" } },
        }],
        kind: "record",
      },
    }],
    name: "__proto__",
    normalizerVersion: 1,
    result: [{ name: "count", type: { kind: "integer" } }],
  }],
  defstates: [{
    name: "Phase",
    transitions: { draft: ["published"], published: [] },
  }],
  entities: [{ identity_field: identity, name: "resource" }],
  queries: [{
    capabilities: ["read"],
    columns: [{
      cardinality: "single",
      name: "__proto__",
      type: "String",
      value_kind: "literal",
    }, {
      cardinality: "single",
      internal: true,
      name: "wake$provided$0$0",
      type: "String",
      value_kind: "literal",
    }, {
      cardinality: "single",
      name: "owner",
      target_entity: "resource",
      type: "Ref",
      value_kind: "ref",
    }, {
      cardinality: "single",
      name: "phase",
      type: "Phase",
      value_kind: "literal",
    }, {
      cardinality: "multi",
      name: "tags",
      type: "String",
      value_kind: "literal",
    }],
    name: "constructor",
    params: [{ name: "__proto__", type: "Integer" }, {
      name: "phase",
      type: "Phase",
    }, {
      name: "at",
      type: "Instant",
    }],
    result_kind: "optional",
    result_providers: [{
      input: { kind: "column", name: "wake$provided$0$0" },
      input_type: { kind: "string" },
      name: "safe-document",
      output_type: safeDocumentDescriptor,
      provider: "content-parser",
    }],
  }],
  semantic_fingerprint: fingerprint,
  value_types: [{ descriptor: safeDocumentDescriptor, name: "SafeDocument" }],
});

function ownRecord(entries) {
  const result = Object.create(null);
  for (const [name, value] of entries) {
    Object.defineProperty(result, name, { enumerable: true, value });
  }
  return result;
}

class FakeNode {
  constructor(kind, name = null) {
    this.attributes = Object.create(null);
    this.children = [];
    this.className = "";
    this.kind = kind;
    this.name = name;
    this.textContent = "";
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
}

class FakeDocument {
  constructor() {
    this.baseURI = "https://wiki.test/base";
  }

  createDocumentFragment() {
    return new FakeNode("fragment");
  }

  createElement(name) {
    return new FakeNode("element", name);
  }

  createTextNode(value) {
    const node = new FakeNode("text");
    node.textContent = value;
    return node;
  }
}

async function generatedClient(value = checked) {
  const path = `/tmp/wake-client-artifact-${crypto.randomUUID()}.mjs`;
  await Bun.write(path, generateWakeClient(value));
  try {
    const built = await Bun.build({ entrypoints: [path], target: "browser", write: false });
    return {
      built,
      client: await import(path),
      source: await Bun.file(path).text(),
    };
  } finally {
    await Bun.file(path).delete();
  }
}

describe("generated browser client artifact", () => {
  test("is a pure, deeply frozen, prototype-safe operation contract", async () => {
    const { built, client, source } = await generatedClient();
    expect(built.success, built.logs.join("\n")).toBe(true);
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("/api/");
    expect(source).not.toContain("globalThis.document.");
    expect(source).not.toContain("location.");
    expect(source).not.toContain("setTimeout");
    expect(source).not.toContain("setInterval");
    expect(client.semanticFingerprint).toBe(fingerprint);
    expect(client.applicationId).toBe("greywrought-wiki");
    expect(Object.isFrozen(client.operations)).toBe(true);
    expect(Object.isFrozen(client.operations.queries)).toBe(true);
    expect(Object.isFrozen(client.operations.queries[0].result.columns[1].value)).toBe(true);
    expect(client.queryDescriptor("constructor").name).toBe("constructor");
    expect(client.queryDescriptor("constructor").capabilities).toEqual(["read"]);
    expect(client.commandDescriptor("__proto__").name).toBe("__proto__");
    expect(() => client.queryDescriptor("toString")).toThrow("unknown checked query");
    expect(client.queryDescriptor("constructor").result.columns[1].value).toEqual({
      entity: "resource",
      kind: "reference",
      value: { kind: "string" },
    });
    expect(client.queryDescriptor("constructor").result.columns[2].value).toEqual({
      kind: "keyword",
      values: ["draft", "published"],
    });
    expect(client.queryDescriptor("constructor").result.columns.some(
      column => column.name === "wake$provided$0$0",
    )).toBe(false);
    expect(client.queryDescriptor("constructor").result.columns.at(-1)).toMatchObject({
      cardinality: "single",
      name: "safe-document",
      value: { kind: "bounded" },
    });
  });

  test("normalizes exact query values without returning caller-owned objects", async () => {
    const { client } = await generatedClient();
    const input = ownRecord([
      ["__proto__", 42n],
      ["phase", "draft"],
      ["at", { epochSeconds: -1, nanos: "999999999" }],
    ]);
    const normalized = client.normalizeQueryInput("constructor", input);
    expect(Object.getPrototypeOf(normalized)).toBe(null);
    expect(Object.hasOwn(normalized, "__proto__")).toBe(true);
    expect(normalized.__proto__).toBe("42");
    expect(normalized.at).toEqual({ epochSeconds: "-1", nanos: 999999999 });
    expect(normalized).not.toBe(input);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.at)).toBe(true);

    const row = ownRecord([
      ["__proto__", "resource-1"],
      ["owner", "owner-1"],
      ["phase", "published"],
      ["tags", ["one", "two"]],
      ["safe-document", { tag: "document", blocks: [] }],
    ]);
    const result = client.normalizeQueryResult("constructor", row);
    expect(result.owner).toBe("owner-1");
    expect(result.phase).toBe("published");
    expect(result.tags).toEqual(["one", "two"]);
    expect(result.tags).not.toBe(row.tags);
    expect(Object.isFrozen(result.tags)).toBe(true);
    expect(result["safe-document"]).toEqual({ tag: "document", blocks: [] });
    expect(result["safe-document"]).not.toBe(row["safe-document"]);
    expect(Object.isFrozen(result["safe-document"])).toBe(true);
    expect(client.normalizeQueryResult("constructor", null)).toBe(null);
  });

  test("rejects accessors, hidden/symbol extras, sparse arrays, and invalid scalars", async () => {
    const { client } = await generatedClient();
    let getterCalls = 0;
    const accessor = ownRecord([
      ["phase", "draft"],
      ["at", { epochSeconds: 0, nanos: 0 }],
    ]);
    Object.defineProperty(accessor, "__proto__", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      },
    });
    expect(() => client.normalizeQueryInput("constructor", accessor))
      .toThrow("must be an enumerable data property");
    expect(getterCalls).toBe(0);

    const hidden = ownRecord([
      ["__proto__", 1],
      ["phase", "draft"],
      ["at", { epochSeconds: 0, nanos: 0 }],
    ]);
    Object.defineProperty(hidden, "hidden", { value: true });
    expect(() => client.normalizeQueryInput("constructor", hidden))
      .toThrow("unsupported property hidden");
    const symbol = ownRecord([
      ["__proto__", 1],
      ["phase", "draft"],
      ["at", { epochSeconds: 0, nanos: 0 }],
      [Symbol("extra"), true],
    ]);
    expect(() => client.normalizeQueryInput("constructor", symbol))
      .toThrow("unsupported property Symbol(extra)");

    for (const invalid of [-0, "01", "9223372036854775808", "-9223372036854775809"]) {
      const value = ownRecord([
        ["__proto__", invalid],
        ["phase", "draft"],
        ["at", { epochSeconds: 0, nanos: 0 }],
      ]);
      expect(() => client.normalizeQueryInput("constructor", value)).toThrow();
    }
    for (const invalid of ["unknown", "", 1]) {
      const value = ownRecord([
        ["__proto__", 1],
        ["phase", invalid],
        ["at", { epochSeconds: 0, nanos: 0 }],
      ]);
      expect(() => client.normalizeQueryInput("constructor", value)).toThrow();
    }
    for (const invalid of [
      { epochSeconds: 0, nanos: -1 },
      { epochSeconds: 0, nanos: 1_000_000_000 },
      { epochSeconds: 0, nanos: 0, extra: true },
      new Date(0),
    ]) {
      const value = ownRecord([
        ["__proto__", 1],
        ["phase", "draft"],
        ["at", invalid],
      ]);
      expect(() => client.normalizeQueryInput("constructor", value)).toThrow();
    }

    const sparse = ownRecord([
      ["__proto__", "resource-1"],
      ["owner", "owner-1"],
      ["phase", "draft"],
      ["tags", new Array(1)],
    ]);
    expect(() => client.normalizeQueryResult("constructor", sparse)).toThrow("must be dense");
  });

  test("normalizes recursive command values and enforces declared bounds", async () => {
    const { client } = await generatedClient();
    const input = {
      body: "😀a",
      meta: { tags: ["first", "second"] },
    };
    const normalized = client.normalizeCommandInput("__proto__", input);
    expect(normalized).toEqual(input);
    expect(normalized).not.toBe(input);
    expect(normalized.meta).not.toBe(input.meta);
    expect(normalized.meta.tags).not.toBe(input.meta.tags);
    expect(Object.isFrozen(normalized.meta.tags)).toBe(true);
    expect(client.normalizeCommandResult("__proto__", { count: 7 })).toEqual({ count: "7" });
    expect(() => client.normalizeCommandInput("__proto__", {
      body: "😀ab",
      meta: { tags: [] },
    })).toThrow("longer than 2 scalars");
    expect(() => client.normalizeCommandInput("__proto__", {
      body: "ok",
      meta: { tags: ["one", "two", "three"] },
    })).toThrow("exceeds 2 items");
    expect(() => client.normalizeCommandInput("__proto__", {
      body: "\ud800",
      meta: { tags: [] },
    })).toThrow("unpaired surrogate");
  });

  test("exports a closed SafeDocument codec and exhaustive DOM-only renderer", async () => {
    const { client, source } = await generatedClient();
    expect(Object.isFrozen(client.safeDocumentDescriptor)).toBe(true);
    const value = {
      tag: "document",
      blocks: [{
        tag: "paragraph",
        inlines: [{ tag: "text", text: "safe" }, {
          tag: "link",
          href: { kind: "internal", reference: "entry:one" },
          inlines: [{ tag: "text", text: "inside" }],
        }],
      }, { tag: "thematicBreak" }],
    };
    const normalized = client.normalizeSafeDocument(value);
    expect(Object.getPrototypeOf(normalized)).toBe(null);
    expect(Object.isFrozen(normalized.blocks)).toBe(true);
    const fragment = client.renderSafeDocument(value, {
      document: new FakeDocument(),
      resolveSafeUrl(url) {
        expect(url).toEqual({ kind: "internal", reference: "entry:one" });
        return { kind: "canonical", href: "/entry/one" };
      },
    });
    expect(fragment.children.map(node => node.name)).toEqual(["p", "hr"]);
    expect(fragment.children[0].children[0].children[1].attributes.href).toBe("/entry/one");
    expect(() => client.normalizeSafeDocument({ ...value, html: "<b>bad</b>" }))
      .toThrow("unsupported property html");
    expect(source).not.toContain("innerHTML");
    expect(source).not.toContain("DOMParser");
  });

  test("fails generation for unknown query types and unresolved references", () => {
    const unknown = structuredClone(checked);
    unknown.queries[0].params[0].type = "Opaque";
    expect(() => generateWakeClient(unknown)).toThrow("unsupported type 'Opaque'");

    const unresolved = structuredClone(checked);
    unresolved.queries[0].columns.find(column => column.name === "owner").target_entity = "missing";
    expect(() => generateWakeClient(unresolved)).toThrow("without a checked identity");
  });
});
