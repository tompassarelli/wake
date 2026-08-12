import { expect, test } from "bun:test";

import { canonicalDocument, sha256Digest } from "../compiler/canonical.mjs";
import { WakeAdapterConfigError, createWakeBunAdapter } from "./bun-adapter.mjs";

const fingerprint = `sha256:${"1".repeat(64)}`;
const operationDigest = `sha256:${"3".repeat(64)}`;
const storageDigest = `sha256:${"4".repeat(64)}`;
const protocols = Object.freeze({
  framPlanSchemaVersion: 2,
  httpOperationProtocolVersion: 2,
  pluginAbiVersion: 1,
});

function fixture() {
  const browserJavaScript = `// wake: checked-application ${fingerprint}\n`;
  const browserDigest = sha256Digest(browserJavaScript);
  const plugin = {
    alias: "fixture",
    allowedContributions: ["schema"],
    artifactDigest: `sha256:${"5".repeat(64)}`,
    configuration: {},
    configurationDigest: `sha256:${"6".repeat(64)}`,
    durableSchemaVersion: 1,
    migrationOrdinal: 0,
    packageId: "wake-neutral-fixture",
    source: { commit: "a".repeat(40), kind: "git" },
    version: "0.1.0",
  };
  const planValue = {
    applicationId: "neutral.fixture",
    backend: "fram",
    entities: [],
    pluginClosure: [plugin],
    publications: [],
    schemaVersion: 2,
    semanticFingerprint: fingerprint,
    stateMachines: [],
  };
  const plan = `${JSON.stringify(planValue, null, 2)}\n`;
  const planDigest = sha256Digest(plan);
  const manifestValue = {
    applicationId: "neutral.fixture",
    artifacts: {
      browserJavaScript: { path: "app.js", sha256: browserDigest },
      framPlan: { path: "app.fram.json", sha256: planDigest },
    },
    checkedApplication: { fingerprint, schemaVersion: 1 },
    compiler: { name: "wake", sourceCommit: "b".repeat(40), version: "1.0.0" },
    digests: {
      operationSurface: operationDigest,
      stateSchema: `sha256:${"7".repeat(64)}`,
      storageProjection: storageDigest,
    },
    hostCapabilities: [],
    plugins: [plugin],
    protocols: { ...protocols },
    schemaVersion: 1,
  };
  const manifest = canonicalDocument(manifestValue);
  const deploymentReceiptValue = {
    applicationId: "neutral.fixture",
    applicationManifestDigest: sha256Digest(manifest),
    browserJavaScriptDigest: browserDigest,
    framPlanDigest: planDigest,
    schemaVersion: 1,
  };
  const deploymentReceipt = canonicalDocument(deploymentReceiptValue);
  const applicationReceipt = {
    applicationId: "neutral.fixture",
    deploymentArtifactReceiptDigest: sha256Digest(deploymentReceipt),
    operationSurfaceDigest: operationDigest,
    protocols: { ...protocols },
    schemaVersion: 1,
    semanticFingerprint: fingerprint,
    storageProjectionDigest: storageDigest,
  };
  return { applicationReceipt, browserJavaScript, deploymentReceipt, manifest, plan };
}

function runtime(overrides = {}) {
  const calls = { gateway: [], http: [], authorized: [] };
  const fram = {
    query: async () => ({ result: [], servedVersion: 1n }),
    status: async () => ({ result: { state: "ready" }, servedVersion: 1n }),
  };
  const schema = {
    createUnique: async () => ({}),
    transactUnique: async () => ({}),
    updateUnique: async () => ({}),
    updateUniqueMany: async () => ({}),
  };
  const createGateway = (plan, clients) => {
    calls.gateway.push({ clients, plan });
    return { checked: true };
  };
  const createHttpHandler = (gateway, options) => {
    calls.http.push({ gateway, options });
    return async request => {
      const body = await request.json();
      const decision = await options.authorize({
        entity: body.entity,
        op: body.op,
        payload: body,
        request,
        route: new URL(request.url).pathname,
      });
      expect(Object.isFrozen(decision)).toBe(true);
      expect(Object.keys(decision).sort()).toEqual(["actor", "allowed"]);
      return Response.json({ actor: decision.actor.id, allowed: decision.allowed });
    };
  };
  const authorize = context => {
    calls.authorized.push(context);
    return true;
  };
  return {
    ...fixture(),
    authorize,
    calls,
    createGateway,
    createHttpHandler,
    fram,
    schema,
    ...overrides,
  };
}

test("composes only the public FRAM and Wake runtime interfaces", async () => {
  const input = runtime();
  const adapter = createWakeBunAdapter(input);
  expect(adapter.applicationId).toBe("neutral.fixture");
  expect(adapter.semanticFingerprint).toBe(fingerprint);
  expect(input.calls.gateway).toHaveLength(1);
  expect(input.calls.gateway[0].clients.fram).toBe(input.fram);
  expect(input.calls.gateway[0].clients.schema).toBe(input.schema);

  const actor = Object.freeze({ capabilities: Object.freeze(["read"]), id: "principal-1" });
  const response = await adapter.handleOperation(new Request("https://wake.test/api/wake/query", {
    body: JSON.stringify({ entity: "entry", fingerprint, op: "list" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }), { actor, traceId: "trace_0001" });
  expect(await response.json()).toEqual({ actor: "principal-1", allowed: true });
  expect(input.calls.http[0].options.expectedFingerprint).toBe(fingerprint);
  expect(input.calls.authorized).toHaveLength(1);
  expect(input.calls.authorized[0].actor).toBe(actor);
  expect(input.calls.authorized[0].traceId).toBe("trace_0001");
  expect(input.calls.authorized[0].entity).toBe("entry");
});

test("fails construction before runtime composition on plan or receipt drift", () => {
  for (const mutate of [
    input => { input.plan = input.plan.replace(fingerprint, `sha256:${"8".repeat(64)}`); },
    input => { input.plan = input.plan.replace("neutral.fixture", "wrong.fixture"); },
    input => {
      const value = JSON.parse(input.manifest);
      value.artifacts.framPlan.sha256 = `sha256:${"9".repeat(64)}`;
      input.manifest = canonicalDocument(value);
    },
    input => {
      const value = JSON.parse(input.deploymentReceipt);
      value.framPlanDigest = `sha256:${"a".repeat(64)}`;
      input.deploymentReceipt = canonicalDocument(value);
    },
    input => { input.applicationReceipt.semanticFingerprint = `sha256:${"b".repeat(64)}`; },
    input => { input.applicationReceipt.deploymentArtifactReceiptDigest = `sha256:${"c".repeat(64)}`; },
    input => { input.browserJavaScript += "tampered\n"; },
  ]) {
    const input = runtime();
    mutate(input);
    let error;
    try {
      createWakeBunAdapter(input);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WakeAdapterConfigError);
    expect([
      "adapter/artifact-mismatch",
      "adapter/plan-mismatch",
      "adapter/receipt-mismatch",
    ]).toContain(error.code);
    expect(input.calls.gateway).toHaveLength(0);
    expect(input.calls.http).toHaveLength(0);
  }
});

test("readiness reports only a verified FRAM ready status and fails closed", async () => {
  for (const [status, expected] of [
    [async () => ({ result: { state: "ready" } }), true],
    [async () => ({ result: { state: "replaying" } }), false],
    [async () => ({ state: "ready" }), false],
    [async () => { throw new Error("transport secret"); }, false],
  ]) {
    const input = runtime();
    input.fram.status = status;
    const adapter = createWakeBunAdapter(input);
    expect(await adapter.checkReadiness()).toBe(expected);
  }
});

test("operation context is required and authorization is host-derived", async () => {
  const input = runtime();
  const adapter = createWakeBunAdapter(input);
  const request = () => new Request("https://wake.test/api/wake/query", {
    body: JSON.stringify({ entity: "entry", fingerprint, op: "list" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  await expect(
    adapter.handleOperation(request(), { actor: null, traceId: "trace_0001" }),
  ).rejects.toMatchObject({ code: "adapter/invalid-context" });
  await expect(
    adapter.handleOperation(request(), { actor: { id: "principal-1" }, traceId: "" }),
  ).rejects.toMatchObject({ code: "adapter/invalid-context" });
  expect(input.calls.authorized).toHaveLength(0);
});

test("concurrent operations keep their host-derived authority isolated", async () => {
  const pending = [];
  const input = runtime({
    authorize: async context => {
      await new Promise(resolve => pending.push(resolve));
      input.calls.authorized.push(context);
      return true;
    },
  });
  const adapter = createWakeBunAdapter(input);
  const request = identity => adapter.handleOperation(new Request(
    "https://wake.test/api/wake/query",
    {
      body: JSON.stringify({ entity: "entry", fingerprint, op: "list" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  ), {
    actor: Object.freeze({ id: identity }),
    traceId: `trace_${identity}`,
  });
  const first = request("first");
  const second = request("second");
  while (pending.length < 2) await Promise.resolve();
  pending.shift()();
  pending.shift()();
  await Promise.all([first, second]);
  expect(
    input.calls.authorized.map(context => [context.actor.id, context.traceId]).sort(),
  ).toEqual([["first", "trace_first"], ["second", "trace_second"]]);
});
