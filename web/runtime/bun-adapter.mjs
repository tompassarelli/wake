import { canonicalDocument, sha256Digest } from "../compiler/canonical.mjs";
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
      || !plainObject(value.artifacts.browserJavaScript)
      || !plainObject(value.artifacts.framPlan)) {
    fail("adapter/invalid-manifest", "manifest.artifacts is invalid");
  }
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
      || value.backend !== "fram" || !Array.isArray(value.pluginClosure)) {
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
    "browserJavaScriptDigest",
    "framPlanDigest",
    "schemaVersion",
  ], "deploymentReceipt");
  if (value.schemaVersion !== 1) {
    fail("adapter/invalid-receipt", "deploymentReceipt.schemaVersion must be 1");
  }
  nonempty(value.applicationId, "deploymentReceipt.applicationId");
  digest(value.applicationManifestDigest, "deploymentReceipt.applicationManifestDigest");
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

function checkedContext(value) {
  if (!plainObject(value) || !plainObject(value.actor)
      || typeof value.traceId !== "string" || value.traceId.length === 0) {
    fail("adapter/invalid-context", "handleOperation requires actor and traceId context");
  }
  return value;
}

function checkedAuthorizationDecision(value, actor) {
  if (value === true) return Object.freeze({ allowed: true, actor });
  if (!plainObject(value)
      || Object.keys(value).length !== 2
      || !Object.hasOwn(value, "allowed")
      || !Object.hasOwn(value, "actor")
      || typeof value.allowed !== "boolean"
      || !plainObject(value.actor)) {
    return Object.freeze({ allowed: false, actor });
  }
  return Object.freeze({ allowed: value.allowed, actor: value.actor });
}

/**
 * Composes Wake's checked artifacts and public FRAM clients into a Bun host
 * adapter. Authentication stays in the host; this boundary accepts only the
 * derived actor context and never reads credentials from request headers.
 */
export function createWakeBunAdapter({
  applicationReceipt: installedReceipt,
  authorize,
  browserJavaScript,
  createGateway = createFramGateway,
  createHttpHandler = createWakeHttpHandler,
  deploymentReceipt: artifactReceipt,
  fram,
  manifest: manifestInput,
  plan: planInput,
  schema,
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
  const browserBytes = browserJavaScript instanceof Uint8Array
    ? browserJavaScript
    : typeof browserJavaScript === "string"
      ? new TextEncoder().encode(browserJavaScript)
      : null;
  if (browserBytes === null) {
    fail("adapter/invalid-config", "browserJavaScript must be a string or Uint8Array");
  }
  assertSame(
    sha256Digest(browserBytes),
    manifest.artifacts.browserJavaScript.sha256,
    "adapter/artifact-mismatch",
    "browser JavaScript digest",
  );
  const gateway = createGateway(plan, { fram, schema });
  if (!gateway || typeof gateway !== "object") {
    fail("adapter/invalid-config", "the Wake gateway factory returned an invalid gateway");
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
      expectedFingerprint: manifest.checkedApplication.fingerprint,
      authorize: async operation => {
        const decision = await authorize(Object.freeze({
          ...operation,
          actor: checked.actor,
          traceId: checked.traceId,
        }));
        return checkedAuthorizationDecision(decision, checked.actor);
      },
    });
    if (typeof handleHttp !== "function") {
      fail("adapter/invalid-config", "the Wake HTTP factory returned an invalid handler");
    }
    return handleHttp(request);
  }

  return Object.freeze({
    applicationId: manifest.applicationId,
    artifacts,
    checkReadiness,
    handleOperation,
    semanticFingerprint: manifest.checkedApplication.fingerprint,
  });
}
