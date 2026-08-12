# SafeDocument v1

`SafeDocument` is the closed, bounded value returned by the application-bound
`content-parser` provider and exposed by `read-published`. It is data, never
HTML. Every object rejects unknown keys, every list is bounded by the configured
`maxNodes`, every string participates in the configured `maxBytes` envelope,
and recursive inline nesting is bounded by `maxDepth`.

The JSON contract is a discriminated union on `tag`:

```text
SafeDocument = { tag: "document", blocks: Block[] }

Block =
  { tag: "paragraph", inlines: Inline[] }
  | { tag: "heading", level: 2 | 3 | 4, inlines: Inline[] }
  | { tag: "blockQuote", blocks: Block[] }
  | { tag: "list", ordered: boolean, items: ListItem[] }
  | { tag: "codeBlock", language: string | null, text: string }
  | { tag: "thematicBreak" }

ListItem = { blocks: Block[] }

Inline =
  { tag: "text", text: string }
  | { tag: "emphasis", inlines: Inline[] }
  | { tag: "strong", inlines: Inline[] }
  | { tag: "inlineCode", text: string }
  | { tag: "link", href: SafeUrl, inlines: Inline[] }
  | { tag: "lineBreak" }
```

`SafeUrl` is this exact closed tagged union, never a bare string:

```text
SafeUrl =
  { kind: "external", href: string }
  | { kind: "internal", reference: string }
```

Its accepted external schemes and internal-reference policy belong to the
application provider binding. Wake still rejects extra fields, empty values,
and values outside the configured document envelope. The renderer consumes
only resolved safe navigation; it never copies a provider value into an HTML
sink. Raw HTML, SVG, images, styles, event handlers, trusted strings,
executable MDX, ambient authority, and extra properties are absent from this
union.

The provider input is exactly:

```text
{
  contentSource: string,
  safeDocumentLimits: {
    maxBytes: integer,
    maxDepth: integer,
    maxNodes: integer
  }
}
```

Wake revalidates provider output against this same closed type. Provider
success is not sufficient. Public `read-published` replaces its internal raw
`content-source` projection with `safe-document`; raw source remains available
only from the separately authorized draft and review queries.
