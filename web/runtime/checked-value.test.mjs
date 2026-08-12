import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  CheckedValueError,
  compileCheckedValue,
  safeUrlDescriptor,
} from "./checked-value.mjs";

const ref = name => ({ kind: "ref", name });
const field = (name, value, required = true) => ({ name, required, value });

const recursiveDocument = {
  definitions: [{
    name: "Document",
    value: {
      fields: [field("tag", { kind: "literal", value: "document" }), field("blocks", {
        items: ref("Block"),
        kind: "list",
        maxItems: 8,
      })],
      kind: "record",
    },
  }, {
    name: "Block",
    value: {
      kind: "tagged",
      tag: "tag",
      variants: [{
        fields: [field("inlines", { items: ref("Inline"), kind: "list", maxItems: 8 })],
        tag: "paragraph",
      }, {
        fields: [field("blocks", { items: ref("Block"), kind: "list", maxItems: 8 })],
        tag: "blockQuote",
      }],
    },
  }, {
    name: "Inline",
    value: {
      kind: "tagged",
      tag: "tag",
      variants: [{
        fields: [field("text", { kind: "string" })],
        tag: "text",
      }, {
        fields: [field("href", ref("SafeUrl")), field("inlines", {
          items: ref("Inline"),
          kind: "list",
          maxItems: 8,
        })],
        tag: "link",
      }],
    },
  }, {
    name: "SafeUrl",
    value: safeUrlDescriptor,
  }],
  kind: "bounded",
  maxBytes: 256,
  maxDepth: 8,
  maxNodes: 16,
  value: ref("Document"),
};

function ownRecord(entries) {
  const result = Object.create(null);
  for (const [name, value] of entries) {
    Object.defineProperty(result, name, { enumerable: true, value });
  }
  return result;
}

test("normalizes a closed recursive tagged value into frozen inert data", () => {
  const checked = compileCheckedValue(recursiveDocument);
  const source = {
    tag: "document",
    blocks: [{
      tag: "paragraph",
      inlines: [{ tag: "text", text: "hello" }, {
        tag: "link",
        href: { kind: "internal", reference: "entry:one" },
        inlines: [{ tag: "text", text: "one" }],
      }],
    }],
  };
  const normalized = checked.normalize(source, { label: "safeDocument" });
  assert.deepEqual(normalized, source);
  assert.notEqual(normalized, source);
  assert.equal(Object.getPrototypeOf(normalized), null);
  assert.equal(Object.getPrototypeOf(normalized.blocks[0]), null);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.blocks), true);
  assert.equal(Object.isFrozen(normalized.blocks[0].inlines[1].href), true);
});

test("rejects unknown tags, unknown keys, bare URLs, sparse arrays, and accessors", () => {
  const checked = compileCheckedValue(recursiveDocument);
  assert.throws(
    () => checked.normalize({ tag: "document", blocks: [{ tag: "html" }] }),
    /tag 'html' is unknown/,
  );
  assert.throws(
    () => checked.normalize({ tag: "document", blocks: [], html: "<script>" }),
    /unsupported property html/,
  );
  assert.throws(
    () => checked.normalize({
      tag: "document",
      blocks: [{
        tag: "paragraph",
        inlines: [{ tag: "link", href: "javascript:alert(1)", inlines: [] }],
      }],
    }),
    /must be a plain object/,
  );
  const sparse = { tag: "document", blocks: new Array(1) };
  assert.throws(() => checked.normalize(sparse), /must be dense/);

  let getterCalls = 0;
  const hostile = ownRecord([["blocks", []]]);
  Object.defineProperty(hostile, "tag", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "document";
    },
  });
  assert.throws(() => checked.normalize(hostile), /enumerable data property/);
  assert.equal(getterCalls, 0);
});

test("enforces aggregate byte, record-node, and semantic record-depth envelopes", () => {
  const byteBound = structuredClone(recursiveDocument);
  byteBound.maxBytes = 20;
  assert.throws(
    () => compileCheckedValue(byteBound).normalize({
      tag: "document",
      blocks: [{ tag: "paragraph", inlines: [{ tag: "text", text: "too much text" }] }],
    }),
    /aggregate UTF-8 bytes/,
  );

  const nodeBound = structuredClone(recursiveDocument);
  nodeBound.maxNodes = 2;
  assert.throws(
    () => compileCheckedValue(nodeBound).normalize({
      tag: "document",
      blocks: [{ tag: "paragraph", inlines: [{ tag: "text", text: "third" }] }],
    }),
    /record nodes/,
  );

  const depthBound = structuredClone(recursiveDocument);
  depthBound.maxDepth = 2;
  assert.throws(
    () => compileCheckedValue(depthBound).normalize({
      tag: "document",
      blocks: [{ tag: "paragraph", inlines: [{ tag: "text", text: "third" }] }],
    }),
    /record depth 2/,
  );
});

test("rejects cycles and malformed or unguarded recursive descriptors", () => {
  const checked = compileCheckedValue(recursiveDocument);
  const cyclic = { tag: "blockQuote", blocks: [] };
  cyclic.blocks.push(cyclic);
  assert.throws(
    () => checked.normalize({ tag: "document", blocks: [cyclic] }),
    /must not be cyclic/,
  );
  assert.throws(
    () => compileCheckedValue({
      definitions: [{ name: "A", value: ref("B") }, { name: "B", value: ref("A") }],
      kind: "bounded",
      maxBytes: 32,
      maxDepth: 4,
      maxNodes: 4,
      value: ref("A"),
    }).normalize({}),
    /unguarded recursive type/,
  );
  assert.throws(
    () => compileCheckedValue({ ...recursiveDocument, value: ref("Missing") }),
    /unknown type 'Missing'/,
  );
});

test("SafeUrl is a closed tagged value rather than a string alias", () => {
  const bounded = {
    definitions: [{ name: "SafeUrl", value: safeUrlDescriptor }],
    kind: "bounded",
    maxBytes: 128,
    maxDepth: 2,
    maxNodes: 2,
    value: ref("SafeUrl"),
  };
  const checked = compileCheckedValue(bounded);
  assert.deepEqual(checked.normalize({ kind: "external", href: "https://example.test/" }), {
    kind: "external",
    href: "https://example.test/",
  });
  assert.deepEqual(checked.normalize({ kind: "internal", reference: "entry:one" }), {
    kind: "internal",
    reference: "entry:one",
  });
  assert.throws(() => checked.normalize("https://example.test/"), /plain object/);
  assert.throws(
    () => checked.normalize({ kind: "external", href: "https://example.test/", target: "_blank" }),
    /unsupported property target/,
  );
});

test("integer and enum descriptors preserve exact JSON scalars", () => {
  const descriptor = {
    definitions: [{
      name: "Heading",
      value: {
        fields: [field("level", { kind: "enum", values: [2, 3, 4] }), field("count", {
          kind: "integer",
          maximum: 8,
          minimum: 0,
        })],
        kind: "record",
      },
    }],
    kind: "bounded",
    maxBytes: 32,
    maxDepth: 2,
    maxNodes: 2,
    value: ref("Heading"),
  };
  const checked = compileCheckedValue(descriptor);
  assert.deepEqual(checked.normalize({ level: 3, count: 8 }), { level: 3, count: 8 });
  assert.throws(() => checked.normalize({ level: 1, count: 8 }), /not an allowed value/);
  assert.throws(() => checked.normalize({ level: 3, count: 9 }), /at most 8/);
  assert.throws(
    () => checked.normalize({ level: 3, count: "8" }),
    error => error instanceof CheckedValueError && error.code === "checked-value/type-mismatch",
  );
});
