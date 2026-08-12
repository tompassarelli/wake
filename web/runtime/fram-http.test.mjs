import assert from "node:assert/strict";
import { test } from "bun:test";

import { createWakeHttpHandler } from "./fram-http.mjs";

const origin = "https://wake.test";
const fingerprint = `sha256:${"f".repeat(64)}`;

function post(path, body, headers = {}) {
  const payload = typeof body === "string"
    ? body
    : JSON.stringify({ fingerprint, ...body });
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: payload,
  });
}

function gateway(overrides = {}) {
  const unexpected = () => { throw new Error("unexpected gateway call"); };
  return {
    semanticFingerprint: fingerprint,
    list: unexpected,
    get: unexpected,
    create: unexpected,
    set: unexpected,
    publish: unexpected,
    changes: unexpected,
    ...overrides,
  };
}

async function json(response) {
  return JSON.parse(await response.text());
}

test("the HTTP surface is closed and request shapes are exact", async () => {
  const handle = createWakeHttpHandler(gateway(), { authorize: () => true });

  const unknown = await handle(post("/api/wake/raw", {}));
  assert.equal(unknown.status, 404);
  assert.deepEqual(await json(unknown), {
    error: { code: "not_found", message: "Route not found." },
  });

  const method = await handle(new Request(`${origin}/api/wake/query`));
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "POST");

  const mediaType = await handle(new Request(`${origin}/api/wake/query`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  }));
  assert.equal(mediaType.status, 415);

  const malformed = await handle(post("/api/wake/query", "{"));
  assert.equal(malformed.status, 400);
  assert.equal((await json(malformed)).error.code, "invalid_json");

  const extra = await handle(post("/api/wake/query", {
    op: "list",
    entity: "page",
    query: ["anything"],
  }));
  assert.equal(extra.status, 400);
  assert.equal((await json(extra)).error.code, "invalid_request");

  const wrongOperationShape = await handle(post("/api/wake/command", {
    op: "create",
    entity: "page",
    identity: "page-1",
    values: {},
  }));
  assert.equal(wrongOperationShape.status, 400);

  const oversized = await handle(post("/api/wake/command", "x".repeat(64 * 1024 + 1)));
  assert.equal(oversized.status, 413);
  assert.equal((await json(oversized)).error.code, "payload_too_large");

  const versionOverflow = await handle(post("/api/wake/changes", {
    sinceVersion: "9223372036854775808",
  }));
  assert.equal(versionOverflow.status, 400);
  assert.equal((await json(versionOverflow)).error.message,
    "sinceVersion is outside the nonnegative i64 range.");

  for (const invalid of [
    { op: "publish", publication: "canonical", owner: "home", revision: "rev-2" },
    {
      op: "publish",
      publication: "canonical",
      owner: "home",
      revision: "rev-2",
      expectedPointer: null,
      field: "status",
    },
    {
      op: "publish",
      publication: "",
      owner: "home",
      revision: "rev-2",
      expectedPointer: null,
    },
    {
      op: "publish",
      publication: "canonical",
      owner: ["string", "home"],
      revision: "rev-2",
      expectedPointer: null,
    },
  ]) {
    const response = await handle(post("/api/wake/command", invalid));
    assert.equal(response.status, 400);
    assert.equal((await json(response)).error.code, "invalid_request");
  }
});

test("authorization is deny-by-default and exceptions fail closed", async () => {
  let calls = 0;
  const service = gateway({
    list() {
      calls += 1;
      return { rows: [], servedVersion: 1n };
    },
  });
  const request = () => post("/api/wake/query", { op: "list", entity: "page" });

  for (const handle of [
    createWakeHttpHandler(service),
    createWakeHttpHandler(service, { authorize: () => false }),
    createWakeHttpHandler(service, { authorize: () => undefined }),
    createWakeHttpHandler(service, { authorize: () => { throw new Error("no"); } }),
  ]) {
    const response = await handle(request());
    assert.equal(response.status, 403);
    assert.deepEqual(await json(response), {
      error: { code: "forbidden", message: "Request is not authorized." },
    });
  }
  assert.equal(calls, 0);
});

test("application fingerprint is checked before authorization and dispatch", async () => {
  let authorizationCalls = 0;
  let gatewayCalls = 0;
  const handle = createWakeHttpHandler(gateway({
    list() {
      gatewayCalls += 1;
      return { rows: [], servedVersion: 1n };
    },
  }), {
    expectedFingerprint: fingerprint,
    authorize() {
      authorizationCalls += 1;
      return true;
    },
  });

  for (const body of [
    { op: "list", entity: "page", fingerprint: undefined },
    { op: "list", entity: "page", fingerprint: "not-a-digest" },
  ]) {
    const response = await handle(new Request(`${origin}/api/wake/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    assert.equal(response.status, 400);
    assert.equal((await json(response)).error.code, "invalid_request");
  }

  const mismatch = await handle(post("/api/wake/query", {
    fingerprint: `sha256:${"e".repeat(64)}`,
    op: "list",
    entity: "page",
  }));
  assert.equal(mismatch.status, 409);
  assert.deepEqual(await json(mismatch), {
    error: {
      code: "application_mismatch",
      message: "Request fingerprint does not match the deployed application.",
    },
  });
  assert.equal(authorizationCalls, 0);
  assert.equal(gatewayCalls, 0);
});

test("named queries use a closed envelope and preserve the authorization decision", async () => {
  const actor = Object.freeze({ id: "actor-1" });
  let call;
  const handle = createWakeHttpHandler(gateway({
    executeQuery(...args) {
      call = args;
      return {
        rows: [{ id: "release-1" }],
        page: { done: true, nextCursor: null },
        servedVersion: 7n,
      };
    },
  }), {
    expectedFingerprint: fingerprint,
    authorize: () => Object.freeze({ allowed: true, actor }),
  });

  const response = await handle(post("/api/wake/query", {
    op: "execute",
    query: "wiki.browse-published",
    input: { phase: "published" },
    options: { limit: 20, asOf: "7" },
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(call.slice(0, 3), [
    "wiki.browse-published",
    { phase: "published" },
    { limit: 20, asOf: 7n },
  ]);
  assert.equal(call[3].allowed, true);
  assert.equal(call[3].actor, actor);
  assert.deepEqual(await json(response), {
    rows: [{ id: "release-1" }],
    page: { done: true, nextCursor: null },
    servedVersion: "7",
  });

  for (const invalid of [
    {
      op: "execute",
      query: "wiki.browse-published",
      input: {},
      options: { limit: 248 },
    },
    {
      op: "execute",
      query: "wiki.browse-published",
      input: {},
      options: { asOf: "01" },
    },
    {
      op: "execute",
      query: "wiki.browse-published",
      input: {},
      options: { unexpected: true },
    },
    {
      op: "execute",
      query: "wiki.browse-published",
      input: {},
      unexpected: true,
    },
  ]) {
    const invalidResponse = await handle(post("/api/wake/query", invalid));
    assert.equal(invalidResponse.status, 400);
    assert.equal((await json(invalidResponse)).error.code, "invalid_request");
  }
});

test("success responses are bounded by encoded UTF-8 bytes", async () => {
  const handle = createWakeHttpHandler(gateway({
    list: () => ({ rows: [{ body: "界".repeat(256 * 1024) }], servedVersion: 1n }),
  }), { authorize: () => true });
  const response = await handle(post("/api/wake/query", { op: "list", entity: "page" }));
  assert.equal(response.status, 500);
  assert.deepEqual(await json(response), {
    error: {
      code: "response_too_large",
      message: "Gateway response exceeds the encoded-byte limit.",
    },
  });
});

test("authorization receives the validated operation context", async () => {
  let context;
  const handle = createWakeHttpHandler(gateway({
    get: () => ({ row: { title: "Wake" }, servedVersion: 7n }),
  }), {
    authorize(value) {
      context = value;
      return true;
    },
  });
  const request = post("/api/wake/query", {
    op: "get",
    entity: "page",
    identity: "wake",
  });
  const response = await handle(request);

  assert.equal(response.status, 200);
  assert.equal(context.request, request);
  assert.equal(context.route, "/api/wake/query");
  assert.equal(context.op, "get");
  assert.equal(context.entity, "page");
  assert.equal(context.identity, "wake");
  assert.deepEqual(context.payload, {
    fingerprint,
    op: "get",
    entity: "page",
    identity: "wake",
  });
  assert.deepEqual(await json(response), {
    row: { title: "Wake" },
    servedVersion: "7",
  });
});

test("HTTP preserves prototype-shaped row fields for generated consumers", async () => {
  const row = {};
  for (const name of ["__proto__", "constructor", "prototype"]) {
    Object.defineProperty(row, name, {
      value: `${name}-value`,
      enumerable: true,
    });
  }
  const handle = createWakeHttpHandler(gateway({
    list: () => ({ rows: [row], servedVersion: 8n }),
  }), { authorize: () => true });

  const response = await handle(post("/api/wake/query", { op: "list", entity: "page" }));
  assert.equal(response.status, 200);
  const body = await json(response);
  const consumed = { ...body.rows[0], eid: 1 };
  for (const name of ["__proto__", "constructor", "prototype"]) {
    assert.equal(Object.hasOwn(body.rows[0], name), true, name);
    assert.equal(body.rows[0][name], `${name}-value`);
    assert.equal(Object.hasOwn(consumed, name), true, name);
    assert.equal(consumed[name], `${name}-value`);
  }
});

test("publish authorization receives every validated CAS input", async () => {
  let context;
  const request = post("/api/wake/command", {
    op: "publish",
    publication: "canonical",
    owner: "home",
    revision: "rev-2",
    expectedPointer: "rev-1",
  });
  const handle = createWakeHttpHandler(gateway({
    publish: () => ({ changed: true, servedVersion: 9n }),
  }), {
    authorize(value) {
      context = value;
      return true;
    },
  });

  const response = await handle(request);

  assert.equal(response.status, 200);
  assert.equal(context.request, request);
  assert.equal(context.op, "publish");
  assert.equal(context.publication, "canonical");
  assert.equal(context.owner, "home");
  assert.equal(context.revision, "rev-2");
  assert.equal(context.expectedPointer, "rev-1");
});

test("JSON identities preserve every gateway-supported identity shape", async () => {
  const identities = [];
  const handle = createWakeHttpHandler(gateway({
    get(_entity, identity) {
      identities.push(identity);
      return { row: null, servedVersion: 1n };
    },
  }), { authorize: () => true });

  const accepted = [
    "9223372036854775807",
    3.5,
    true,
    { epochSeconds: "-1", nanos: 999_999_999 },
  ];
  for (const identity of accepted) {
    const response = await handle(post("/api/wake/query", {
      op: "get",
      entity: "page",
      identity,
    }));
    assert.equal(response.status, 200);
    await response.body.cancel();
  }
  assert.deepEqual(identities, accepted);

  const rejected = [
    ["integer", "1"],
    { epochSeconds: "0", nanos: 0, zone: "UTC" },
    { epochSeconds: "01", nanos: 0 },
    { epochSeconds: "0", nanos: 1_000_000_000 },
    { arbitrary: "object" },
  ];
  for (const identity of rejected) {
    const response = await handle(post("/api/wake/query", {
      op: "get",
      entity: "page",
      identity,
    }));
    assert.equal(response.status, 400);
    assert.equal((await json(response)).error.code, "invalid_request");
  }
  assert.equal(identities.length, accepted.length);
});

test("stable gateway and schema failures keep their code and HTTP meaning", async () => {
  const coded = (code, message = code) => Object.assign(new Error(message), { code });
  const cases = [
    ["gateway/type-mismatch", 400],
    ["gateway/cardinality", 400],
    ["gateway/invalid-transition", 400],
    ["gateway/write-policy", 400],
    ["gateway/unknown-entity", 404],
    ["gateway/unknown-publication", 404],
    ["gateway/result-limit", 409],
    ["schema/identity-missing", 404],
    ["schema/identity-exists", 409],
    ["schema/current-value-rejected", 409],
    ["schema/required-identity-missing", 409],
    ["gateway/protocol", 500],
    ["gateway/data-integrity", 500],
  ];

  for (const [code, status] of cases) {
    const handle = createWakeHttpHandler(gateway({
      list() { throw coded(code, "stable message"); },
    }), { authorize: () => true });
    const response = await handle(post("/api/wake/query", { op: "list", entity: "page" }));
    assert.equal(response.status, status, code);
    assert.deepEqual(await json(response), {
      error: { code, message: "stable message" },
    });
  }

  const handleUnknown = createWakeHttpHandler(gateway({
    list() { throw coded("rpc/private-failure", "do not expose"); },
  }), { authorize: () => true });
  const unknown = await handleUnknown(post("/api/wake/query", { op: "list", entity: "page" }));
  assert.equal(unknown.status, 500);
  assert.deepEqual(await json(unknown), {
    error: { code: "internal_error", message: "Gateway request failed." },
  });
});

test("validated operations dispatch to the narrow gateway API", async () => {
  const calls = [];
  const handle = createWakeHttpHandler(gateway({
    list(...args) {
      calls.push(["list", ...args]);
      return { rows: [], servedVersion: 1n };
    },
    get(...args) {
      calls.push(["get", ...args]);
      return { row: null, servedVersion: 2n };
    },
    create(...args) {
      calls.push(["create", ...args]);
      return { created: true, identity: "new", servedVersion: 3n };
    },
    set(...args) {
      calls.push(["set", ...args]);
      return { changed: true, identity: "wake", servedVersion: 4n };
    },
    publish(...args) {
      calls.push(["publish", ...args]);
      return { changed: true, revision: "rev-2", servedVersion: 5n };
    },
    changes(...args) {
      calls.push(["changes", ...args]);
      return { changes: [], servedVersion: 5n };
    },
  }), { authorize: async () => true });

  const requests = [
    ["/api/wake/query", { op: "list", entity: "page" }],
    ["/api/wake/query", { op: "get", entity: "page", identity: "wake" }],
    ["/api/wake/command", { op: "create", entity: "page", values: { title: "New" } }],
    ["/api/wake/command", {
      op: "set",
      entity: "page",
      identity: "wake",
      field: "published",
      value: false,
    }],
    ["/api/wake/command", {
      op: "publish",
      publication: "canonical",
      owner: "wake",
      revision: "rev-2",
      expectedPointer: null,
    }],
    ["/api/wake/changes", { sinceVersion: "5" }],
  ];
  for (const [path, body] of requests) {
    const response = await handle(post(path, body));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^application\/json/);
    await response.body.cancel();
  }

  assert.deepEqual(calls, [
    ["list", "page", { allowed: true }],
    ["get", "page", "wake", { allowed: true }],
    ["create", "page", { title: "New" }, { allowed: true }],
    ["set", "page", "wake", "published", false, { allowed: true }],
    ["publish", "canonical", "wake", "rev-2", null, { allowed: true }],
    ["changes", 5n, { allowed: true }],
  ]);
});

function rawPost(path, body) {
  const exactBody = body.startsWith("{") && body.length > 1
    ? `{"fingerprint":"${fingerprint}",${body.slice(1)}`
    : body;
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: exactBody,
  });
}

test("HTTP rejects non-JSON-exact request numbers and dispatches finite values unchanged", async () => {
  const calls = [];
  const handle = createWakeHttpHandler(gateway({
    get(...args) {
      calls.push(["get", ...args]);
      return { row: null, servedVersion: 1n };
    },
    create(...args) {
      calls.push(["create", ...args]);
      return { created: true, identity: 1, servedVersion: 2n };
    },
    set(...args) {
      calls.push(["set", ...args]);
      return { changed: true, identity: 1, servedVersion: 3n };
    },
  }), { authorize: () => true });

  for (const [path, body] of [
    ["/api/wake/query", '{"op":"get","entity":"metric","identity":NaN}'],
    ["/api/wake/command", '{"op":"set","entity":"metric","identity":1,"field":"value","value":Infinity}'],
    ["/api/wake/command", '{"op":"create","entity":"metric","values":{"value":-Infinity}}'],
  ]) {
    const response = await handle(rawPost(path, body));
    assert.equal(response.status, 400);
    assert.equal((await json(response)).error.code, "invalid_json");
  }

  for (const [path, body] of [
    ["/api/wake/query", '{"op":"get","entity":"metric","identity":-0}'],
    ["/api/wake/query", '{"op":"get","entity":"metric","identity":{"epochSeconds":-0,"nanos":0}}'],
    ["/api/wake/command", '{"op":"set","entity":"metric","identity":1,"field":"value","value":-0}'],
    ["/api/wake/command", '{"op":"create","entity":"metric","values":{"samples":[1,-0]}}'],
  ]) {
    const response = await handle(rawPost(path, body));
    assert.equal(response.status, 400);
    assert.equal((await json(response)).error.code, "invalid_request");
  }
  assert.equal(calls.length, 0);

  for (const [path, body] of [
    ["/api/wake/query", '{"op":"get","entity":"metric","identity":-1.25}'],
    ["/api/wake/command", '{"op":"set","entity":"metric","identity":1,"field":"value","value":5e-324}'],
    ["/api/wake/command", '{"op":"create","entity":"metric","values":{"value":1.7976931348623157e+308}}'],
  ]) {
    const response = await handle(rawPost(path, body));
    assert.equal(response.status, 200);
    await response.body.cancel();
  }
  assert.deepEqual(calls, [
    ["get", "metric", -1.25, { allowed: true }],
    ["set", "metric", 1, "value", Number.MIN_VALUE, { allowed: true }],
    ["create", "metric", { value: Number.MAX_VALUE }, { allowed: true }],
  ]);
});

test("HTTP never normalizes non-JSON-exact gateway numbers in responses", async () => {
  for (const invalid of [NaN, Infinity, -Infinity, -0]) {
    const handle = createWakeHttpHandler(gateway({
      list() {
        return { rows: [{ value: invalid }], servedVersion: 1n };
      },
    }), { authorize: () => true });
    const response = await handle(post("/api/wake/query", { op: "list", entity: "metric" }));
    assert.equal(response.status, 500);
    assert.deepEqual(await json(response), {
      error: { code: "internal_error", message: "Gateway request failed." },
    });
  }

  const finite = [0, -1.25, Number.MIN_VALUE, Number.MAX_VALUE];
  const handle = createWakeHttpHandler(gateway({
    list() {
      return { rows: [{ values: finite }], servedVersion: 2n };
    },
  }), { authorize: () => true });
  const response = await handle(post("/api/wake/query", { op: "list", entity: "metric" }));
  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), { rows: [{ values: finite }], servedVersion: "2" });
});
