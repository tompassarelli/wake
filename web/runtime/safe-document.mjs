import { compileCheckedValue } from "./checked-value.mjs";

function fail(message) {
  throw new TypeError(`wake safe document: ${message}`);
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownData(value, key, label) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
    fail(`${label}.${String(key)} must be an enumerable data property`);
  }
  return descriptor.value;
}

function exactRecord(value, keys, label) {
  if (!plainObject(value)) fail(`${label} must be a plain object`);
  const allowed = new Set(keys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      fail(`${label} contains unsupported property ${String(key)}`);
    }
    ownData(value, key, label);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${label}.${key} is required`);
  }
  return value;
}

function checkedDocument(documentObject) {
  if (documentObject === null || typeof documentObject !== "object"
      || typeof documentObject.createDocumentFragment !== "function"
      || typeof documentObject.createElement !== "function"
      || typeof documentObject.createTextNode !== "function") {
    fail("a DOM Document is required");
  }
  return documentObject;
}

function checkedUrl(value, documentObject, internal) {
  if (typeof value !== "string" || value.length === 0) fail("resolved href must be nonempty");
  let url;
  try {
    url = new URL(value, documentObject.baseURI);
  } catch {
    fail("resolved href must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail("resolved href must use http or https");
  }
  if (internal) {
    const base = new URL(documentObject.baseURI);
    if (url.origin !== base.origin) fail("resolved internal href must remain same-origin");
    return `${url.pathname}${url.search}${url.hash}`;
  }
  return url.href;
}

function defaultResolution(safeUrl, documentObject) {
  if (safeUrl.kind === "internal") return { kind: "unavailable" };
  return {
    href: checkedUrl(safeUrl.href, documentObject, false),
    kind: "canonical",
  };
}

function checkedResolution(value, safeUrl, documentObject) {
  if (!plainObject(value)) fail("SafeUrl resolver result must be a plain object");
  const kind = ownData(value, "kind", "SafeUrl resolver result");
  if (kind === "unavailable") {
    exactRecord(value, ["kind"], "SafeUrl resolver result");
    return { kind };
  }
  if (kind !== "canonical") {
    fail("SafeUrl resolver result kind must be canonical or unavailable");
  }
  exactRecord(value, ["href", "kind"], "SafeUrl resolver result");
  return {
    href: checkedUrl(
      ownData(value, "href", "SafeUrl resolver result"),
      documentObject,
      safeUrl.kind === "internal",
    ),
    kind,
  };
}

function appendAll(parent, values) {
  for (const value of values) parent.appendChild(value);
  return parent;
}

function classed(documentObject, tag, className) {
  const element = documentObject.createElement(tag);
  element.className = className;
  return element;
}

function renderInlines(inlines, context) {
  const fragment = context.document.createDocumentFragment();
  for (const inline of inlines) fragment.appendChild(renderInline(inline, context));
  return fragment;
}

function renderLink(inline, context) {
  const resolution = checkedResolution(
    context.resolveSafeUrl === null
      ? defaultResolution(inline.href, context.document)
      : context.resolveSafeUrl(inline.href),
    inline.href,
    context.document,
  );
  if (resolution.kind === "unavailable") {
    const marker = classed(
      context.document,
      "span",
      "wake-safe-link wake-safe-link--unavailable",
    );
    marker.setAttribute("data-wake-link-state", "unavailable");
    marker.setAttribute("aria-disabled", "true");
    return appendAll(marker, [renderInlines(inline.inlines, context)]);
  }
  const anchor = classed(
    context.document,
    "a",
    inline.href.kind === "internal"
      ? "wake-safe-link wake-safe-link--canonical"
      : "wake-safe-link wake-safe-link--external",
  );
  anchor.setAttribute(
    "data-wake-link-state",
    inline.href.kind === "internal" ? "canonical" : "external",
  );
  anchor.setAttribute("href", resolution.href);
  if (inline.href.kind === "external") anchor.setAttribute("rel", "noopener noreferrer");
  return appendAll(anchor, [renderInlines(inline.inlines, context)]);
}

function renderInline(inline, context) {
  switch (inline.tag) {
    case "text":
      return context.document.createTextNode(inline.text);
    case "emphasis":
      return appendAll(
        classed(context.document, "em", "wake-safe-emphasis"),
        [renderInlines(inline.inlines, context)],
      );
    case "strong":
      return appendAll(
        classed(context.document, "strong", "wake-safe-strong"),
        [renderInlines(inline.inlines, context)],
      );
    case "inlineCode": {
      const code = classed(context.document, "code", "wake-safe-inline-code");
      code.textContent = inline.text;
      return code;
    }
    case "link":
      return renderLink(inline, context);
    case "lineBreak":
      return classed(context.document, "br", "wake-safe-line-break");
    default:
      fail(`unhandled inline tag '${String(inline.tag)}'`);
  }
}

function renderBlocks(blocks, context) {
  const fragment = context.document.createDocumentFragment();
  for (const block of blocks) fragment.appendChild(renderBlock(block, context));
  return fragment;
}

function renderBlock(block, context) {
  switch (block.tag) {
    case "paragraph":
      return appendAll(
        classed(context.document, "p", "wake-safe-paragraph"),
        [renderInlines(block.inlines, context)],
      );
    case "heading":
      return appendAll(
        classed(context.document, `h${block.level}`, "wake-safe-heading"),
        [renderInlines(block.inlines, context)],
      );
    case "blockQuote":
      return appendAll(
        classed(context.document, "blockquote", "wake-safe-block-quote"),
        [renderBlocks(block.blocks, context)],
      );
    case "list": {
      const list = classed(
        context.document,
        block.ordered ? "ol" : "ul",
        "wake-safe-list",
      );
      for (const item of block.items) {
        const listItem = classed(context.document, "li", "wake-safe-list-item");
        listItem.appendChild(renderBlocks(item.blocks, context));
        list.appendChild(listItem);
      }
      return list;
    }
    case "codeBlock": {
      const pre = classed(context.document, "pre", "wake-safe-code-block");
      const code = context.document.createElement("code");
      if (block.language !== null) code.setAttribute("data-language", block.language);
      code.textContent = block.text;
      pre.appendChild(code);
      return pre;
    }
    case "thematicBreak":
      return classed(context.document, "hr", "wake-safe-thematic-break");
    default:
      fail(`unhandled block tag '${String(block.tag)}'`);
  }
}

export function renderSafeDocument(value, {
  descriptor,
  document: documentObject = globalThis.document,
  resolveSafeUrl = null,
} = {}) {
  if (descriptor === undefined) fail("a checked SafeDocument descriptor is required");
  if (resolveSafeUrl !== null && typeof resolveSafeUrl !== "function") {
    fail("resolveSafeUrl must be a function when supplied");
  }
  const dom = checkedDocument(documentObject);
  const normalized = compileCheckedValue(descriptor).normalize(value, {
    code: "safe-document/type-mismatch",
    label: "SafeDocument",
  });
  if (normalized.tag !== "document") fail("root tag must be document");
  return renderBlocks(normalized.blocks, {
    document: dom,
    resolveSafeUrl,
  });
}
