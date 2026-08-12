import { canonicalDocument, sha256Digest } from "./canonical.mjs";
import {
  createWakeCursorProvider,
  createWakeCursorTransport,
} from "./cursor-provider.mjs";
import { createFramGateway } from "./fram-gateway.mjs";
import { createWakeHttpHandler } from "./fram-http.mjs";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const EXPECTED_PROTOCOLS = Object.freeze({
  framPlanSchemaVersion: 2,
  httpOperationProtocolVersion: 2,
  pluginAbiVersion: 1,
});

export class WakeAdapterConfigError extends Error {
  constructor(code, message, detail = undefined) {
    super(message);
    this.name = "WakeAdapterConfigError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

function fail(code, message, detail) {
  throw new WakeAdapterConfigError(code, message, detail);
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys, label) {
  if (!plainObject(value) || Object.keys(value).length !== keys.length
      || keys.some(key => !Object.hasOwn(value, key))) {
    fail("adapter/invalid-config", `${label} has an invalid shape`);
  }
}

function nonempty(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail("adapter/invalid-config", `${label} must be a nonempty string`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("adapter/invalid-config", `${label} must be a sha256 digest`);
  }
  return value;
}

function documentArtifact(input, label, { canonical = false } = {}) {
  const bytes = input instanceof Uint8Array
    ? input.slice()
    : typeof input === "string"
      ? new TextEncoder().encode(input)
      : null;
  if (bytes === null) {
    fail("adapter/invalid-config", `${label} must be exact UTF-8 bytes or text`);
  }
  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    fail("adapter/invalid-config", `${label} must contain valid UTF-8 JSON`);
  }
  if (canonical && text !== canonicalDocument(value)) {
    fail("adapter/invalid-config", `${label} must be canonical JSON`);
  }
  return Object.freeze({ bytes, value });
}

function applicationManifest(input) {
  const artifact = documentArtifact(input, "manifest", { canonical: true });
  const value = artifact.value;
  if (!plainObject(value) || value.schemaVersion !== 1) {
    fail("adapter/invalid-manifest", "expected a Wake application manifest with schemaVersion 1");
  }
  nonempty(value.applicationId, "manifest.applicationId");
  if (!plainObject(value.checkedApplication) || value.checkedApplication.schemaVersion !== 1) {
    fail("adapter/invalid-manifest", "manifest.checkedApplication is invalid");
  }
  digest(value.checkedApplication.fingerprint, "manifest.checkedApplication.fingerprint");
  if (!plainObject(value.protocols)) {
    fail("adapter/invalid-manifest", "manifest.protocols is invalid");
  }
  exactKeys(value.protocols, Object.keys(EXPECTED_PROTOCOLS), "manifest.protocols");
  for (const [name, expected] of Object.entries(EXPECTED_PROTOCOLS)) {
    if (value.protocols[name] !== expected) {
      fail("adapter/protocol-mismatch", `manifest.protocols.${name} must be ${expected}`);
    }
  }
  if (!plainObject(value.artifacts)
      || !plainObject(value.artifacts.browserClient)
      || !plainObject(value.artifacts.browserJavaScript)
      || !plainObject(value.artifacts.framPlan)) {
    fail("adapter/invalid-manifest", "manifest.artifacts is invalid");
  }
  digest(value.artifacts.browserClient.sha256, "manifest browser client artifact digest");
  digest(value.artifacts.browserJavaScript.sha256, "manifest browser artifact digest");
  digest(value.artifacts.framPlan.sha256, "manifest FRAM plan digest");
  if (!plainObject(value.digests)) {
    fail("adapter/invalid-manifest", "manifest.digests is invalid");
  }
  digest(value.digests.operationSurface, "manifest operation surface digest");
  digest(value.digests.storageProjection, "manifest storage projection digest");
  if (!Array.isArray(value.plugins)) {
    fail("adapter/invalid-manifest", "manifest.plugins must be an array");
  }
  if (!Array.isArray(value.hostCapabilities)
      || value.hostCapabilities.some(capability => typeof capability !== "string"
        || capability.length === 0)) {
    fail("adapter/invalid-manifest", "manifest.hostCapabilities must contain names");
  }
  return Object.freeze({ ...artifact, value: structuredClone(value) });
}

function framPlan(input) {
  const artifact = documentArtifact(input, "plan");
  const value = artifact.value;
  if (!plainObject(value) || value.schemaVersion !== EXPECTED_PROTOCOLS.framPlanSchemaVersion
      || value.backend !== "fram" || !Array.isArray(value.pluginClosure)
      || !Array.isArray(value.queries) || !Array.isArray(value.commands)) {
    fail("adapter/invalid-plan", "expected the current Wake FRAM application plan");
  }
  nonempty(value.applicationId, "plan.applicationId");
  digest(value.semanticFingerprint, "plan.semanticFingerprint");
  return Object.freeze({ ...artifact, value: structuredClone(value) });
}

function deploymentReceipt(input) {
  const artifact = documentArtifact(input, "deploymentReceipt", { canonical: true });
  const value = artifact.value;
  exactKeys(value, [
    "applicationId",
    "applicationManifestDigest",
    "browserClientDigest",
    "browserJavaScriptDigest",
    "framPlanDigest",
    "schemaVersion",
  ], "deploymentReceipt");
  if (value.schemaVersion !== 1) {
    fail("adapter/invalid-receipt", "deploymentReceipt.schemaVersion must be 1");
  }
  nonempty(value.applicationId, "deploymentReceipt.applicationId");
  digest(value.applicationManifestDigest, "deploymentReceipt.applicationManifestDigest");
  digest(value.browserClientDigest, "deploymentReceipt.browserClientDigest");
  digest(value.browserJavaScriptDigest, "deploymentReceipt.browserJavaScriptDigest");
  digest(value.framPlanDigest, "deploymentReceipt.framPlanDigest");
  return Object.freeze({ ...artifact, value: structuredClone(value) });
}

function applicationReceipt(value) {
  if (!plainObject(value)) {
    fail("adapter/invalid-receipt", "applicationReceipt must be an object");
  }
  exactKeys(value, [
    "applicationId",
    "deploymentArtifactReceiptDigest",
    "operationSurfaceDigest",
    "protocols",
    "schemaVersion",
    "semanticFingerprint",
    "storageProjectionDigest",
  ], "applicationReceipt");
  if (value.schemaVersion !== 1) {
    fail("adapter/invalid-receipt", "applicationReceipt.schemaVersion must be 1");
  }
  nonempty(value.applicationId, "applicationReceipt.applicationId");
  digest(value.deploymentArtifactReceiptDigest, "applicationReceipt deployment digest");
  digest(value.operationSurfaceDigest, "applicationReceipt operation digest");
  digest(value.semanticFingerprint, "applicationReceipt semantic fingerprint");
  digest(value.storageProjectionDigest, "applicationReceipt storage digest");
  if (!plainObject(value.protocols)) {
    fail("adapter/invalid-receipt", "applicationReceipt.protocols is invalid");
  }
  exactKeys(
    value.protocols,
    Object.keys(EXPECTED_PROTOCOLS),
    "applicationReceipt.protocols",
  );
  for (const [name, expected] of Object.entries(EXPECTED_PROTOCOLS)) {
    if (value.protocols[name] !== expected) {
      fail("adapter/receipt-mismatch", `applicationReceipt.protocols.${name} must be ${expected}`);
    }
  }
  return structuredClone(value);
}

function assertSame(actual, expected, code, label) {
  if (actual !== expected) fail(code, `${label} does not match the checked application`);
}

function assertArtifactBinding({ manifestArtifact, planArtifact, receiptArtifact, installed }) {
  const manifest = manifestArtifact.value;
  const plan = planArtifact.value;
  const receipt = receiptArtifact.value;
  const manifestDigest = sha256Digest(manifestArtifact.bytes);
  const planDigest = sha256Digest(planArtifact.bytes);
  const receiptDigest = sha256Digest(receiptArtifact.bytes);

  assertSame(plan.applicationId, manifest.applicationId, "adapter/plan-mismatch", "plan applicationId");
  assertSame(
    plan.semanticFingerprint,
    manifest.checkedApplication.fingerprint,
    "adapter/plan-mismatch",
    "plan semantic fingerprint",
  );
  assertSame(
    planDigest,
    manifest.artifacts.framPlan.sha256,
    "adapter/plan-mismatch",
    "plan artifact digest",
  );
  assertSame(
    canonicalDocument(plan.pluginClosure),
    canonicalDocument(manifest.plugins),
    "adapter/plan-mismatch",
    "plan plugin closure",
  );

  assertSame(receipt.applicationId, manifest.applicationId, "adapter/receipt-mismatch", "receipt applicationId");
  assertSame(
    receipt.applicationManifestDigest,
    manifestDigest,
    "adapter/receipt-mismatch",
    "receipt manifest digest",
  );
  assertSame(
    receipt.browserClientDigest,
    manifest.artifacts.browserClient.sha256,
    "adapter/receipt-mismatch",
    "receipt browser client digest",
  );
  assertSame(
    receipt.browserJavaScriptDigest,
    manifest.artifacts.browserJavaScript.sha256,
    "adapter/receipt-mismatch",
    "receipt browser digest",
  );
  assertSame(
    receipt.framPlanDigest,
    planDigest,
    "adapter/receipt-mismatch",
    "receipt FRAM plan digest",
  );

  assertSame(installed.applicationId, manifest.applicationId, "adapter/receipt-mismatch", "installed applicationId");
  assertSame(
    installed.semanticFingerprint,
    manifest.checkedApplication.fingerprint,
    "adapter/receipt-mismatch",
    "installed semantic fingerprint",
  );
  assertSame(
    installed.deploymentArtifactReceiptDigest,
    receiptDigest,
    "adapter/receipt-mismatch",
    "installed deployment receipt digest",
  );
  assertSame(
    installed.operationSurfaceDigest,
    manifest.digests?.operationSurface,
    "adapter/receipt-mismatch",
    "installed operation surface digest",
  );
  assertSame(
    installed.storageProjectionDigest,
    manifest.digests?.storageProjection,
    "adapter/receipt-mismatch",
    "installed storage projection digest",
  );

  return Object.freeze({ manifestDigest, planDigest, receiptDigest });
}

function checkedProviderRegistry(plan, input) {
  if (!plainObject(plan.composition) || !Array.isArray(plan.composition.providers)) {
    fail("adapter/invalid-plan", "plan.composition.providers must be an array");
  }

  const names = [];
  for (const binding of plan.composition.providers) {
    if (!plainObject(binding) || typeof binding.name !== "string" || binding.name.length === 0) {
      fail("adapter/invalid-plan", "plan.composition.providers contains an invalid binding");
    }
    if (names.includes(binding.name)) {
      fail(
        "adapter/invalid-plan",
        `plan.composition.providers repeats binding '${binding.name}'`,
      );
    }
    names.push(binding.name);
  }

  const registry = input === undefined ? {} : input;
  if (!plainObject(registry)) {
    fail("adapter/invalid-provider-registry", "providers must be an object");
  }
  const expected = new Set(names);
  const actualKeys = Reflect.ownKeys(registry);
  const missing = names.filter(name => !Object.hasOwn(registry, name));
  const extra = actualKeys.filter(key => typeof key !== "string" || !expected.has(key));
  if (missing.length > 0 || extra.length > 0) {
    fail(
      "adapter/provider-registry-mismatch",
      "providers must exactly match the checked provider bindings",
      Object.freeze({
        expected: Object.freeze([...names]),
        extra: Object.freeze(extra.map(String)),
        missing: Object.freeze(missing),
      }),
    );
  }

  const checked = Object.create(null);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(registry, name);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable
        || typeof descriptor.value !== "function") {
      fail(
        "adapter/invalid-provider",
        `provider '${name}' must be an enumerable function value`,
      );
    }
    Object.defineProperty(checked, name, {
      enumerable: true,
      value: descriptor.value,
    });
  }
  return Object.freeze(checked);
}

function checkedContext(value, operation = "operation") {
  if (!plainObject(value) || Reflect.ownKeys(value).length !== 2
      || !Object.hasOwn(value, "actor") || !Object.hasOwn(value, "traceId")
      || !plainObject(value.actor)
      || typeof value.traceId !== "string" || value.traceId.length === 0) {
    fail("adapter/invalid-context", `${operation} requires actor and traceId context`);
  }
  let actor;
  try {
    actor = structuredClone(value.actor);
  } catch {
    fail("adapter/invalid-context", `${operation} actor must be structured-cloneable`);
  }
  return Object.freeze({ actor: freezeTree(actor), traceId: value.traceId });
}

function freezeTree(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) freezeTree(value[key], seen);
  return Object.freeze(value);
}

function checkedAuthorizationDecision(value, actor) {
  if (value === true) return Object.freeze({ allowed: true, actor });
  const keys = plainObject(value) ? Reflect.ownKeys(value) : [];
  if (!plainObject(value) || !Object.hasOwn(value, "allowed")
      || !Object.hasOwn(value, "actor") || keys.length < 2 || keys.length > 3
      || keys.some(key => !["allowed", "actor", "authorizationScope"].includes(key))
      || typeof value.allowed !== "boolean" || !plainObject(value.actor)
      || typeof value.actor.id !== "string" || value.actor.id.length === 0
      || !Array.isArray(value.actor.capabilities)
      || value.actor.capabilities.some(capability => typeof capability !== "string"
        || capability.length === 0)
      || new Set(value.actor.capabilities).size !== value.actor.capabilities.length
      || (Object.hasOwn(value, "authorizationScope")
        && (typeof value.authorizationScope !== "string"
          || value.authorizationScope.length === 0))) {
    return Object.freeze({ allowed: false, actor });
  }
  let mappedActor;
  try {
    mappedActor = freezeTree(structuredClone(value.actor));
  } catch {
    return Object.freeze({ allowed: false, actor });
  }
  const decision = { allowed: value.allowed, actor: mappedActor };
  if (Object.hasOwn(value, "authorizationScope")) {
    decision.authorizationScope = value.authorizationScope;
  }
  return Object.freeze(decision);
}

function bytesArtifact(input, label) {
  const bytes = input instanceof Uint8Array
    ? input.slice()
    : typeof input === "string"
      ? new TextEncoder().encode(input)
      : null;
  if (bytes === null) fail("adapter/invalid-config", `${label} must be a string or Uint8Array`);
  return bytes;
}

function pagedQueries(plan) {
  const names = new Set();
  for (const query of plan.queries) {
    if (plainObject(query) && plainObject(query.result) && query.result.kind === "page") {
      names.add(nonempty(query.name, "paged query name"));
    }
  }
  return names;
}

function httpAuthorizationSnapshot(operation, actor, traceId) {
  if (!plainObject(operation)) {
    fail("adapter/invalid-config", "Wake HTTP supplied an invalid authorization operation");
  }
  const snapshot = {};
  for (const key of Reflect.ownKeys(operation)) {
    if (typeof key !== "string") {
      fail("adapter/invalid-config", "Wake HTTP supplied an invalid authorization operation");
    }
    snapshot[key] = key === "request"
      ? operation[key]
      : freezeTree(structuredClone(operation[key]));
  }
  snapshot.actor = actor;
  snapshot.traceId = traceId;
  return Object.freeze(snapshot);
}

/**
 * Composes Wake's checked artifacts and public FRAM clients into a
 * runtime-neutral application adapter. Authentication stays in the host; this
 * boundary accepts only the derived actor context and never reads credentials
 * from request headers.
 */
export function createWakeApplicationAdapter({
  applicationReceipt: installedReceipt,
  authorize,
  browserClient,
  browserJavaScript,
  createGateway = createFramGateway,
  createHttpHandler = createWakeHttpHandler,
  cursor,
  deploymentReceipt: artifactReceipt,
  fram,
  manifest: manifestInput,
  plan: planInput,
  providers,
  schema,
  serverValues,
} = {}) {
  if (!fram || typeof fram.status !== "function" || typeof fram.query !== "function") {
    fail("adapter/invalid-client", "the official FRAM client must provide status and query");
  }
  if (!schema || typeof schema.createUnique !== "function"
      || typeof schema.transactUnique !== "function"
      || typeof schema.updateUnique !== "function"
      || typeof schema.updateUniqueMany !== "function") {
    fail("adapter/invalid-client", "the official FRAM schema client is incomplete");
  }
  if (typeof authorize !== "function") {
    fail("adapter/invalid-config", "authorize must be a function");
  }
  if (typeof createGateway !== "function" || typeof createHttpHandler !== "function") {
    fail("adapter/invalid-config", "runtime factories must be functions");
  }

  const manifestArtifact = applicationManifest(manifestInput);
  const planArtifact = framPlan(planInput);
  const receiptArtifact = deploymentReceipt(artifactReceipt);
  const manifest = manifestArtifact.value;
  const plan = planArtifact.value;
  const installed = applicationReceipt(installedReceipt);
  const artifacts = assertArtifactBinding({
    installed,
    manifestArtifact,
    planArtifact,
    receiptArtifact,
  });
  const providerRegistry = checkedProviderRegistry(plan, providers);
  const browserClientBytes = bytesArtifact(browserClient, "browserClient");
  const browserBytes = bytesArtifact(browserJavaScript, "browserJavaScript");
  assertSame(
    sha256Digest(browserClientBytes),
    manifest.artifacts.browserClient.sha256,
    "adapter/artifact-mismatch",
    "browser client digest",
  );
  assertSame(
    sha256Digest(browserBytes),
    manifest.artifacts.browserJavaScript.sha256,
    "adapter/artifact-mismatch",
    "browser JavaScript digest",
  );
  const pagedQueryNames = pagedQueries(plan);
  if (pagedQueryNames.size > 0 && cursor === undefined) {
    fail("adapter/missing-cursor-config", "paged queries require cursor key configuration");
  }
  let cursorProvider = null;
  if (cursor !== undefined) {
    try {
      cursorProvider = createWakeCursorProvider(cursor);
    } catch {
      fail("adapter/invalid-cursor-config", "cursor key configuration is invalid");
    }
  }
  const cursorTransport = createWakeCursorTransport(cursorProvider, {
    fingerprint: manifest.checkedApplication.fingerprint,
  });
  const gateway = createGateway(plan, {
    fram,
    providers: providerRegistry,
    schema,
    serverValues,
  });
  if (!gateway || typeof gateway !== "object"
      || typeof gateway.executeQuery !== "function" || typeof gateway.invoke !== "function") {
    fail("adapter/invalid-config", "the Wake gateway factory returned an invalid gateway");
  }

  async function authorizeOperation(operation, context, label) {
    const checked = checkedContext(context, label);
    let value;
    try {
      value = await authorize(freezeTree({
        ...operation,
        actor: checked.actor,
        traceId: checked.traceId,
      }));
    } catch {
      fail("adapter/forbidden", "the host denied the operation");
    }
    const decision = checkedAuthorizationDecision(value, checked.actor);
    if (!decision.allowed) fail("adapter/forbidden", "the host denied the operation");
    return decision;
  }

  async function checkReadiness() {
    try {
      const response = await fram.status();
      return plainObject(response)
        && plainObject(response.result)
        && response.result.state === "ready";
    } catch {
      return false;
    }
  }

  async function handleOperation(request, context) {
    if (!(request instanceof Request)) {
      fail("adapter/invalid-request", "handleOperation requires a Request");
    }
    const checked = checkedContext(context);
    const handleHttp = createHttpHandler(gateway, {
      ...(cursorProvider === null ? {} : { cursorProvider }),
      expectedFingerprint: manifest.checkedApplication.fingerprint,
      authorize: async operation => {
        try {
          const decision = await authorize(httpAuthorizationSnapshot(
            operation,
            checked.actor,
            checked.traceId,
          ));
          return checkedAuthorizationDecision(decision, checked.actor);
        } catch {
          return Object.freeze({ allowed: false, actor: checked.actor });
        }
      },
    });
    if (typeof handleHttp !== "function") {
      fail("adapter/invalid-config", "the Wake HTTP factory returned an invalid handler");
    }
    return handleHttp(request);
  }

  async function executeQuery(name, input = {}, options = {}, context) {
    nonempty(name, "query name");
    if (!plainObject(input) || !plainObject(options)) {
      fail("adapter/invalid-request", "executeQuery input and options must be objects");
    }
    const executionInput = structuredClone(input);
    const executionOptions = structuredClone(options);
    const decision = await authorizeOperation(Object.freeze({
      input: structuredClone(executionInput),
      kind: "query",
      name,
      op: "execute",
      options: structuredClone(executionOptions),
      query: name,
      surface: "direct",
    }), context, "executeQuery");
    if (!pagedQueryNames.has(name) && !Object.hasOwn(executionOptions, "cursor")) {
      return gateway.executeQuery(name, executionInput, executionOptions, decision.actor);
    }
    if (typeof decision.authorizationScope !== "string"
        || decision.authorizationScope.length === 0) {
      fail(
        "adapter/cursor-scope-unavailable",
        "paged query authorization must provide authorizationScope",
      );
    }
    return cursorTransport.execute(Object.freeze({
      authorizationScope: decision.authorizationScope,
      input: executionInput,
      options: executionOptions,
      query: name,
    }), operation => gateway.executeQuery(
      operation.query,
      operation.input,
      operation.options,
      decision.actor,
    ));
  }

  async function invokeCommand(name, requestId, input = {}, context) {
    nonempty(name, "command name");
    nonempty(requestId, "requestId");
    if (!plainObject(input)) fail("adapter/invalid-request", "invokeCommand input must be an object");
    const executionInput = structuredClone(input);
    const decision = await authorizeOperation(Object.freeze({
      command: name,
      kind: "command",
      name,
      op: "invoke",
      requestId,
      surface: "direct",
    }), context, "invokeCommand");
    return gateway.invoke(name, requestId, executionInput, decision.actor);
  }

  return Object.freeze({
    applicationId: manifest.applicationId,
    artifacts,
    checkReadiness,
    executeQuery,
    handleOperation,
    invokeCommand,
    semanticFingerprint: manifest.checkedApplication.fingerprint,
  });
}

/** @deprecated Use createWakeApplicationAdapter. */
export const createWakeBunAdapter = createWakeApplicationAdapter;
