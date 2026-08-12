const textEncoder = new TextEncoder();

function fail(message) {
  throw new TypeError(`handbook content provider: ${message}`);
}

function plainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function requireExactKeys(value, expected, label) {
  if (!plainObject(value)) fail(`${label} must be a record`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
      || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} must contain exactly ${wanted.join(", ")}`);
  }
}

function requireBound(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${name} must be a positive safe integer`);
  }
  return value;
}

export function parseHandbookContent(input) {
  requireExactKeys(
    input,
    ["contentSource", "safeDocumentLimits"],
    "input",
  );
  const { contentSource, safeDocumentLimits } = input;
  if (typeof contentSource !== "string") fail("contentSource must be a string");
  requireExactKeys(
    safeDocumentLimits,
    ["maxBytes", "maxDepth", "maxNodes"],
    "safeDocumentLimits",
  );

  const maxBytes = requireBound(safeDocumentLimits.maxBytes, "maxBytes");
  const maxDepth = requireBound(safeDocumentLimits.maxDepth, "maxDepth");
  const maxNodes = requireBound(safeDocumentLimits.maxNodes, "maxNodes");
  if (maxDepth < 3) fail("maxDepth must permit document, paragraph, and text");
  if (textEncoder.encode(contentSource).byteLength > maxBytes) {
    fail("contentSource exceeds maxBytes");
  }

  const blocks = contentSource
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => ({
      tag: "paragraph",
      inlines: [{ tag: "text", text: line }],
    }));
  const nodeCount = 1 + blocks.length * 2;
  if (nodeCount > maxNodes) fail("safe document exceeds maxNodes");

  return { tag: "document", blocks };
}
