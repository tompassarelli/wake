import { describe, expect, test } from "bun:test";
import { parseHandbookContent } from "../fixtures/handbook/content-provider.mjs";

const limits = Object.freeze({
  maxBytes: 256,
  maxDepth: 8,
  maxNodes: 32,
});

describe("neutral handbook content provider", () => {
  test("produces only closed safe text blocks", () => {
    expect(parseHandbookContent({
      contentSource: "Start here\nThen continue",
      safeDocumentLimits: limits,
    })).toEqual({
      tag: "document",
      blocks: [
        {
          tag: "paragraph",
          inlines: [{ tag: "text", text: "Start here" }],
        },
        {
          tag: "paragraph",
          inlines: [{ tag: "text", text: "Then continue" }],
        },
      ],
    });
  });

  test("keeps hostile markup inert as text", () => {
    const document = parseHandbookContent({
      contentSource: "<script>alert(1)</script>",
      safeDocumentLimits: limits,
    });
    expect(document.blocks[0]).toEqual({
      tag: "paragraph",
      inlines: [{ tag: "text", text: "<script>alert(1)</script>" }],
    });
  });

  test("measures UTF-8 bytes and node count exactly", () => {
    expect(() => parseHandbookContent({
      contentSource: "界界",
      safeDocumentLimits: { ...limits, maxBytes: 5 },
    })).toThrow("contentSource exceeds maxBytes");
    expect(() => parseHandbookContent({
      contentSource: "one\ntwo",
      safeDocumentLimits: { ...limits, maxNodes: 4 },
    })).toThrow("safe document exceeds maxNodes");
  });

  test("rejects open records and unusable recursion bounds", () => {
    expect(() => parseHandbookContent({
      contentSource: "text",
      safeDocumentLimits: limits,
      ambientAuthority: true,
    })).toThrow("input must contain exactly");
    expect(() => parseHandbookContent({
      contentSource: "text",
      safeDocumentLimits: { ...limits, maxDepth: 2 },
    })).toThrow("maxDepth must permit");
  });
});
