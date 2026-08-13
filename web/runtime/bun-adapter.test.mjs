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

const term = (tag, value) => [tag, value];
const triple = (t1, t2, t3) => ["triple", t1, t2, t3];

function realFixture({ title = "Wake" } = {}) {
  const value = fixture();
  const identityStorageId = "neutral/field/entry/id";
  const titleStorageId = "neutral/field/entry/title";
  const scoped = item => triple(
    term("keyword", "wake/app"),
    term("keyword", "neutral.fixture"),
    item,
  );
  const subjectTemplate = scoped(triple(
    term("keyword", "entity"),
    term("keyword", "neutral/entity/entry"),
    { field: identityStorageId },
  ));
  const predicate = storageId => scoped(triple(
    term("keyword", "field"),
    term("keyword", "neutral/entity/entry"),
    term("keyword", storageId),
  ));
  const planValue = JSON.parse(value.plan);
  planValue.entities = [{
    name: "entry",
    storageId: "neutral/entity/entry",
    identity: {
      field: "id",
      storageId: identityStorageId,
      type: "String",
      cardinality: "single",
      valueKind: "literal",
      subjectTemplate,
    },
    fields: [
      {
        name: "id",
        storageId: identityStorageId,
        type: "String",
        cardinality: "single",
        valueKind: "literal",
        write: "create",
        predicateTerm: predicate(identityStorageId),
      },
      {
        name: "title",
        storageId: titleStorageId,
        type: "String",
        cardinality: "single",
        valueKind: "literal",
        write: "create",
        predicateTerm: predicate(titleStorageId),
      },
    ],
  }];
  planValue.queries = [{
    name: "browse-entries",
    capabilities: ["wake-wiki/cap/read-published"],
    parameters: [],
    bindings: [{ name: "entry", entity: "entry" }],
    where: [],
    select: [
      {
        name: "id",
        binding: "entry",
        entity: "entry",
        field: "id",
        type: "String",
        cardinality: "single",
        valueKind: "literal",
      },
      {
        name: "title",
        binding: "entry",
        entity: "entry",
        field: "title",
        type: "String",
        cardinality: "single",
        valueKind: "literal",
      },
    ],
    result: { kind: "page", defaultLimit: 1, maxLimit: 2 },
    dependencies: [
      { entity: "entry", field: "id" },
      { entity: "entry", field: "title" },
    ],
    resultProviders: [],
  }];
  planValue.queries.push({
    ...structuredClone(planValue.queries[0]),
    name: "browse-other",
  });
  value.plan = `${JSON.stringify(planValue, null, 2)}\n`;
  const planDigest = sha256Digest(value.plan);
  const manifestValue = JSON.parse(value.manifest);
  manifestValue.artifacts.framPlan.sha256 = planDigest;
  value.manifest = canonicalDocument(manifestValue);
  const deploymentValue = JSON.parse(value.deploymentReceipt);
  deploymentValue.applicationManifestDigest = sha256Digest(value.manifest);
  deploymentValue.framPlanDigest = planDigest;
  value.deploymentReceipt = canonicalDocument(deploymentValue);
  value.applicationReceipt.deploymentArtifactReceiptDigest = sha256Digest(
    value.deploymentReceipt,
  );
  const subject = scoped(triple(
    term("keyword", "entity"),
    term("keyword", "neutral/entity/entry"),
    term("string", "wake"),
  ));
  return {
    ...value,
    cursor: { activeKeyId: "test", keys: { test: new Uint8Array(32) } },
    framResult: {
      page: { done: true, nextCursor: null, ordinal: 0 },
      result: [[subject, term("string", "wake"), term("string", title)]],
      servedVersion: 7n,
    },
  };
}

function reboundFingerprint(value, nextFingerprint) {
  const next = {
    ...value,
    applicationReceipt: { ...value.applicationReceipt },
  };
  next.browserJavaScript = value.browserJavaScript.replace(fingerprint, nextFingerprint);
  const plan = JSON.parse(value.plan);
  plan.semanticFingerprint = nextFingerprint;
  next.plan = `${JSON.stringify(plan, null, 2)}\n`;
  const manifest = JSON.parse(value.manifest);
  manifest.checkedApplication.fingerprint = nextFingerprint;
  manifest.artifacts.browserJavaScript.sha256 = sha256Digest(next.browserJavaScript);
  manifest.artifacts.framPlan.sha256 = sha256Digest(next.plan);
  next.manifest = canonicalDocument(manifest);
  const receipt = JSON.parse(value.deploymentReceipt);
  receipt.applicationManifestDigest = sha256Digest(next.manifest);
  receipt.browserJavaScriptDigest = sha256Digest(next.browserJavaScript);
  receipt.framPlanDigest = sha256Digest(next.plan);
  next.deploymentReceipt = canonicalDocument(receipt);
  next.applicationReceipt.deploymentArtifactReceiptDigest = sha256Digest(next.deploymentReceipt);
  next.applicationReceipt.semanticFingerprint = nextFingerprint;
  return next;
}

function fixture({ providerNames = [] } = {}) {
  const browserClient = "export const wakeClient = true;\n";
  const browserClientDigest = sha256Digest(browserClient);
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
  const planPlugin = {
    alias: plugin.alias,
    artifact_digest: plugin.artifactDigest,
    artifact_path: "artifacts/wake-neutral-fixture-0.1.0.wakepkg.json",
    configuration_digest: plugin.configurationDigest,
    durable_schema_version: plugin.durableSchemaVersion,
    entry_path: "plugin.bjs",
    migration_ordinal: plugin.migrationOrdinal,
    package_id: plugin.packageId,
    source_kind: plugin.source.kind,
    source_revision: plugin.source.commit,
    version: plugin.version,
  };
  const planValue = {
    applicationId: "neutral.fixture",
    backend: "fram",
    composition: {
      extensions: [],
      fills: [],
      mounts: [],
      providers: providerNames.map(name => ({
        name,
        package_id: "wake-neutral-fixture",
        port: `fixture.${name}`,
        port_name: "content-parser",
      })),
    },
    commands: [],
    entities: [],
    pluginClosure: [planPlugin],
    publications: [],
    queries: [],
    schemaVersion: 2,
    semanticFingerprint: fingerprint,
    stateMachines: [],
  };
  const plan = `${JSON.stringify(planValue, null, 2)}\n`;
  const planDigest = sha256Digest(plan);
  const manifestValue = {
    applicationId: "neutral.fixture",
    artifacts: {
      browserClient: { path: "wake-client.js", sha256: browserClientDigest },
      browserJavaScript: { path: "app.js", sha256: browserDigest },
      framPlan: { path: "app.fram.json", sha256: planDigest },
    },
    checkedApplication: { fingerprint, schemaVersion: 1 },
    compiler: { name: "wake", sourceCommit: "b".repeat(40), version: "0.1.0" },
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
    browserClientDigest,
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
  return {
    applicationReceipt,
    browserClient,
    browserJavaScript,
    deploymentReceipt,
    manifest,
    plan,
  };
}

function mutatePluginArtifact(name, mutate) {
  const checked = fixture();
  const value = JSON.parse(checked[name]);
  mutate(value);
  checked[name] = name === "manifest"
    ? canonicalDocument(value)
    : `${JSON.stringify(value, null, 2)}\n`;
  return checked;
}

function runtime(overrides = {}) {
  const calls = { gateway: [], http: [], authorized: [], invoked: [], queried: [] };
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
    return {
      checked: true,
      executeQuery: async (name, input, options, actor) => {
        calls.queried.push({ actor, input, name, options });
        return { input, name, options };
      },
      invoke: async (name, requestId, input, actor) => {
        calls.invoked.push({ actor, input, name, requestId });
        return { actor, input, name, requestId };
      },
    };
  };
  const createHttpHandler = (gateway, options) => {
    calls.http.push({ gateway, options });
    return async request => {
      const body = await request.json();
      const decision = await options.authorize({
        entity: body.entity,
        ...(Object.hasOwn(body, "input") ? { input: body.input } : {}),
        op: body.op,
        ...(Object.hasOwn(body, "options") ? { options: body.options } : {}),
        payload: body,
        ...(Object.hasOwn(body, "query") ? { query: body.query } : {}),
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
  expect(input.calls.gateway[0].clients.providers).toEqual({});
  expect(Object.isFrozen(input.calls.gateway[0].clients.providers)).toBe(true);
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
  expect(input.calls.authorized[0].actor).toEqual(actor);
  expect(Object.isFrozen(input.calls.authorized[0].actor)).toBe(true);
  expect(input.calls.authorized[0].traceId).toBe("trace_0001");
  expect(input.calls.authorized[0].entity).toBe("entry");
});

test("binds distinct compiler plugin schemas and rejects closure drift", () => {
  const accepted = runtime();
  createWakeBunAdapter(accepted);
  expect(accepted.calls.gateway).toHaveLength(1);

  for (const [changed, code] of [
    [mutatePluginArtifact("manifest", value => { delete value.plugins[0].configuration; }),
      "adapter/invalid-manifest"],
    [mutatePluginArtifact("manifest", value => { value.plugins[0].unexpected = true; }),
      "adapter/invalid-manifest"],
    [mutatePluginArtifact("plan", value => { delete value.pluginClosure[0].entry_path; }),
      "adapter/invalid-plan"],
    [mutatePluginArtifact("plan", value => { value.pluginClosure[0].unexpected = true; }),
      "adapter/invalid-plan"],
    [mutatePluginArtifact("manifest", value => { value.plugins.push(value.plugins[0]); }),
      "adapter/invalid-manifest"],
    [mutatePluginArtifact("plan", value => { value.pluginClosure.push(value.pluginClosure[0]); }),
      "adapter/invalid-plan"],
    [mutatePluginArtifact("manifest", value => {
      value.plugins[0].artifactDigest = `sha256:${"8".repeat(64)}`;
    }), "adapter/plan-mismatch"],
  ]) {
    const rejected = runtime(changed);
    expect(() => createWakeBunAdapter(rejected)).toThrow(
      expect.objectContaining({ code }),
    );
    expect(rejected.calls.gateway).toHaveLength(0);
  }
});

test("requires and freezes the exact checked provider registry before composition", () => {
  const providerName = "greywrought-markdown";
  const provider = () => ({ html: "<p>Greywrought</p>" });
  const checked = fixture({ providerNames: [providerName] });
  const input = runtime({
    ...checked,
    providers: { [providerName]: provider },
  });
  createWakeBunAdapter(input);

  expect(input.calls.gateway).toHaveLength(1);
  const registry = input.calls.gateway[0].clients.providers;
  expect(Object.getPrototypeOf(registry)).toBeNull();
  expect(Object.isFrozen(registry)).toBe(true);
  expect(Reflect.ownKeys(registry)).toEqual([providerName]);
  expect(registry[providerName]).toBe(provider);

  for (const [providers, code] of [
    [undefined, "adapter/provider-registry-mismatch"],
    [{}, "adapter/provider-registry-mismatch"],
    [{ [providerName]: provider, unexpected: provider }, "adapter/provider-registry-mismatch"],
    [{ [providerName]: { parse: provider } }, "adapter/invalid-provider"],
  ]) {
    const rejected = runtime({ ...checked, providers });
    expect(() => createWakeBunAdapter(rejected)).toThrow(
      expect.objectContaining({ code }),
    );
    expect(rejected.calls.gateway).toHaveLength(0);
    expect(rejected.calls.http).toHaveLength(0);
  }

  let getterCalled = false;
  const accessorRegistry = {};
  Object.defineProperty(accessorRegistry, providerName, {
    enumerable: true,
    get() {
      getterCalled = true;
      return provider;
    },
  });
  const rejectedAccessor = runtime({ ...checked, providers: accessorRegistry });
  expect(() => createWakeBunAdapter(rejectedAccessor)).toThrow(
    expect.objectContaining({ code: "adapter/invalid-provider" }),
  );
  expect(getterCalled).toBe(false);
  expect(rejectedAccessor.calls.gateway).toHaveLength(0);
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
    input => { input.browserClient += "tampered\n"; },
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

test("HTTP authorization receives an immutable snapshot separate from dispatch", async () => {
  const input = runtime({
    authorize: context => {
      input.calls.authorized.push(context);
      expect(Object.isFrozen(context.payload)).toBe(true);
      expect(Object.isFrozen(context.input)).toBe(true);
      expect(Object.isFrozen(context.input.nested)).toBe(true);
      try { context.input.nested.value = "mutated"; } catch {}
      try { context.payload.query = "mutated"; } catch {}
      return true;
    },
  });
  const adapter = createWakeBunAdapter(input);
  await adapter.handleOperation(new Request("https://wake.test/api/wake/query", {
    body: JSON.stringify({
      fingerprint,
      input: { nested: { value: "checked" } },
      op: "execute",
      options: {},
      query: "find-entry",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }), {
    actor: { id: "principal-1" },
    traceId: "trace_http_snapshot",
  });
  expect(input.calls.authorized[0].input).toEqual({ nested: { value: "checked" } });
  expect(input.calls.authorized[0].payload.query).toBe("find-entry");
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

test("forwards only a closed host authorization decision actor", async () => {
  const mappedActor = Object.freeze({
    capabilities: Object.freeze(["wake-wiki/cap/read-published"]),
    id: "principal-1",
  });
  const input = runtime({
    authorize: context => {
      input.calls.authorized.push(context);
      return Object.freeze({ actor: mappedActor, allowed: true });
    },
  });
  const adapter = createWakeBunAdapter(input);
  const response = await adapter.handleOperation(new Request(
    "https://wake.test/api/wake/query",
    {
      body: JSON.stringify({ entity: "entry", fingerprint, op: "list" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  ), {
    actor: Object.freeze({ capabilities: Object.freeze(["wiki.article.read"]), id: "principal-1" }),
    traceId: "trace_mapped",
  });

  expect(await response.json()).toEqual({ actor: "principal-1", allowed: true });
  const decision = await input.calls.http[0].options.authorize({ op: "list" });
  expect(decision.actor).toEqual(mappedActor);
  expect(Object.isFrozen(decision.actor)).toBe(true);
  expect(Object.isFrozen(decision)).toBe(true);

  for (const invalid of [
    { actor: mappedActor, allowed: true, extra: true },
    { actor: null, allowed: true },
    { actor: mappedActor, allowed: "yes" },
  ]) {
    const deniedInput = runtime({ authorize: () => invalid });
    const deniedAdapter = createWakeBunAdapter(deniedInput);
    await deniedAdapter.handleOperation(new Request(
      "https://wake.test/api/wake/query",
      {
        body: JSON.stringify({ entity: "entry", fingerprint, op: "list" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    ), {
      actor: Object.freeze({ id: "principal-1" }),
      traceId: "trace_invalid_decision",
    });
    const denied = await deniedInput.calls.http[0].options.authorize({ op: "list" });
    expect(denied.allowed).toBe(false);
  }
});

test("direct query and command calls authorize before the gateway with mapped authority", async () => {
  const mappedActor = Object.freeze({
    capabilities: Object.freeze(["wiki.article.read"]),
    id: "mapped-principal",
  });
  const input = runtime({
    authorize: context => {
      input.calls.authorized.push(context);
      return Object.freeze({ actor: mappedActor, allowed: true });
    },
  });
  const adapter = createWakeBunAdapter(input);
  const actor = Object.freeze({ id: "host-principal" });
  const context = Object.freeze({ actor, traceId: "trace_direct" });

  await adapter.executeQuery("find-entry", { id: "entry-1" }, { asOf: "7" }, context);
  await adapter.invokeCommand("publish-entry", "request-1", { id: "entry-1" }, context);

  expect(input.calls.authorized).toHaveLength(2);
  expect(input.calls.authorized[0]).toEqual({
    actor,
    input: { id: "entry-1" },
    kind: "query",
    name: "find-entry",
    op: "execute",
    options: { asOf: "7" },
    query: "find-entry",
    surface: "direct",
    traceId: "trace_direct",
  });
  expect(input.calls.authorized[1]).toEqual({
    actor,
    command: "publish-entry",
    kind: "command",
    name: "publish-entry",
    op: "invoke",
    requestId: "request-1",
    surface: "direct",
    traceId: "trace_direct",
  });
  expect(input.calls.authorized.every(Object.isFrozen)).toBe(true);
  expect(input.calls.queried[0].actor).toEqual(mappedActor);
  expect(input.calls.invoked[0].actor).toEqual(mappedActor);
  expect(Object.isFrozen(input.calls.queried[0].actor)).toBe(true);

  for (const authorize of [() => false, () => { throw new Error("secret"); }]) {
    const denied = runtime({ authorize });
    const deniedAdapter = createWakeBunAdapter(denied);
    await expect(deniedAdapter.executeQuery("find-entry", {}, {}, context))
      .rejects.toMatchObject({ code: "adapter/forbidden" });
    await expect(deniedAdapter.invokeCommand("publish-entry", "request-2", {}, context))
      .rejects.toMatchObject({ code: "adapter/forbidden" });
    expect(denied.calls.queried).toHaveLength(0);
    expect(denied.calls.invoked).toHaveLength(0);
  }
});

test("direct authorization snapshots nested input and actor authority across awaits", async () => {
  let releaseAuthorization;
  const authorizationGate = new Promise(resolve => { releaseAuthorization = resolve; });
  let releaseGateway;
  const gatewayGate = new Promise(resolve => { releaseGateway = resolve; });
  let notifyGateway;
  const gatewayStarted = new Promise(resolve => { notifyGateway = resolve; });
  const mappedActor = { capabilities: ["wiki.article.read"], id: "mapped-principal" };
  const dispatched = [];
  const input = runtime({
    authorize: async context => {
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.input)).toBe(true);
      expect(Object.isFrozen(context.input.nested)).toBe(true);
      expect(Object.isFrozen(context.actor)).toBe(true);
      await authorizationGate;
      return { actor: mappedActor, allowed: true };
    },
    createGateway: () => ({
      async executeQuery(name, queryInput, options, actor) {
        notifyGateway();
        await gatewayGate;
        dispatched.push({ actor, input: queryInput, name, options });
        return {};
      },
      invoke: async () => ({}),
    }),
  });
  const adapter = createWakeBunAdapter(input);
  const queryInput = { nested: { value: "checked" } };
  const options = { asOf: "7" };
  const actor = { id: "host-principal", nested: { tenant: "checked" } };
  const pending = adapter.executeQuery(
    "find-entry",
    queryInput,
    options,
    { actor, traceId: "trace_snapshot" },
  );
  queryInput.nested.value = "mutated";
  options.asOf = "99";
  actor.nested.tenant = "mutated";
  releaseAuthorization();
  await gatewayStarted;
  mappedActor.id = "mutated";
  mappedActor.capabilities.push("admin");
  releaseGateway();
  await pending;
  expect(dispatched).toEqual([{
    actor: { capabilities: ["wiki.article.read"], id: "mapped-principal" },
    input: { nested: { value: "checked" } },
    name: "find-entry",
    options: { asOf: "7" },
  }]);
  expect(Object.isFrozen(dispatched[0].actor)).toBe(true);
});

test("direct paged queries seal and validate opaque continuation cursors", async () => {
  let clock = 1_000;
  let scope = "principal-1:wiki.article.read";
  const gatewayCalls = [];
  const checked = realFixture();
  checked.cursor = {
    ...checked.cursor,
    now: () => clock,
    ttlMs: 1_000,
  };
  const input = runtime({
    ...checked,
    authorize: () => Object.freeze({
      actor: Object.freeze({
        capabilities: Object.freeze(["wiki.article.read"]),
        id: "principal-1",
      }),
      allowed: true,
      authorizationScope: scope,
    }),
    createGateway: () => ({
      async executeQuery(name, queryInput, options, actor) {
        gatewayCalls.push({ actor, input: queryInput, name, options });
        return gatewayCalls.length === 1
          ? {
              page: { done: false, nextCursor: term("string", "raw-next"), ordinal: 0 },
              rows: [{ id: "wake" }],
              servedVersion: 7n,
            }
          : {
              page: { done: true, nextCursor: null, ordinal: 1 },
              rows: [],
              servedVersion: 7n,
            };
      },
      invoke: async () => ({}),
    }),
  });
  const adapter = createWakeBunAdapter(input);
  const context = Object.freeze({ actor: Object.freeze({ id: "principal-1" }), traceId: "trace_page" });
  const first = await adapter.executeQuery("browse-entries", {}, { limit: 1 }, context);
  expect(typeof first.page.nextCursor).toBe("string");
  expect(first.page.nextCursor).not.toContain("raw-next");

  const token = first.page.nextCursor;
  await adapter.executeQuery("browse-entries", {}, { cursor: token, limit: 1 }, context);
  expect(gatewayCalls[1].options).toEqual({
    asOf: 7n,
    cursor: term("string", "raw-next"),
    limit: 1,
  });

  for (const attempt of [
    () => ({ mutate: () => { scope = "other-principal"; }, name: "browse-entries", input: {}, limit: 1, token }),
    () => ({ mutate: () => { scope = "principal-1:wiki.article.read"; }, name: "browse-other", input: {}, limit: 1, token }),
    () => ({ mutate: () => {}, name: "unknown-query", input: {}, limit: 1, token }),
    () => ({ mutate: () => {}, name: "browse-entries", input: { changed: true }, limit: 1, token }),
    () => ({ mutate: () => {}, name: "browse-entries", input: {}, limit: 2, token }),
    () => ({
      mutate: () => {},
      name: "browse-entries",
      input: {},
      limit: 1,
      token: `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`,
    }),
  ]) {
    const attemptValue = attempt();
    attemptValue.mutate();
    const before = gatewayCalls.length;
    await expect(adapter.executeQuery(
      attemptValue.name,
      attemptValue.input,
      { cursor: attemptValue.token, limit: attemptValue.limit },
      context,
    )).rejects.toMatchObject({ code: "invalid_cursor" });
    expect(gatewayCalls).toHaveLength(before);
  }

  scope = "principal-1:wiki.article.read";
  clock = 2_000;
  await expect(adapter.executeQuery(
    "browse-entries",
    {},
    { cursor: token, limit: 1 },
    context,
  )).rejects.toMatchObject({ code: "invalid_cursor" });
  expect(gatewayCalls).toHaveLength(2);

  clock = 1_000;
  const foreignCalls = [];
  const foreign = reboundFingerprint(realFixture(), `sha256:${"2".repeat(64)}`);
  foreign.cursor = { ...foreign.cursor, now: () => clock, ttlMs: 1_000 };
  const foreignAdapter = createWakeBunAdapter(runtime({
    ...foreign,
    authorize: () => Object.freeze({
      actor: Object.freeze({
        capabilities: Object.freeze(["wiki.article.read"]),
        id: "principal-1",
      }),
      allowed: true,
      authorizationScope: scope,
    }),
    createGateway: () => ({
      executeQuery: async (...args) => { foreignCalls.push(args); return {}; },
      invoke: async () => ({}),
    }),
  }));
  await expect(foreignAdapter.executeQuery(
    "browse-entries",
    {},
    { cursor: token, limit: 1 },
    context,
  )).rejects.toMatchObject({ code: "invalid_cursor" });
  expect(foreignCalls).toHaveLength(0);
});

test("runs a fingerprinted named query through the real HTTP and FRAM boundary", async () => {
  const checked = realFixture();
  const framCalls = [];
  const authorized = [];
  const mappedActor = Object.freeze({
    capabilities: Object.freeze(["wake-wiki/cap/read-published"]),
    id: "principal-1",
  });
  const adapter = createWakeBunAdapter({
    ...checked,
    authorize(context) {
      authorized.push(context);
      return Object.freeze({ actor: mappedActor, allowed: true });
    },
    fram: {
      async query(query, options) {
        framCalls.push({ options, query });
        return checked.framResult;
      },
      status: async () => ({ result: { state: "ready" }, servedVersion: 7n }),
    },
    schema: {
      createUnique: async () => ({}),
      transactUnique: async () => ({}),
      updateUnique: async () => ({}),
      updateUniqueMany: async () => ({}),
    },
  });
  const actor = Object.freeze({
    capabilities: Object.freeze(["wiki.article.read"]),
    id: "principal-1",
  });
  const request = body => new Request("https://wake.test/api/wake/query", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const payload = {
    fingerprint,
    op: "execute",
    query: "browse-entries",
    input: {},
    options: { limit: 1 },
  };

  const response = await adapter.handleOperation(request(payload), {
    actor,
    traceId: "trace_real",
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(
    '{"rows":[{"id":"wake","title":"Wake"}],"page":{"done":true,"nextCursor":null},"servedVersion":"7"}',
  );
  expect(framCalls).toHaveLength(1);
  expect(framCalls[0].options).toEqual({ page: { limit: 1 }, timeoutMs: 5_000 });
  expect(authorized).toHaveLength(1);
  expect(authorized[0].actor).toEqual(actor);
  expect(Object.isFrozen(authorized[0].actor)).toBe(true);
  expect(authorized[0].traceId).toBe("trace_real");
  expect(authorized[0].query).toBe("browse-entries");

  const stale = await adapter.handleOperation(request({
    ...payload,
    fingerprint: `sha256:${"9".repeat(64)}`,
  }), { actor, traceId: "trace_stale" });
  expect(stale.status).toBe(409);
  expect(await stale.text()).toBe(
    '{"error":{"code":"application_mismatch","message":"Request fingerprint does not match the deployed application."}}',
  );
  expect(authorized).toHaveLength(1);
  expect(framCalls).toHaveLength(1);
});

test("enforces exact Wake request and response byte ceilings through the adapter", async () => {
  const actor = Object.freeze({
    capabilities: Object.freeze(["wake-wiki/cap/read-published"]),
    id: "principal-1",
  });
  const request = body => new Request("https://wake.test/api/wake/query", {
    body,
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const createAdapter = title => {
    const checked = realFixture({ title });
    return createWakeBunAdapter({
      ...checked,
      authorize: () => true,
      fram: {
        query: async () => checked.framResult,
        status: async () => ({ result: { state: "ready" }, servedVersion: 7n }),
      },
      schema: {
        createUnique: async () => ({}),
        transactUnique: async () => ({}),
        updateUnique: async () => ({}),
        updateUniqueMany: async () => ({}),
      },
    });
  };
  const payload = title => JSON.stringify({
    fingerprint,
    op: "execute",
    query: "browse-entries",
    input: { padding: title },
  });
  const base = payload("");
  const exactRequest = payload("x".repeat(64 * 1024 - new TextEncoder().encode(base).byteLength));
  expect(new TextEncoder().encode(exactRequest).byteLength).toBe(64 * 1024);
  const exactResponse = await createAdapter("Wake").handleOperation(request(exactRequest), {
    actor,
    traceId: "trace_request_exact",
  });
  expect(exactResponse.status).toBe(400);
  expect((await exactResponse.json()).error.code).toBe("gateway/invalid-input");

  const requestOver = await createAdapter("Wake").handleOperation(
    request(`${exactRequest} `),
    { actor, traceId: "trace_request_over" },
  );
  expect(requestOver.status).toBe(413);
  expect((await requestOver.json()).error.code).toBe("payload_too_large");

  const responseEnvelopeBytes = new TextEncoder().encode(
    '{"rows":[{"id":"wake","title":""}],"page":{"done":true,"nextCursor":null},"servedVersion":"7"}',
  ).byteLength;
  const exactTitle = "x".repeat(256 * 1024 - responseEnvelopeBytes);
  const queryBody = JSON.stringify({
    fingerprint,
    op: "execute",
    query: "browse-entries",
    input: {},
  });
  const responseExact = await createAdapter(exactTitle).handleOperation(request(queryBody), {
    actor,
    traceId: "trace_response_exact",
  });
  expect(responseExact.status).toBe(200);
  expect(new TextEncoder().encode(await responseExact.text()).byteLength).toBe(256 * 1024);

  const responseOver = await createAdapter(`${exactTitle}x`).handleOperation(request(queryBody), {
    actor,
    traceId: "trace_response_over",
  });
  expect(responseOver.status).toBe(500);
  expect(await responseOver.text()).toBe(
    '{"error":{"code":"response_too_large","message":"Gateway response exceeds the encoded-byte limit."}}',
  );
});
