const TOKEN_PREFIX = "wake-cursor-v1";
const TOKEN_VERSION = 1;
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_KEY_ID_BYTES = 128;
const MAX_QUERY_BYTES = 512;
const MAX_SCOPE_BYTES = 2 * 1024;
const MAX_IDENTITY_BYTES = 64 * 1024;
const MAX_IDENTITY_DEPTH = 32;
const MAX_IDENTITY_NODES = 8_192;
const MAX_TERM_DEPTH = 256;
const MAX_TERM_NODES = 4_096;
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_TTL_MS = 15 * 60 * 1_000;
const I64_MAX = (1n << 63n) - 1n;
const INTEGER = /^(?:0|[1-9][0-9]*)$/;
const FLOAT64 = /^[0-9a-f]{16}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export class WakeCursorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WakeCursorError";
    this.code = code;
  }
}

function cursorError(code, message) {
  return new WakeCursorError(code, message);
}

function own(value, key) {
  return Object.hasOwn(value, key);
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactRecord(value, required, optional, label, code) {
  if (!plainObject(value)) throw cursorError(code, `${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (required.some(key => !own(value, key)) || keys.some(key => !allowed.has(key))) {
    throw cursorError(code, `${label} has invalid fields`);
  }
}

function boundedString(value, label, maxBytes, code) {
  if (typeof value !== "string" || value.trim().length === 0
      || encoder.encode(value).byteLength > maxBytes) {
    throw cursorError(code, `${label} must be a bounded nonempty string`);
  }
  return value;
}

function fingerprint(value, code) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw cursorError(code, "fingerprint must be a sha256 digest");
  }
  return value;
}

function pageLimit(options, label, code) {
  exactRecord(options, [], ["limit"], label, code);
  if (!own(options, "limit")) return null;
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 247) {
    throw cursorError(code, `${label}.limit must be an integer from 1 through 247`);
  }
  return options.limit;
}

function canonicalValue(value, state, depth) {
  state.nodes += 1;
  if (state.nodes > MAX_IDENTITY_NODES || depth > MAX_IDENTITY_DEPTH) {
    throw cursorError(state.code, "cursor identity exceeds its structural bounds");
  }
  if (value === null) return "n";
  if (typeof value === "string") return `s${JSON.stringify(value)}`;
  if (typeof value === "boolean") return value ? "b1" : "b0";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw cursorError(state.code, "cursor identity contains an inexact JSON number");
    }
    return `d${JSON.stringify(value)}`;
  }
  if (typeof value === "bigint") return `i${value.toString()}`;
  if (Array.isArray(value)) {
    return `a[${value.map(item => canonicalValue(item, state, depth + 1)).join(",")}]`;
  }
  if (!plainObject(value)) {
    throw cursorError(state.code, "cursor identity contains an unsupported value");
  }
  return `o{${Object.keys(value).sort().map(key => (
    `${JSON.stringify(key)}:${canonicalValue(value[key], state, depth + 1)}`
  )).join(",")}}`;
}

function canonicalIdentity(query, input, limit, code) {
  if (!plainObject(input)) throw cursorError(code, "cursor input must be an object");
  const text = canonicalValue({ input, limit, query }, { nodes: 0, code }, 0);
  const bytes = encoder.encode(text);
  if (bytes.byteLength > MAX_IDENTITY_BYTES) {
    throw cursorError(code, "cursor identity exceeds its encoded-byte bound");
  }
  return bytes;
}

function hex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes) {
  return `sha256:${hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))}`;
}

function unsignedVersion(value, label, code) {
  let spelling;
  if (typeof value === "bigint") spelling = value.toString();
  else if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)) {
    spelling = String(value);
  } else if (typeof value === "string" && INTEGER.test(value)) spelling = value;
  else throw cursorError(code, `${label} must be a canonical nonnegative integer`);
  if (!INTEGER.test(spelling)) {
    throw cursorError(code, `${label} must be a canonical nonnegative integer`);
  }
  const version = BigInt(spelling);
  if (version > I64_MAX) throw cursorError(code, `${label} is outside the i64 range`);
  return version;
}

function cloneTerm(value, label, code, budget = { nodes: 0 }, depth = 1) {
  budget.nodes += 1;
  if (budget.nodes > MAX_TERM_NODES || depth > MAX_TERM_DEPTH) {
    throw cursorError(code, `${label} exceeds the recursive Term bounds`);
  }
  if (!Array.isArray(value) || typeof value[0] !== "string") {
    throw cursorError(code, `${label} must be a tagged Term`);
  }
  switch (value[0]) {
    case "string":
      if (value.length === 2 && typeof value[1] === "string") return ["string", value[1]];
      break;
    case "integer":
      if (value.length === 2 && typeof value[1] === "string" && /^-?(?:0|[1-9][0-9]*)$/.test(value[1])) {
        const integer = BigInt(value[1]);
        if (integer >= -(1n << 63n) && integer <= I64_MAX) return ["integer", value[1]];
      }
      break;
    case "float64":
      if (value.length === 2 && typeof value[1] === "string" && FLOAT64.test(value[1])) {
        return ["float64", value[1]];
      }
      break;
    case "boolean":
      if (value.length === 2 && typeof value[1] === "boolean") return ["boolean", value[1]];
      break;
    case "keyword":
      if (value.length === 2 && typeof value[1] === "string" && value[1].length > 0) {
        return ["keyword", value[1]];
      }
      break;
    case "instant":
      if (value.length === 3
          && typeof value[1] === "string" && /^-?(?:0|[1-9][0-9]*)$/.test(value[1])
          && typeof value[2] === "string" && INTEGER.test(value[2])) {
        const seconds = BigInt(value[1]);
        const nanos = BigInt(value[2]);
        if (seconds >= -(1n << 63n) && seconds <= I64_MAX && nanos <= 999_999_999n) {
          return ["instant", value[1], value[2]];
        }
      }
      break;
    case "triple":
      if (value.length === 4) {
        return [
          "triple",
          cloneTerm(value[1], label, code, budget, depth + 1),
          cloneTerm(value[2], label, code, budget, depth + 1),
          cloneTerm(value[3], label, code, budget, depth + 1),
        ];
      }
      break;
    default:
      break;
  }
  throw cursorError(code, `${label} is not a valid tagged Term`);
}

function base64url(bytes) {
  return bytes.toBase64({ alphabet: "base64url", omitPadding: true });
}

function decodeBase64url(text, label, maxBytes) {
  if (typeof text !== "string" || text.length === 0 || !BASE64URL.test(text)
      || text.length > Math.ceil(maxBytes * 4 / 3) + 2) {
    throw cursorError("invalid_cursor", `${label} is not canonical base64url`);
  }
  let bytes;
  try {
    bytes = Uint8Array.fromBase64(text, { alphabet: "base64url" });
  } catch {
    throw cursorError("invalid_cursor", `${label} is not canonical base64url`);
  }
  if (bytes.byteLength > maxBytes || base64url(bytes) !== text) {
    throw cursorError("invalid_cursor", `${label} is not canonical base64url`);
  }
  return bytes;
}

function keyId(value, label = "key id") {
  if (typeof value !== "string" || value.length === 0
      || encoder.encode(value).byteLength > MAX_KEY_ID_BYTES) {
    throw new TypeError(`${label} must be a bounded nonempty string`);
  }
  return value;
}

function copyKeyMaterial(value, id, active) {
  if (value instanceof CryptoKey) {
    if (value.type !== "secret" || value.algorithm?.name !== "AES-GCM"
        || value.algorithm?.length !== 256 || !value.usages.includes("decrypt")
        || (active && !value.usages.includes("encrypt"))) {
      throw new TypeError(`cursor key ${id} must be a 256-bit AES-GCM key with required usages`);
    }
    return value;
  }
  const bytes = value instanceof Uint8Array
    ? new Uint8Array(value)
    : value instanceof ArrayBuffer ? new Uint8Array(value.slice(0)) : null;
  if (bytes === null || bytes.byteLength !== 32) {
    throw new TypeError(`cursor key ${id} must contain exactly 32 bytes`);
  }
  return bytes;
}

function keyEntries(keys) {
  if (keys instanceof Map) return Array.from(keys.entries());
  if (plainObject(keys)) return Object.entries(keys);
  throw new TypeError("cursor keys must be a Map or plain object");
}

function providerConfiguration(configuration) {
  if (!plainObject(configuration)) throw new TypeError("cursor provider configuration must be an object");
  const allowed = new Set(["activeKeyId", "keys", "ttlMs", "now"]);
  if (!own(configuration, "activeKeyId") || !own(configuration, "keys")
      || Object.keys(configuration).some(key => !allowed.has(key))) {
    throw new TypeError("cursor provider configuration has invalid fields");
  }
  const activeKeyId = keyId(configuration.activeKeyId, "activeKeyId");
  const ttlMs = configuration.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) {
    throw new TypeError(`cursor ttlMs must be an integer from 1 through ${MAX_TTL_MS}`);
  }
  const now = configuration.now ?? Date.now;
  if (typeof now !== "function") throw new TypeError("cursor now must be a function");
  const materials = new Map();
  for (const [rawId, value] of keyEntries(configuration.keys)) {
    const id = keyId(rawId);
    if (materials.has(id)) throw new TypeError(`cursor key ${id} is duplicated`);
    materials.set(id, copyKeyMaterial(value, id, id === activeKeyId));
  }
  if (!materials.has(activeKeyId)) throw new TypeError("activeKeyId does not name an injected cursor key");
  return { activeKeyId, materials, now, ttlMs };
}

function currentTime(now, code) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw cursorError(code, "cursor clock returned an invalid time");
  }
  return value;
}

function sealContext(context) {
  exactRecord(
    context,
    ["authorizationScope", "cursor", "fingerprint", "input", "options", "query", "servedVersion"],
    [],
    "cursor seal context",
    "cursor_provider_failure",
  );
  return checkedContext(context, "cursor_provider_failure");
}

function unsealContext(context) {
  exactRecord(
    context,
    ["authorizationScope", "fingerprint", "input", "options", "query", "token"],
    [],
    "cursor unseal context",
    "invalid_cursor",
  );
  const checked = checkedContext(context, "invalid_cursor");
  if (typeof context.token !== "string" || context.token.length === 0
      || encoder.encode(context.token).byteLength > MAX_TOKEN_BYTES) {
    throw cursorError("invalid_cursor", "cursor token is invalid");
  }
  return { ...checked, token: context.token };
}

function checkedContext(context, code) {
  const checkedFingerprint = fingerprint(context.fingerprint, code);
  const query = boundedString(context.query, "query", MAX_QUERY_BYTES, code);
  const authorizationScope = boundedString(
    context.authorizationScope,
    "authorizationScope",
    MAX_SCOPE_BYTES,
    code,
  );
  const limit = pageLimit(context.options, "cursor options", code);
  if (!plainObject(context.input)) throw cursorError(code, "cursor input must be an object");
  return {
    authorizationScope,
    fingerprint: checkedFingerprint,
    input: context.input,
    limit,
    query,
  };
}

async function importedKey(material, cache, id) {
  if (material instanceof CryptoKey) return material;
  let key = cache.get(id);
  if (key === undefined) {
    key = crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    cache.set(id, key);
  }
  return key;
}

function additionalData(id) {
  return encoder.encode(`${TOKEN_PREFIX}\u0000${id}`);
}

function invalidCursor(error) {
  if (error instanceof WakeCursorError && error.code === "invalid_cursor") return error;
  return cursorError("invalid_cursor", "cursor is invalid or expired");
}

export function createWakeCursorProvider(configuration) {
  const { activeKeyId, materials, now, ttlMs } = providerConfiguration(configuration);
  const keyCache = new Map();

  return Object.freeze({
    async seal(context) {
      try {
        const checked = sealContext(context);
        const servedVersion = unsignedVersion(
          context.servedVersion,
          "servedVersion",
          "cursor_provider_failure",
        );
        const cursor = cloneTerm(
          context.cursor,
          "cursor",
          "cursor_provider_failure",
        );
        const issuedAt = currentTime(now, "cursor_provider_failure");
        const expiresAt = issuedAt + ttlMs;
        if (!Number.isSafeInteger(expiresAt)) {
          throw cursorError("cursor_provider_failure", "cursor expiry is outside the safe range");
        }
        const requestDigest = await sha256(canonicalIdentity(
          checked.query,
          checked.input,
          checked.limit,
          "cursor_provider_failure",
        ));
        const authorizationScopeDigest = await sha256(encoder.encode(checked.authorizationScope));
        const plaintext = encoder.encode(JSON.stringify({
          authorizationScopeDigest,
          cursor,
          expiresAt: String(expiresAt),
          fingerprint: checked.fingerprint,
          requestDigest,
          servedVersion: servedVersion.toString(),
          version: TOKEN_VERSION,
        }));
        if (plaintext.byteLength > MAX_TOKEN_BYTES) {
          throw cursorError("cursor_provider_failure", "cursor plaintext exceeds its bound");
        }
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await importedKey(materials.get(activeKeyId), keyCache, activeKeyId);
        const encrypted = new Uint8Array(await crypto.subtle.encrypt({
          name: "AES-GCM",
          iv,
          additionalData: additionalData(activeKeyId),
          tagLength: 128,
        }, key, plaintext));
        const token = [
          TOKEN_PREFIX,
          base64url(encoder.encode(activeKeyId)),
          base64url(iv),
          base64url(encrypted),
        ].join(".");
        if (encoder.encode(token).byteLength > MAX_TOKEN_BYTES) {
          throw cursorError("cursor_provider_failure", "sealed cursor exceeds 16 KiB");
        }
        return token;
      } catch (error) {
        if (error instanceof WakeCursorError) throw error;
        throw cursorError("cursor_provider_failure", "cursor could not be sealed");
      }
    },

    async unseal(context) {
      try {
        const checked = unsealContext(context);
        const segments = checked.token.split(".");
        if (segments.length !== 4 || segments[0] !== TOKEN_PREFIX) {
          throw cursorError("invalid_cursor", "cursor envelope is invalid");
        }
        const idBytes = decodeBase64url(segments[1], "cursor key id", MAX_KEY_ID_BYTES);
        const id = decoder.decode(idBytes);
        if (base64url(encoder.encode(id)) !== segments[1] || !materials.has(id)) {
          throw cursorError("invalid_cursor", "cursor key is unavailable");
        }
        const iv = decodeBase64url(segments[2], "cursor nonce", 12);
        if (iv.byteLength !== 12) throw cursorError("invalid_cursor", "cursor nonce is invalid");
        const ciphertext = decodeBase64url(segments[3], "cursor ciphertext", MAX_TOKEN_BYTES);
        if (ciphertext.byteLength < 16) throw cursorError("invalid_cursor", "cursor ciphertext is invalid");
        const key = await importedKey(materials.get(id), keyCache, id);
        const plaintext = new Uint8Array(await crypto.subtle.decrypt({
          name: "AES-GCM",
          iv,
          additionalData: additionalData(id),
          tagLength: 128,
        }, key, ciphertext));
        if (plaintext.byteLength > MAX_TOKEN_BYTES) {
          throw cursorError("invalid_cursor", "cursor plaintext exceeds its bound");
        }
        let payload;
        try {
          payload = JSON.parse(decoder.decode(plaintext));
        } catch {
          throw cursorError("invalid_cursor", "cursor plaintext is invalid");
        }
        exactRecord(
          payload,
          [
            "authorizationScopeDigest",
            "cursor",
            "expiresAt",
            "fingerprint",
            "requestDigest",
            "servedVersion",
            "version",
          ],
          [],
          "cursor payload",
          "invalid_cursor",
        );
        if (payload.version !== TOKEN_VERSION || payload.fingerprint !== checked.fingerprint
            || typeof payload.expiresAt !== "string" || !INTEGER.test(payload.expiresAt)
            || typeof payload.requestDigest !== "string" || !SHA256.test(payload.requestDigest)
            || typeof payload.authorizationScopeDigest !== "string"
            || !SHA256.test(payload.authorizationScopeDigest)) {
          throw cursorError("invalid_cursor", "cursor payload does not match its context");
        }
        const expiresAt = Number(payload.expiresAt);
        if (!Number.isSafeInteger(expiresAt) || currentTime(now, "invalid_cursor") >= expiresAt) {
          throw cursorError("invalid_cursor", "cursor is expired");
        }
        const expectedRequestDigest = await sha256(canonicalIdentity(
          checked.query,
          checked.input,
          checked.limit,
          "invalid_cursor",
        ));
        const expectedScopeDigest = await sha256(encoder.encode(checked.authorizationScope));
        if (payload.requestDigest !== expectedRequestDigest
            || payload.authorizationScopeDigest !== expectedScopeDigest) {
          throw cursorError("invalid_cursor", "cursor payload does not match its context");
        }
        const servedVersion = unsignedVersion(payload.servedVersion, "servedVersion", "invalid_cursor");
        const cursor = cloneTerm(payload.cursor, "cursor", "invalid_cursor");
        return Object.freeze({ cursor, servedVersion });
      } catch (error) {
        throw invalidCursor(error);
      }
    },
  });
}

function checkedProvider(provider) {
  if (provider === null || provider === undefined) return null;
  if (!plainObject(provider) || typeof provider.seal !== "function"
      || typeof provider.unseal !== "function") {
    throw new TypeError("cursor provider must expose seal and unseal functions");
  }
  return provider;
}

function transportConfiguration(configuration) {
  if (!plainObject(configuration) || Object.keys(configuration).length !== 1
      || !own(configuration, "fingerprint")) {
    throw new TypeError("cursor transport configuration must contain only fingerprint");
  }
  try {
    return fingerprint(configuration.fingerprint, "invalid_request");
  } catch (error) {
    throw new TypeError(error.message);
  }
}

function transportRequest(request) {
  exactRecord(
    request,
    ["query", "input", "options", "authorizationScope"],
    [],
    "cursor transport request",
    "invalid_request",
  );
  const query = boundedString(request.query, "query", MAX_QUERY_BYTES, "invalid_request");
  const authorizationScope = boundedString(
    request.authorizationScope,
    "authorizationScope",
    MAX_SCOPE_BYTES,
    "invalid_request",
  );
  if (!plainObject(request.input)) throw cursorError("invalid_request", "input must be an object");
  exactRecord(request.options, [], ["limit", "cursor", "asOf"], "options", "invalid_request");
  const limit = pageLimit(
    own(request.options, "limit") ? { limit: request.options.limit } : {},
    "options",
    "invalid_request",
  );
  if (own(request.options, "cursor")) {
    if (typeof request.options.cursor !== "string" || request.options.cursor.length === 0
        || encoder.encode(request.options.cursor).byteLength > MAX_TOKEN_BYTES) {
      throw cursorError("invalid_cursor", "cursor token is invalid");
    }
    if (own(request.options, "asOf")) {
      throw cursorError("invalid_request", "asOf cannot accompany an opaque cursor");
    }
  } else if (own(request.options, "asOf")) {
    unsignedVersion(request.options.asOf, "asOf", "invalid_request");
  }
  canonicalIdentity(query, request.input, limit, "invalid_request");
  return { authorizationScope, input: request.input, limit, options: request.options, query };
}

function providerUnavailable() {
  return cursorError("cursor_provider_unavailable", "cursor provider is unavailable");
}

export function createWakeCursorTransport(providerInput, configuration) {
  const provider = checkedProvider(providerInput);
  const deployedFingerprint = transportConfiguration(configuration);
  return Object.freeze({
    async execute(request, invoke) {
      const checked = transportRequest(request);
      if (typeof invoke !== "function") throw cursorError("invalid_request", "invoke must be a function");
      const effectiveOptions = { ...checked.options };
      let continuationVersion = null;
      if (own(effectiveOptions, "cursor")) {
        if (provider === null) throw providerUnavailable();
        let opened;
        try {
          opened = await provider.unseal(Object.freeze({
            authorizationScope: checked.authorizationScope,
            fingerprint: deployedFingerprint,
            input: structuredClone(checked.input),
            options: Object.freeze(checked.limit === null ? {} : { limit: checked.limit }),
            query: checked.query,
            token: effectiveOptions.cursor,
          }));
        } catch {
          throw cursorError("invalid_cursor", "cursor is invalid or expired");
        }
        if (!plainObject(opened) || Object.keys(opened).length !== 2
            || !own(opened, "cursor") || !own(opened, "servedVersion")) {
          throw cursorError("invalid_cursor", "cursor provider returned invalid data");
        }
        continuationVersion = unsignedVersion(opened.servedVersion, "servedVersion", "invalid_cursor");
        effectiveOptions.cursor = cloneTerm(opened.cursor, "cursor", "invalid_cursor");
        effectiveOptions.asOf = continuationVersion;
      }
      const result = await invoke(Object.freeze({
        authorizationScope: checked.authorizationScope,
        input: structuredClone(checked.input),
        options: effectiveOptions,
        query: checked.query,
      }));
      if (continuationVersion !== null
          && (!plainObject(result) || unsignedVersion(
            result.servedVersion,
            "servedVersion",
            "cursor_provider_failure",
          ) !== continuationVersion)) {
        throw cursorError("cursor_provider_failure", "continuation changed its served version");
      }
      if (!plainObject(result) || !plainObject(result.page)
          || !own(result.page, "nextCursor") || result.page.nextCursor === null) {
        return result;
      }
      if (provider === null) throw providerUnavailable();
      const servedVersion = unsignedVersion(
        result.servedVersion,
        "servedVersion",
        "cursor_provider_failure",
      );
      const rawCursor = cloneTerm(
        result.page.nextCursor,
        "nextCursor",
        "cursor_provider_failure",
      );
      let token;
      try {
        token = await provider.seal(Object.freeze({
          authorizationScope: checked.authorizationScope,
          cursor: rawCursor,
          fingerprint: deployedFingerprint,
          input: structuredClone(checked.input),
          options: Object.freeze(checked.limit === null ? {} : { limit: checked.limit }),
          query: checked.query,
          servedVersion,
        }));
      } catch (error) {
        if (error instanceof WakeCursorError) throw error;
        throw cursorError("cursor_provider_failure", "cursor provider failed to seal a cursor");
      }
      if (typeof token !== "string" || token.length === 0
          || encoder.encode(token).byteLength > MAX_TOKEN_BYTES) {
        throw cursorError("cursor_provider_failure", "cursor provider returned an invalid token");
      }
      return {
        ...result,
        page: { ...result.page, nextCursor: token },
      };
    },
  });
}
