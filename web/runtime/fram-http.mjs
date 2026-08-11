const MAX_BODY_BYTES = 64 * 1024;
const MAX_VERSION = 9_223_372_036_854_775_807n;
const MIN_I64 = -9_223_372_036_854_775_808n;
const INTEGER = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/;

const ROUTES = new Set([
  "/api/wake/query",
  "/api/wake/command",
  "/api/wake/changes",
]);

const GATEWAY_ERROR_STATUS = new Map([
  ["gateway/invalid-input", 400],
  ["gateway/type-mismatch", 400],
  ["gateway/cardinality", 400],
  ["gateway/identity-mutation", 400],
  ["gateway/write-policy", 400],
  ["gateway/missing-identity", 400],
  ["gateway/invalid-transition", 400],
  ["gateway/unknown-entity", 404],
  ["gateway/unknown-field", 404],
  ["gateway/unknown-publication", 404],
  ["gateway/result-limit", 409],
  ["gateway/protocol", 500],
  ["gateway/data-integrity", 500],
  ["schema/invalid-input", 400],
  ["schema/action-limit", 400],
  ["schema/identity-missing", 404],
  ["schema/identity-exists", 409],
  ["schema/duplicate-identity", 409],
  ["schema/duplicate-update-target", 409],
  ["schema/required-identity-missing", 409],
  ["schema/current-value-rejected", 409],
  ["schema/conflict-exhausted", 409],
  ["schema/invalid-response", 500],
]);

class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function exactJsonNumber(value) {
  return Number.isFinite(value) && !Object.is(value, -0);
}

function jsonResponse(value, status = 200, headers = {}) {
  const body = JSON.stringify(
    value === undefined ? null : value,
    (_key, item) => {
      if (typeof item === "bigint") return item.toString(10);
      if (typeof item === "number" && !exactJsonNumber(item)) {
        throw new TypeError("Gateway response contains a number JSON cannot preserve exactly.");
      }
      return item;
    },
  );

  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function errorResponse(status, code, message, headers) {
  return jsonResponse({ error: { code, message } }, status, headers);
}

function mappedGatewayError(error) {
  if (error === null || typeof error !== "object"
      || typeof error.code !== "string" || typeof error.message !== "string") {
    return null;
  }
  const status = GATEWAY_ERROR_STATUS.get(error.code);
  return status === undefined ? null : errorResponse(status, error.code, error.message);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function requireExactKeys(value, required, optional = []) {
  if (!isPlainObject(value)) {
    throw new RequestError(400, "invalid_request", "Request body must be a JSON object.");
  }

  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key))
      || keys.some((key) => !allowed.has(key))) {
    throw new RequestError(400, "invalid_request", "Request body has invalid fields.");
  }
}

function requireNonemptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new RequestError(400, "invalid_request", `${name} must be a non-empty string.`);
  }
}

function requireExactJsonNumbers(value, name) {
  if (typeof value === "number") {
    if (!exactJsonNumber(value)) {
      throw new RequestError(
        400,
        "invalid_request",
        `${name} must not contain non-finite numbers or negative zero.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) requireExactJsonNumbers(item, name);
    return;
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) requireExactJsonNumbers(item, name);
  }
}

function requireCanonicalI64(value, name) {
  let spelling;
  if (typeof value === "string" && INTEGER.test(value)) {
    spelling = value;
  } else if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)) {
    spelling = String(value);
  } else {
    throw new RequestError(400, "invalid_request", `${name} must be a canonical integer.`);
  }
  const integer = BigInt(spelling);
  if (integer < MIN_I64 || integer > MAX_VERSION) {
    throw new RequestError(400, "invalid_request", `${name} is outside the i64 range.`);
  }
  return integer;
}

function requireIdentity(value) {
  if (typeof value === "string" || typeof value === "boolean"
      || (typeof value === "number" && exactJsonNumber(value))) {
    return;
  }
  if (isPlainObject(value)
      && Object.keys(value).length === 2
      && Object.hasOwn(value, "epochSeconds")
      && Object.hasOwn(value, "nanos")) {
    requireCanonicalI64(value.epochSeconds, "identity.epochSeconds");
    const nanos = requireCanonicalI64(value.nanos, "identity.nanos");
    if (nanos < 0n || nanos > 999_999_999n) {
      throw new RequestError(
        400,
        "invalid_request",
        "identity.nanos is outside the nanosecond range.",
      );
    }
    return;
  }
  throw new RequestError(
    400,
    "invalid_request",
    "identity must be a JSON primitive or an exact Instant object.",
  );
}

function parseSinceVersion(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new RequestError(
      400,
      "invalid_request",
      "sinceVersion must be an unsigned decimal string.",
    );
  }

  const version = BigInt(value);
  if (version > MAX_VERSION) {
    throw new RequestError(400, "invalid_request", "sinceVersion is outside the nonnegative i64 range.");
  }
  return version;
}

async function readJson(request) {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(contentLength)) {
      throw new RequestError(400, "invalid_request", "Content-Length is invalid.");
    }
    if (BigInt(contentLength) > BigInt(MAX_BODY_BYTES)) {
      throw new RequestError(413, "payload_too_large", "Request body is too large.");
    }
  }

  if (request.body === null) {
    throw new RequestError(400, "invalid_json", "Request body must contain JSON.");
  }

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RequestError(413, "payload_too_large", "Request body is too large.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, "invalid_json", "Request body could not be read.");
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    throw new RequestError(400, "invalid_json", "Request body must contain valid JSON.");
  }
}

function validateQuery(body) {
  if (!isPlainObject(body)) {
    throw new RequestError(400, "invalid_request", "Request body must be a JSON object.");
  }

  if (body.op === "list") {
    requireExactKeys(body, ["op", "entity"]);
  } else if (body.op === "get") {
    requireExactKeys(body, ["op", "entity", "identity"]);
    requireIdentity(body.identity);
  } else {
    throw new RequestError(400, "invalid_request", "query op must be list or get.");
  }
  requireNonemptyString(body.entity, "entity");
  return body;
}

function validateCommand(body) {
  if (!isPlainObject(body)) {
    throw new RequestError(400, "invalid_request", "Request body must be a JSON object.");
  }

  if (body.op === "create") {
    requireExactKeys(body, ["op", "entity", "values"]);
    if (!isPlainObject(body.values)) {
      throw new RequestError(400, "invalid_request", "values must be a JSON object.");
    }
    requireExactJsonNumbers(body.values, "values");
  } else if (body.op === "set") {
    requireExactKeys(body, ["op", "entity", "identity", "field", "value"]);
    requireIdentity(body.identity);
    requireNonemptyString(body.field, "field");
    requireExactJsonNumbers(body.value, "value");
  } else if (body.op === "publish") {
    requireExactKeys(body, [
      "op",
      "publication",
      "owner",
      "revision",
      "expectedPointer",
    ]);
    requireNonemptyString(body.publication, "publication");
    requireIdentity(body.owner);
    requireIdentity(body.revision);
    if (body.expectedPointer !== null) requireIdentity(body.expectedPointer);
  } else {
    throw new RequestError(
      400,
      "invalid_request",
      "command op must be create, set, or publish.",
    );
  }
  if (body.op !== "publish") requireNonemptyString(body.entity, "entity");
  return body;
}

function validateChanges(body) {
  requireExactKeys(body, ["sinceVersion"]);
  return { ...body, sinceVersion: parseSinceVersion(body.sinceVersion) };
}

function authorizationContext(request, route, payload) {
  const op = route === "/api/wake/changes" ? "changes" : payload.op;
  return {
    request,
    route,
    op,
    payload,
    ...(Object.hasOwn(payload, "entity") ? { entity: payload.entity } : {}),
    ...(Object.hasOwn(payload, "identity") ? { identity: payload.identity } : {}),
    ...(Object.hasOwn(payload, "field") ? { field: payload.field } : {}),
    ...(Object.hasOwn(payload, "publication") ? { publication: payload.publication } : {}),
    ...(Object.hasOwn(payload, "owner") ? { owner: payload.owner } : {}),
    ...(Object.hasOwn(payload, "revision") ? { revision: payload.revision } : {}),
    ...(Object.hasOwn(payload, "expectedPointer")
      ? { expectedPointer: payload.expectedPointer }
      : {}),
  };
}

async function dispatch(gateway, route, payload) {
  if (route === "/api/wake/query") {
    return payload.op === "list"
      ? gateway.list(payload.entity)
      : gateway.get(payload.entity, payload.identity);
  }
  if (route === "/api/wake/command") {
    if (payload.op === "create") return gateway.create(payload.entity, payload.values);
    if (payload.op === "set") {
      return gateway.set(payload.entity, payload.identity, payload.field, payload.value);
    }
    return gateway.publish(
      payload.publication,
      payload.owner,
      payload.revision,
      payload.expectedPointer,
    );
  }
  return gateway.changes(payload.sinceVersion);
}

export function createWakeHttpHandler(gateway, { authorize } = {}) {
  return async function handle(request) {
    const url = new URL(request.url);
    const route = url.pathname;
    if (!ROUTES.has(route) || url.search !== "") {
      return errorResponse(404, "not_found", "Route not found.");
    }
    if (request.method !== "POST") {
      return errorResponse(405, "method_not_allowed", "Only POST is allowed.", { allow: "POST" });
    }

    const contentType = request.headers.get("content-type");
    if (contentType === null
        || contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      return errorResponse(
        415,
        "unsupported_media_type",
        "Content-Type must be application/json.",
      );
    }

    try {
      const body = await readJson(request);
      const payload = route === "/api/wake/query"
        ? validateQuery(body)
        : route === "/api/wake/command"
          ? validateCommand(body)
          : validateChanges(body);

      if (typeof authorize !== "function") {
        return errorResponse(403, "forbidden", "Request is not authorized.");
      }

      let allowed = false;
      try {
        allowed = await authorize(authorizationContext(request, route, payload));
      } catch {
        allowed = false;
      }
      if (allowed !== true) {
        return errorResponse(403, "forbidden", "Request is not authorized.");
      }

      return jsonResponse(await dispatch(gateway, route, payload));
    } catch (error) {
      if (error instanceof RequestError) {
        return errorResponse(error.status, error.code, error.message);
      }
      const mapped = mappedGatewayError(error);
      if (mapped !== null) return mapped;
      return errorResponse(500, "internal_error", "Gateway request failed.");
    }
  };
}
