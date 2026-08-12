const textEncoder = new TextEncoder();

function fail(message) {
  throw new TypeError(`wake canonical JSON: ${message}`);
}

function encode(value, path, active) {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        fail(`${path} contains a non-canonical number`);
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      fail(`${path} contains unsupported ${typeof value}`);
  }

  if (active.has(value)) fail(`${path} contains a cycle`);
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const pieces = value.map((item, index) => encode(item, `${path}[${index}]`, active));
      return `[${pieces.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(`${path} is not a plain object`);
    }
    const keys = Object.keys(value).sort();
    const pieces = keys.map((key) => {
      const item = value[key];
      if (item === undefined) fail(`${path}.${key} is undefined`);
      return `${JSON.stringify(key)}:${encode(item, `${path}.${key}`, active)}`;
    });
    return `{${pieces.join(",")}}`;
  } finally {
    active.delete(value);
  }
}

export function canonicalJson(value) {
  return encode(value, "$", new Set());
}

export function canonicalDocument(value) {
  return `${canonicalJson(value)}\n`;
}

export function canonicalBytes(value) {
  return textEncoder.encode(canonicalDocument(value));
}

export function sha256Hex(value) {
  const bytes = typeof value === "string" ? textEncoder.encode(value) : value;
  if (!(bytes instanceof Uint8Array)) {
    fail("sha256 input must be a string or Uint8Array");
  }
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export function sha256Digest(value) {
  return `sha256:${sha256Hex(value)}`;
}

export function parseCanonicalDocument(text, label = "document") {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new TypeError(`wake: ${label} is not valid JSON`, { cause: error });
  }
  if (text !== canonicalDocument(value)) {
    throw new TypeError(`wake: ${label} is not canonical JSON`);
  }
  return value;
}
