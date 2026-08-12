const textEncoder = new TextEncoder();
const SHA256_CONSTANTS = Uint32Array.of(
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
);

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

  const paddedLength = Math.ceil((bytes.byteLength + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.byteLength] = 0x80;
  const bitLength = BigInt(bytes.byteLength) * 8n;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Number(bitLength >> 32n & 0xffffffffn), false);
  view.setUint32(paddedLength - 4, Number(bitLength & 0xffffffffn), false);

  const hash = Uint32Array.of(
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  );
  const words = new Uint32Array(64);
  const rotateRight = (word, places) => word >>> places | word << 32 - places;

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous = words[index - 15];
      const beforePrevious = words[index - 2];
      const sigma0 = rotateRight(previous, 7)
        ^ rotateRight(previous, 18)
        ^ previous >>> 3;
      const sigma1 = rotateRight(beforePrevious, 17)
        ^ rotateRight(beforePrevious, 19)
        ^ beforePrevious >>> 10;
      words[index] = words[index - 16] + sigma0 + words[index - 7] + sigma1;
    }

    let a = hash[0];
    let b = hash[1];
    let c = hash[2];
    let d = hash[3];
    let e = hash[4];
    let f = hash[5];
    let g = hash[6];
    let h = hash[7];

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = e & f ^ ~e & g;
      const temporary1 = h + sum1 + choice + SHA256_CONSTANTS[index] + words[index];
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = a & b ^ a & c ^ b & c;
      const temporary2 = sum0 + majority;

      h = g;
      g = f;
      f = e;
      e = d + temporary1;
      d = c;
      c = b;
      b = a;
      a = temporary1 + temporary2;
    }

    hash[0] += a;
    hash[1] += b;
    hash[2] += c;
    hash[3] += d;
    hash[4] += e;
    hash[5] += f;
    hash[6] += g;
    hash[7] += h;
  }

  return Array.from(hash, word => word.toString(16).padStart(8, "0")).join("");
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
