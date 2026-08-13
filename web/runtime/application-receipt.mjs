import { canonicalDocument, sha256Digest } from "./canonical.mjs";

const QUERY_TIMEOUT_MS = 5_000;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const PLUGIN_CONTRIBUTIONS = new Set([
  "capability",
  "command",
  "query",
  "route",
  "schema",
  "ui",
]);
const EXPECTED_PROTOCOLS = Object.freeze({
  framPlanSchemaVersion: 2,
  httpOperationProtocolVersion: 2,
  pluginAbiVersion: 1,
});

class ApplicationReceiptError extends Error {
  constructor(code, message, detail = undefined, options = undefined) {
    super(message, options);
    this.name = "ApplicationReceiptError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

function fail(code, message, detail, options) {
  throw new ApplicationReceiptError(code, message, detail, options);
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys, label, code = "receipt/invalid-artifact") {
  if (!plainObject(value) || Object.keys(value).length !== keys.length
      || keys.some(key => !Object.hasOwn(value, key))) {
    fail(code, `${label} has an invalid shape`);
  }
  return value;
}

function nonempty(value, label, code = "receipt/invalid-artifact") {
  if (typeof value !== "string" || value.length === 0) {
    fail(code, `${label} must be a nonempty string`);
  }
  return value;
}

function digest(value, label, code = "receipt/invalid-artifact") {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail(code, `${label} must be a sha256 digest`);
  }
  return value;
}

function exactVersion(value, label) {
  if (typeof value !== "string" || !VERSION.test(value)) {
    fail("receipt/invalid-artifact", `${label} must be an exact major.minor.patch version`);
  }
  return value;
}

function relativePath(value, label, suffix) {
  nonempty(value, label);
  const pieces = value.split("/");
  if (value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:\//u.test(value)
      || pieces.some(piece => piece === "" || piece === "." || piece === "..")
      || !value.endsWith(suffix)) {
    fail("receipt/invalid-artifact", `${label} must be a package-relative ${suffix} path`);
  }
  return value;
}

function pluginEvidence({
  alias,
  artifactDigest,
  configurationDigest,
  durableSchemaVersion,
  migrationOrdinal,
  packageId,
  sourceKind,
  sourceRevision,
  version,
}, label) {
  nonempty(alias, `${label}.alias`);
  if (alias.includes(".")) {
    fail("receipt/invalid-artifact", `${label}.alias must not contain '.'`);
  }
  digest(artifactDigest, `${label}.artifact digest`);
  digest(configurationDigest, `${label}.configuration digest`);
  if (!Number.isSafeInteger(durableSchemaVersion) || durableSchemaVersion < 1) {
    fail("receipt/invalid-artifact", `${label}.durable schema version must be positive`);
  }
  if (!Number.isSafeInteger(migrationOrdinal) || migrationOrdinal < 0) {
    fail("receipt/invalid-artifact", `${label}.migration ordinal must be nonnegative`);
  }
  nonempty(packageId, `${label}.package id`);
  if (sourceKind !== "git" || typeof sourceRevision !== "string"
      || !COMMIT.test(sourceRevision)) {
    fail("receipt/invalid-artifact", `${label}.source must identify one Git commit`);
  }
  exactVersion(version, `${label}.version`);
  return Object.freeze({
    alias,
    artifact_digest: artifactDigest,
    configuration_digest: configurationDigest,
    durable_schema_version: durableSchemaVersion,
    migration_ordinal: migrationOrdinal,
    package_id: packageId,
    source_kind: sourceKind,
    source_revision: sourceRevision,
    version,
  });
}

function checkedManifestPlugin(value, index) {
  const label = `manifest.plugins[${index}]`;
  exactKeys(value, [
    "alias",
    "allowedContributions",
    "artifactDigest",
    "configuration",
    "configurationDigest",
    "durableSchemaVersion",
    "migrationOrdinal",
    "packageId",
    "source",
    "version",
  ], label);
  if (!Array.isArray(value.allowedContributions)
      || value.allowedContributions.some(contribution =>
        typeof contribution !== "string" || !PLUGIN_CONTRIBUTIONS.has(contribution))
      || new Set(value.allowedContributions).size !== value.allowedContributions.length) {
    fail("receipt/invalid-artifact", `${label}.allowedContributions is invalid`);
  }
  if (!plainObject(value.configuration)) {
    fail("receipt/invalid-artifact", `${label}.configuration must be an object`);
  }
  exactKeys(value.source, ["commit", "kind"], `${label}.source`);
  return pluginEvidence({
    alias: value.alias,
    artifactDigest: value.artifactDigest,
    configurationDigest: value.configurationDigest,
    durableSchemaVersion: value.durableSchemaVersion,
    migrationOrdinal: value.migrationOrdinal,
    packageId: value.packageId,
    sourceKind: value.source.kind,
    sourceRevision: value.source.commit,
    version: value.version,
  }, label);
}

function checkedPlanPlugin(value, index) {
  const label = `plan.pluginClosure[${index}]`;
  exactKeys(value, [
    "alias",
    "artifact_digest",
    "artifact_path",
    "configuration_digest",
    "durable_schema_version",
    "entry_path",
    "migration_ordinal",
    "package_id",
    "source_kind",
    "source_revision",
    "version",
  ], label);
  relativePath(value.artifact_path, `${label}.artifact_path`, ".wakepkg.json");
  relativePath(value.entry_path, `${label}.entry_path`, ".bjs");
  return pluginEvidence({
    alias: value.alias,
    artifactDigest: value.artifact_digest,
    configurationDigest: value.configuration_digest,
    durableSchemaVersion: value.durable_schema_version,
    migrationOrdinal: value.migration_ordinal,
    packageId: value.package_id,
    sourceKind: value.source_kind,
    sourceRevision: value.source_revision,
    version: value.version,
  }, label);
}

function artifactDocument(input, label, { canonical = false } = {}) {
  const bytes = input instanceof Uint8Array
    ? input.slice()
    : typeof input === "string"
      ? new TextEncoder().encode(input)
      : null;
  if (bytes === null) {
    fail("receipt/invalid-input", `${label} must be exact UTF-8 bytes or text`);
  }

  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch (error) {
    fail("receipt/invalid-artifact", `${label} must contain valid UTF-8 JSON`, undefined, {
      cause: error,
    });
  }
  if (canonical && text !== canonicalDocument(value)) {
    fail("receipt/invalid-artifact", `${label} must be canonical JSON`);
  }
  return Object.freeze({ bytes, text, value });
}

function checkedProtocols(value, label, code = "receipt/invalid-artifact") {
  exactKeys(value, Object.keys(EXPECTED_PROTOCOLS), label, code);
  for (const [name, expected] of Object.entries(EXPECTED_PROTOCOLS)) {
    if (value[name] !== expected) {
      fail(code, `${label}.${name} must be ${expected}`);
    }
  }
  return value;
}

function checkedManifest(input) {
  const artifact = artifactDocument(input, "manifest", { canonical: true });
  const value = exactKeys(artifact.value, [
    "applicationId",
    "artifacts",
    "checkedApplication",
    "compiler",
    "digests",
    "hostCapabilities",
    "plugins",
    "protocols",
    "schemaVersion",
  ], "manifest");
  if (value.schemaVersion !== 1) {
    fail("receipt/invalid-artifact", "manifest.schemaVersion must be 1");
  }
  nonempty(value.applicationId, "manifest.applicationId");
  exactKeys(value.checkedApplication, ["fingerprint", "schemaVersion"], "manifest.checkedApplication");
  if (value.checkedApplication.schemaVersion !== 1) {
    fail("receipt/invalid-artifact", "manifest.checkedApplication.schemaVersion must be 1");
  }
  digest(value.checkedApplication.fingerprint, "manifest.checkedApplication.fingerprint");
  checkedProtocols(value.protocols, "manifest.protocols");
  exactKeys(
    value.artifacts,
    ["browserClient", "browserJavaScript", "framPlan"],
    "manifest.artifacts",
  );
  for (const name of ["browserClient", "browserJavaScript", "framPlan"]) {
    exactKeys(value.artifacts[name], ["path", "sha256"], `manifest.artifacts.${name}`);
    nonempty(value.artifacts[name].path, `manifest.artifacts.${name}.path`);
    digest(value.artifacts[name].sha256, `manifest.artifacts.${name}.sha256`);
  }
  exactKeys(
    value.digests,
    ["operationSurface", "stateSchema", "storageProjection"],
    "manifest.digests",
  );
  for (const name of ["operationSurface", "stateSchema", "storageProjection"]) {
    digest(value.digests[name], `manifest.digests.${name}`);
  }
  if (!Array.isArray(value.plugins)) {
    fail("receipt/invalid-artifact", "manifest.plugins must be an array");
  }
  if (!Array.isArray(value.hostCapabilities)
      || value.hostCapabilities.some(capability => typeof capability !== "string"
        || capability.length === 0)) {
    fail("receipt/invalid-artifact", "manifest.hostCapabilities must contain names");
  }
  const plugins = Object.freeze(value.plugins.map(checkedManifestPlugin));
  if (new Set(plugins.map(plugin => plugin.alias)).size !== plugins.length) {
    fail("receipt/invalid-artifact", "manifest.plugins repeats an alias");
  }
  return Object.freeze({ ...artifact, plugins, value });
}

function checkedPlan(input) {
  const artifact = artifactDocument(input, "plan");
  const value = artifact.value;
  if (!plainObject(value) || value.schemaVersion !== 2 || value.backend !== "fram"
      || !Array.isArray(value.pluginClosure)) {
    fail("receipt/invalid-artifact", "plan must be a Wake FRAM plan with schemaVersion 2");
  }
  nonempty(value.applicationId, "plan.applicationId");
  digest(value.semanticFingerprint, "plan.semanticFingerprint");
  const pluginClosure = Object.freeze(value.pluginClosure.map(checkedPlanPlugin));
  if (new Set(pluginClosure.map(plugin => plugin.alias)).size !== pluginClosure.length) {
    fail("receipt/invalid-artifact", "plan.pluginClosure repeats an alias");
  }
  return Object.freeze({ ...artifact, pluginClosure, value });
}

function checkedDeploymentReceipt(input) {
  const artifact = artifactDocument(input, "deploymentReceipt", { canonical: true });
  const value = exactKeys(artifact.value, [
    "applicationId",
    "applicationManifestDigest",
    "browserClientDigest",
    "browserJavaScriptDigest",
    "framPlanDigest",
    "schemaVersion",
  ], "deploymentReceipt");
  if (value.schemaVersion !== 1) {
    fail("receipt/invalid-artifact", "deploymentReceipt.schemaVersion must be 1");
  }
  nonempty(value.applicationId, "deploymentReceipt.applicationId");
  for (const name of [
    "applicationManifestDigest",
    "browserClientDigest",
    "browserJavaScriptDigest",
    "framPlanDigest",
  ]) {
    digest(value[name], `deploymentReceipt.${name}`);
  }
  return Object.freeze({ ...artifact, value });
}

function same(actual, expected, label) {
  if (actual !== expected) {
    fail("receipt/artifact-mismatch", `${label} does not match the checked application`);
  }
}

function expectedReceipt(applicationId, manifestArtifact, planArtifact, deploymentArtifact) {
  const manifest = manifestArtifact.value;
  const plan = planArtifact.value;
  const deployment = deploymentArtifact.value;

  same(manifest.applicationId, applicationId, "manifest applicationId");
  same(plan.applicationId, applicationId, "plan applicationId");
  same(deployment.applicationId, applicationId, "deployment receipt applicationId");
  same(
    plan.semanticFingerprint,
    manifest.checkedApplication.fingerprint,
    "plan semantic fingerprint",
  );
  same(
    canonicalDocument(planArtifact.pluginClosure),
    canonicalDocument(manifestArtifact.plugins),
    "plan plugin closure",
  );
  same(
    sha256Digest(manifestArtifact.bytes),
    deployment.applicationManifestDigest,
    "application manifest digest",
  );
  const planDigest = sha256Digest(planArtifact.bytes);
  same(planDigest, manifest.artifacts.framPlan.sha256, "manifest FRAM plan digest");
  same(planDigest, deployment.framPlanDigest, "deployment FRAM plan digest");
  same(
    manifest.artifacts.browserClient.sha256,
    deployment.browserClientDigest,
    "deployment browser client digest",
  );
  same(
    manifest.artifacts.browserJavaScript.sha256,
    deployment.browserJavaScriptDigest,
    "deployment browser JavaScript digest",
  );

  return Object.freeze({
    applicationId,
    deploymentArtifactReceiptDigest: sha256Digest(deploymentArtifact.bytes),
    operationSurfaceDigest: manifest.digests.operationSurface,
    protocols: Object.freeze({ ...manifest.protocols }),
    schemaVersion: 1,
    semanticFingerprint: manifest.checkedApplication.fingerprint,
    storageProjectionDigest: manifest.digests.storageProjection,
  });
}

/**
 * Checks one exact compiler artifact closure without touching FRAM. The
 * installer uses this before recording an intent or invoking host bootstrap.
 */
export function prepareApplicationReceipt({
  applicationId,
  deploymentReceipt,
  manifest,
  plan,
} = {}) {
  nonempty(applicationId, "applicationId", "receipt/invalid-input");
  const manifestArtifact = checkedManifest(manifest);
  const planArtifact = checkedPlan(plan);
  const deploymentArtifact = checkedDeploymentReceipt(deploymentReceipt);
  return Object.freeze({
    applicationReceipt: expectedReceipt(
      applicationId,
      manifestArtifact,
      planArtifact,
      deploymentArtifact,
    ),
    deploymentReceipt: deploymentArtifact,
    manifest: manifestArtifact,
    plan: planArtifact,
  });
}

const keyword = value => ["keyword", value];
const string = value => ["string", value];
const triple = (t1, t2, t3) => ["triple", t1, t2, t3];

function scoped(applicationId, value) {
  return triple(keyword("wake/app"), keyword(applicationId), value);
}

function receiptStorage(applicationId) {
  const entity = "wake/core/entity/application-plan-receipt";
  const subject = scoped(
    applicationId,
    triple(keyword("entity"), keyword(entity), string(applicationId)),
  );
  const predicate = storageId => scoped(
    applicationId,
    triple(keyword("field"), keyword(entity), keyword(storageId)),
  );
  return Object.freeze({
    documentPredicate: predicate("wake/core/field/application-plan-receipt/document"),
    identityPredicate: predicate("wake/core/field/application-plan-receipt/application-id"),
    subject,
  });
}

function receiptSubjectQuery(applicationId, storage) {
  return {
    find: "wake/runtime/application-receipt-subject",
    rules: [{
      head: {
        rel: "wake/runtime/application-receipt-subject",
        args: [{ var: "subject" }],
      },
      body: [{
        rel: "triple",
        args: [
          { var: "subject" },
          storage.identityPredicate,
          string(applicationId),
        ],
      }],
    }],
  };
}

function receiptDocumentQuery(storage) {
  return {
    find: "wake/runtime/application-receipt-document",
    rules: [{
      head: {
        rel: "wake/runtime/application-receipt-document",
        args: [{ var: "document" }],
      },
      body: [{
        rel: "triple",
        args: [storage.subject, storage.documentPredicate, { var: "document" }],
      }],
    }],
  };
}

async function queryReceipt(fram, query, options, label) {
  let response;
  try {
    response = await fram.query(query, options);
  } catch (error) {
    fail("receipt/unavailable", `${label} query failed`, undefined, { cause: error });
  }
  if (!plainObject(response) || !Array.isArray(response.result)
      || typeof response.servedVersion !== "bigint" || !plainObject(response.page)
      || typeof response.page.done !== "boolean") {
    fail("receipt/protocol", `FRAM returned a malformed ${label} response`);
  }
  return response;
}

function checkedStoredReceipt(value) {
  exactKeys(value, [
    "applicationId",
    "deploymentArtifactReceiptDigest",
    "operationSurfaceDigest",
    "protocols",
    "schemaVersion",
    "semanticFingerprint",
    "storageProjectionDigest",
  ], "stored application receipt", "receipt/malformed");
  if (value.schemaVersion !== 1) {
    fail("receipt/malformed", "stored application receipt schemaVersion must be 1");
  }
  nonempty(value.applicationId, "stored application receipt applicationId", "receipt/malformed");
  for (const name of [
    "deploymentArtifactReceiptDigest",
    "operationSurfaceDigest",
    "semanticFingerprint",
    "storageProjectionDigest",
  ]) {
    digest(value[name], `stored application receipt ${name}`, "receipt/malformed");
  }
  checkedProtocols(value.protocols, "stored application receipt protocols", "receipt/malformed");
  return Object.freeze({
    ...value,
    protocols: Object.freeze({ ...value.protocols }),
  });
}

/**
 * Reads the one durable ApplicationPlanReceipt for a checked Wake artifact.
 * The FRAM query is fixed here; callers receive no raw query or storage escape.
 */
export async function loadApplicationReceipt({
  applicationId,
  deploymentReceipt,
  fram,
  manifest,
  plan,
} = {}) {
  nonempty(applicationId, "applicationId", "receipt/invalid-input");
  if (!fram || typeof fram.query !== "function") {
    fail("receipt/invalid-input", "fram must be the official client with query support");
  }

  const { applicationReceipt: expected } = prepareApplicationReceipt({
    applicationId,
    deploymentReceipt,
    manifest,
    plan,
  });

  const storage = receiptStorage(applicationId);
  const subjects = await queryReceipt(
    fram,
    receiptSubjectQuery(applicationId, storage),
    {
      page: { limit: 2 },
      timeoutMs: QUERY_TIMEOUT_MS,
    },
    "application receipt identity",
  );
  if (subjects.result.length === 0 && subjects.page.done) {
    fail("receipt/missing", `application ${applicationId} has no installed receipt`);
  }
  if (subjects.result.length !== 1 || !subjects.page.done) {
    fail("receipt/duplicate", `application ${applicationId} has more than one installed receipt`);
  }
  const subjectRow = subjects.result[0];
  if (!Array.isArray(subjectRow) || subjectRow.length !== 1
      || !Array.isArray(subjectRow[0])
      || canonicalDocument(subjectRow[0]) !== canonicalDocument(storage.subject)) {
    fail("receipt/malformed", "installed application receipt has a noncanonical subject");
  }

  const documents = await queryReceipt(
    fram,
    receiptDocumentQuery(storage),
    {
      asOf: subjects.servedVersion,
      page: { limit: 2 },
      timeoutMs: QUERY_TIMEOUT_MS,
    },
    "application receipt document",
  );
  if (documents.servedVersion !== subjects.servedVersion) {
    fail("receipt/protocol", "FRAM did not preserve the application receipt snapshot");
  }
  if (documents.result.length === 0 && documents.page.done) {
    fail("receipt/malformed", "installed application receipt has no document");
  }
  if (documents.result.length !== 1 || !documents.page.done) {
    fail("receipt/duplicate", `application ${applicationId} has more than one receipt document`);
  }

  const row = documents.result[0];
  if (!Array.isArray(row) || row.length !== 1 || !Array.isArray(row[0])
      || row[0].length !== 2 || row[0][0] !== "string" || typeof row[0][1] !== "string") {
    fail("receipt/protocol", "FRAM returned a malformed application receipt row");
  }
  let storedValue;
  try {
    storedValue = JSON.parse(row[0][1]);
  } catch (error) {
    fail("receipt/malformed", "stored application receipt is not JSON", undefined, { cause: error });
  }
  if (row[0][1] !== canonicalDocument(storedValue)) {
    fail("receipt/malformed", "stored application receipt is not canonical JSON");
  }
  const stored = checkedStoredReceipt(storedValue);
  if (canonicalDocument(stored) !== canonicalDocument(expected)) {
    fail("receipt/mismatch", "installed application receipt does not match the checked artifacts");
  }
  return stored;
}
