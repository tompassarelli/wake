const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_VERSION = 9_223_372_036_854_775_807n;
const MIN_I64 = -9_223_372_036_854_775_808n;
const INTEGER = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAX_CURSOR_BYTES = 16 * 1024;

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
  ["gateway/unknown-query", 404],
  ["gateway/forbidden", 403],
  ["gateway/result-limit", 409],
  ["gateway/protocol", 500],
  ["gateway/data-integrity", 500],
  ["gateway/missing-provider", 500],
  ["gateway/provider-failed", 500],
  ["gateway/provider-output", 500],
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
  ["command/invalid-input", 400],
  ["command/type-mismatch", 400],
  ["command/cardinality", 400],
  ["command/missing-value", 400],
  ["command/null-field", 400],
  ["command/assertion-failed", 409],
  ["command/idempotency-conflict", 409],
  ["command/duplicate-update", 409],
  ["command/unguarded-update", 409],
  ["command/forbidden", 403],
  ["command/unknown", 404],
  ["command/ambiguous-outcome", 503],
  ["command/invalid-authority", 500],
  ["command/provider-output", 500],
  ["command/provider-rejected", 400],
  ["command/provider-failed", 500],
  ["command/result-invalid", 500],
  ["command/missing-provider", 500],
  ["command/receipt-corrupt", 500],
  ["command/protocol", 500],
  ["command/invalid-plan", 500],
  ["command/invalid-storage", 500],
  ["command/invalid-client", 500],
  ["command/invalid-host", 500],
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

function jsonResponse(value, status = 200, headers = {}, maxBytes = null) {
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
  if (maxBytes !== null && new TextEncoder().encode(body).byteLength > maxBytes) {
    throw new RequestError(
      500,
      "response_too_large",
      "Gateway response exceeds the encoded-byte limit.",
    );
  }

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
    requireExactKeys(body, ["fingerprint", "op", "entity"]);
  } else if (body.op === "get") {
    requireExactKeys(body, ["fingerprint", "op", "entity", "identity"]);
    requireIdentity(body.identity);
  } else if (body.op === "execute") {
    requireExactKeys(body, ["fingerprint", "op", "query", "input"], ["options"]);
    requireNonemptyString(body.query, "query");
    if (!isPlainObject(body.input)) {
      throw new RequestError(400, "invalid_request", "input must be a JSON object.");
    }
    requireExactJsonNumbers(body.input, "input");
    if (Object.hasOwn(body, "options")) {
      requireExactKeys(body.options, [], ["limit", "cursor", "asOf"]);
      if (Object.hasOwn(body.options, "limit")
          && (!Number.isSafeInteger(body.options.limit)
            || body.options.limit < 1 || body.options.limit > 247)) {
        throw new RequestError(
          400,
          "invalid_request",
          "options.limit must be an integer from 1 through 247.",
        );
      }
      if (Object.hasOwn(body.options, "cursor")) {
        if (typeof body.options.cursor !== "string"
            || body.options.cursor.length === 0
            || new TextEncoder().encode(body.options.cursor).byteLength > MAX_CURSOR_BYTES) {
          throw new RequestError(
            400,
            "invalid_request",
            `options.cursor must be an opaque string of at most ${MAX_CURSOR_BYTES} bytes.`,
          );
        }
        if (Object.hasOwn(body.options, "asOf")) {
          throw new RequestError(
            400,
            "invalid_request",
            "options.asOf must not accompany an opaque cursor.",
          );
        }
      }
      if (Object.hasOwn(body.options, "asOf")) {
        const asOf = parseSinceVersion(body.options.asOf);
        body = { ...body, options: { ...body.options, asOf } };
      }
    }
  } else {
    throw new RequestError(400, "invalid_request", "query op must be list, get, or execute.");
  }
  if (body.op !== "execute") requireNonemptyString(body.entity, "entity");
  return body;
}

function validateCommand(body) {
  if (!isPlainObject(body)) {
    throw new RequestError(400, "invalid_request", "Request body must be a JSON object.");
  }

  if (body.op === "create") {
    requireExactKeys(body, ["fingerprint", "op", "entity", "values"]);
    if (!isPlainObject(body.values)) {
      throw new RequestError(400, "invalid_request", "values must be a JSON object.");
    }
    requireExactJsonNumbers(body.values, "values");
  } else if (body.op === "set") {
    requireExactKeys(body, ["fingerprint", "op", "entity", "identity", "field", "value"]);
    requireIdentity(body.identity);
    requireNonemptyString(body.field, "field");
    requireExactJsonNumbers(body.value, "value");
  } else if (body.op === "publish") {
    requireExactKeys(body, [
      "fingerprint",
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
  } else if (body.op === "invoke") {
    requireExactKeys(body, [
      "fingerprint",
      "op",
      "command",
      "requestId",
      "input",
    ]);
    requireNonemptyString(body.command, "command");
    requireNonemptyString(body.requestId, "requestId");
    if (!isPlainObject(body.input)) {
      throw new RequestError(400, "invalid_request", "input must be a JSON object.");
    }
    requireExactJsonNumbers(body.input, "input");
  } else {
    throw new RequestError(
      400,
      "invalid_request",
      "command op must be create, set, publish, or invoke.",
    );
  }
  if (body.op === "create" || body.op === "set") requireNonemptyString(body.entity, "entity");
  return body;
}

function validateChanges(body) {
  requireExactKeys(body, ["fingerprint", "sinceVersion"]);
  return { ...body, sinceVersion: parseSinceVersion(body.sinceVersion) };
}

function validateFingerprint(body, expectedFingerprint) {
  if (!isPlainObject(body) || typeof body.fingerprint !== "string"
      || !SHA256.test(body.fingerprint)) {
    throw new RequestError(
      400,
      "invalid_request",
      "fingerprint must be a sha256 digest.",
    );
  }
  if (body.fingerprint !== expectedFingerprint) {
    throw new RequestError(
      409,
      "application_mismatch",
      "Request fingerprint does not match the deployed application.",
    );
  }
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
    ...(Object.hasOwn(payload, "query") ? { query: payload.query } : {}),
    ...(Object.hasOwn(payload, "command") ? { command: payload.command } : {}),
    ...(Object.hasOwn(payload, "requestId") ? { requestId: payload.requestId } : {}),
    ...(route === "/api/wake/query" && Object.hasOwn(payload, "input")
      ? { input: payload.input }
      : {}),
    ...(Object.hasOwn(payload, "options") ? { options: payload.options } : {}),
    ...(Object.hasOwn(payload, "publication") ? { publication: payload.publication } : {}),
    ...(Object.hasOwn(payload, "owner") ? { owner: payload.owner } : {}),
    ...(Object.hasOwn(payload, "revision") ? { revision: payload.revision } : {}),
    ...(Object.hasOwn(payload, "expectedPointer")
      ? { expectedPointer: payload.expectedPointer }
      : {}),
  };
}

function checkedCursorProvider(value) {
  if (value === undefined) return null;
  if (!isPlainObject(value) || typeof value.seal !== "function"
      || typeof value.unseal !== "function") {
    throw new TypeError("Wake HTTP cursorProvider must provide seal and unseal functions.");
  }
  return value;
}

function cursorContext(fingerprint, payload, decision) {
  if (typeof decision.authorizationScope !== "string"
      || decision.authorizationScope.length === 0) {
    throw new RequestError(
      500,
      "cursor_scope_unavailable",
      "Authorization did not provide a stable cursor scope.",
    );
  }
  return Object.freeze({
    authorizationScope: decision.authorizationScope,
    fingerprint,
    query: payload.query,
    input: structuredClone(payload.input),
    options: Object.freeze(
      Object.hasOwn(payload.options ?? {}, "limit")
        ? { limit: payload.options.limit }
        : {},
    ),
  });
}

async function unwrapQueryCursor(payload, fingerprint, decision, cursorProvider) {
  if (payload.op !== "execute" || !Object.hasOwn(payload.options ?? {}, "cursor")) {
    return payload;
  }
  if (cursorProvider === null) {
    throw new RequestError(500, "cursor_provider_unavailable", "Cursor provider is unavailable.");
  }
  let unsealed;
  try {
    unsealed = await cursorProvider.unseal(Object.freeze({
      ...cursorContext(fingerprint, payload, decision),
      token: payload.options.cursor,
    }));
  } catch {
    throw new RequestError(400, "invalid_cursor", "Cursor is invalid or expired.");
  }
  if (!isPlainObject(unsealed)
      || Object.keys(unsealed).length !== 2
      || !Object.hasOwn(unsealed, "cursor")
      || !Object.hasOwn(unsealed, "servedVersion")
      || !Array.isArray(unsealed.cursor)) {
    throw new RequestError(500, "cursor_provider_failure", "Cursor provider returned invalid data.");
  }
  let servedVersion;
  try {
    servedVersion = typeof unsealed.servedVersion === "bigint"
      ? unsealed.servedVersion
      : requireCanonicalI64(unsealed.servedVersion, "cursor servedVersion");
  } catch {
    throw new RequestError(500, "cursor_provider_failure", "Cursor provider returned invalid data.");
  }
  if (servedVersion < 0n || servedVersion > MAX_VERSION) {
    throw new RequestError(500, "cursor_provider_failure", "Cursor provider returned invalid data.");
  }
  return {
    ...payload,
    options: {
      ...payload.options,
      cursor: structuredClone(unsealed.cursor),
      asOf: servedVersion,
    },
  };
}

async function wrapQueryCursor(result, payload, fingerprint, decision, cursorProvider) {
  if (payload.op !== "execute" || !isPlainObject(result)
      || !isPlainObject(result.page) || result.page.nextCursor == null) {
    return result;
  }
  if (cursorProvider === null) {
    throw new RequestError(500, "cursor_provider_unavailable", "Cursor provider is unavailable.");
  }
  let token;
  try {
    token = await cursorProvider.seal(Object.freeze({
      ...cursorContext(fingerprint, payload, decision),
      servedVersion: result.servedVersion,
      cursor: structuredClone(result.page.nextCursor),
    }));
  } catch {
    throw new RequestError(500, "cursor_provider_failure", "Cursor provider failed to seal a cursor.");
  }
  if (typeof token !== "string" || token.length === 0
      || new TextEncoder().encode(token).byteLength > MAX_CURSOR_BYTES) {
    throw new RequestError(500, "cursor_provider_failure", "Cursor provider returned an invalid token.");
  }
  return {
    ...result,
    page: { ...result.page, nextCursor: token },
  };
}

async function dispatch(gateway, route, payload, decision) {
  if (route === "/api/wake/query") {
    if (payload.op === "list") return gateway.list(payload.entity, decision);
    if (payload.op === "get") return gateway.get(payload.entity, payload.identity, decision);
    return gateway.executeQuery(
      payload.query,
      payload.input,
      payload.options ?? {},
      decision.actor,
    );
  }
  if (route === "/api/wake/command") {
    if (payload.op === "invoke") {
      return gateway.invoke(
        payload.command,
        payload.requestId,
        payload.input,
        decision.actor,
      );
    }
    if (payload.op === "create") return gateway.create(payload.entity, payload.values, decision);
    if (payload.op === "set") {
      return gateway.set(payload.entity, payload.identity, payload.field, payload.value, decision);
    }
    return gateway.publish(
      payload.publication,
      payload.owner,
      payload.revision,
      payload.expectedPointer,
      decision,
    );
  }
  return gateway.changes(payload.sinceVersion, decision);
}

export function createWakeHttpHandler(
  gateway,
  { authorize, cursorProvider: cursorProviderInput, expectedFingerprint } = {},
) {
  const fingerprint = expectedFingerprint ?? gateway?.semanticFingerprint;
  if (typeof fingerprint !== "string" || !SHA256.test(fingerprint)) {
    throw new TypeError("Wake HTTP requires an expected application fingerprint.");
  }
  const cursorProvider = checkedCursorProvider(cursorProviderInput);
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
      validateFingerprint(body, fingerprint);
      const payload = route === "/api/wake/query"
        ? validateQuery(body)
        : route === "/api/wake/command"
          ? validateCommand(body)
          : validateChanges(body);

      if (typeof authorize !== "function") {
        return errorResponse(403, "forbidden", "Request is not authorized.");
      }

      let decision = null;
      try {
        const result = await authorize(authorizationContext(request, route, payload));
        if (result === true) decision = Object.freeze({ allowed: true });
        else if (isPlainObject(result) && result.allowed === true) {
          decision = Object.freeze({ ...result });
        }
      } catch {
        decision = null;
      }
      if (decision === null) {
        return errorResponse(403, "forbidden", "Request is not authorized.");
      }

      const dispatchPayload = await unwrapQueryCursor(
        payload,
        fingerprint,
        decision,
        cursorProvider,
      );
      const result = await dispatch(gateway, route, dispatchPayload, decision);
      const publicResult = await wrapQueryCursor(
        result,
        payload,
        fingerprint,
        decision,
        cursorProvider,
      );
      return jsonResponse(
        publicResult,
        200,
        {},
        MAX_RESPONSE_BYTES,
      );
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
