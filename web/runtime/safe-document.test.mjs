import assert from "node:assert/strict";
import { test } from "bun:test";

import { safeUrlDescriptor } from "./checked-value.mjs";
import { renderSafeDocument } from "./safe-document.mjs";

const field = (name, value) => ({ name, required: true, value });
const ref = name => ({ kind: "ref", name });
const list = name => ({ items: ref(name), kind: "list", maxItems: 64 });

const descriptor = {
  definitions: [{
    name: "Document",
    value: { fields: [
      field("tag", { kind: "literal", value: "document" }),
      field("blocks", list("Block")),
    ], kind: "record" },
  }, {
    name: "Block",
    value: { kind: "tagged", tag: "tag", variants: [
      { tag: "paragraph", fields: [field("inlines", list("Inline"))] },
      { tag: "heading", fields: [
        field("level", { kind: "enum", values: [2, 3, 4] }),
        field("inlines", list("Inline")),
      ] },
      { tag: "blockQuote", fields: [field("blocks", list("Block"))] },
      { tag: "list", fields: [
        field("ordered", { kind: "boolean" }),
        field("items", list("ListItem")),
      ] },
      { tag: "codeBlock", fields: [
        field("language", { kind: "nullable", value: { kind: "string" } }),
        field("text", { kind: "string" }),
      ] },
      { tag: "thematicBreak", fields: [] },
    ] },
  }, {
    name: "ListItem",
    value: { fields: [field("blocks", list("Block"))], kind: "record" },
  }, {
    name: "Inline",
    value: { kind: "tagged", tag: "tag", variants: [
      { tag: "text", fields: [field("text", { kind: "string" })] },
      { tag: "emphasis", fields: [field("inlines", list("Inline"))] },
      { tag: "strong", fields: [field("inlines", list("Inline"))] },
      { tag: "inlineCode", fields: [field("text", { kind: "string" })] },
      { tag: "link", fields: [field("href", ref("SafeUrl")), field("inlines", list("Inline"))] },
      { tag: "lineBreak", fields: [] },
    ] },
  }, {
    name: "SafeUrl",
    value: safeUrlDescriptor,
  }],
  kind: "bounded",
  maxBytes: 4096,
  maxDepth: 16,
  maxNodes: 128,
  value: ref("Document"),
};

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
    const result = new FakeNode("text");
    result.textContent = value;
    return result;
  }
}

function descendants(node, result = []) {
  result.push(node);
  for (const child of node.children) descendants(child, result);
  return result;
}

const text = value => ({ tag: "text", text: value });

test("renders every frozen SafeDocument tag with DOM construction only", () => {
  const document = new FakeDocument();
  const value = {
    tag: "document",
    blocks: [{
      tag: "heading",
      level: 2,
      inlines: [text("Title")],
    }, {
      tag: "paragraph",
      inlines: [
        text("A"),
        { tag: "emphasis", inlines: [text("B")] },
        { tag: "strong", inlines: [text("C")] },
        { tag: "inlineCode", text: "<unsafe>" },
        { tag: "lineBreak" },
        {
          tag: "link",
          href: { kind: "external", href: "https://example.test/path" },
          inlines: [text("outside")],
        },
        {
          tag: "link",
          href: { kind: "internal", reference: "entry:one" },
          inlines: [text("inside")],
        },
      ],
    }, {
      tag: "blockQuote",
      blocks: [{ tag: "paragraph", inlines: [text("quote")] }],
    }, {
      tag: "list",
      ordered: true,
      items: [{ blocks: [{ tag: "paragraph", inlines: [text("item")] }] }],
    }, {
      tag: "codeBlock",
      language: "beagle",
      text: "<script>alert(1)</script>",
    }, {
      tag: "thematicBreak",
    }],
  };
  const fragment = renderSafeDocument(value, {
    descriptor,
    document,
    resolveSafeUrl(url) {
      return url.kind === "internal"
        ? { kind: "canonical", href: "/entry/one" }
        : { kind: "canonical", href: url.href };
    },
  });
  const nodes = descendants(fragment);
  assert.deepEqual(
    nodes.filter(node => node.kind === "element").map(node => node.name),
    ["h2", "p", "em", "strong", "code", "br", "a", "a", "blockquote", "p", "ol", "li", "p", "pre", "code", "hr"],
  );
  const anchors = nodes.filter(node => node.name === "a");
  assert.equal(anchors[0].attributes.href, "https://example.test/path");
  assert.equal(anchors[0].attributes.rel, "noopener noreferrer");
  assert.equal(anchors[1].attributes.href, "/entry/one");
  assert.equal(anchors[1].attributes["data-wake-link-state"], "canonical");
  const code = nodes.find(node => node.name === "code" && node.textContent.includes("script"));
  assert.equal(code.textContent, "<script>alert(1)</script>");
  assert.equal(code.children.length, 0);
});

test("renders unavailable internal links as inert marked spans", () => {
  const document = new FakeDocument();
  const fragment = renderSafeDocument({
    tag: "document",
    blocks: [{
      tag: "paragraph",
      inlines: [{
        tag: "link",
        href: { kind: "internal", reference: "missing" },
        inlines: [text("missing")],
      }],
    }],
  }, { descriptor, document });
  const nodes = descendants(fragment);
  assert.equal(nodes.some(node => node.name === "a"), false);
  const marker = nodes.find(node => node.name === "span");
  assert.equal(marker.attributes["data-wake-link-state"], "unavailable");
  assert.equal(marker.attributes["aria-disabled"], "true");
});

test("rejects unsafe or authority-expanding link resolutions", () => {
  const value = {
    tag: "document",
    blocks: [{
      tag: "paragraph",
      inlines: [{
        tag: "link",
        href: { kind: "internal", reference: "entry:one" },
        inlines: [],
      }],
    }],
  };
  for (const resolved of [
    { kind: "canonical", href: "javascript:alert(1)" },
    { kind: "canonical", href: "https://other.test/entry/one" },
    { kind: "canonical", href: "/entry/one", target: "_blank" },
    { kind: "available", href: "/entry/one" },
  ]) {
    assert.throws(
      () => renderSafeDocument(value, {
        descriptor,
        document: new FakeDocument(),
        resolveSafeUrl: () => resolved,
      }),
    );
  }
});

test("revalidates hostile values before touching the DOM", () => {
  const document = new FakeDocument();
  let getterCalls = 0;
  const hostile = { tag: "document" };
  Object.defineProperty(hostile, "blocks", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return [];
    },
  });
  assert.throws(
    () => renderSafeDocument(hostile, { descriptor, document }),
    /enumerable data property/,
  );
  assert.equal(getterCalls, 0);
  assert.throws(
    () => renderSafeDocument({ tag: "document", blocks: [], html: "<b>bad</b>" }, {
      descriptor,
      document,
    }),
    /unsupported property html/,
  );
});

test("renderer implementation contains no markup parser or executable URL path", async () => {
  const source = await Bun.file(`${import.meta.dir}/safe-document.mjs`).text();
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|DOMParser|createContextualFragment/u);
  assert.doesNotMatch(source, /javascript:/iu);
});
