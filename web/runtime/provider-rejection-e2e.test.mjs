import { expect, test } from "bun:test";

import { canonicalDocument, sha256Digest } from "../compiler/canonical.mjs";
import { createWakeBunAdapter } from "./bun-adapter.mjs";
import { rejectProviderInput } from "./commands.mjs";

const applicationId = "neutral.provider-rejection";
const fingerprint = `sha256:${"1".repeat(64)}`;
const operationDigest = `sha256:${"2".repeat(64)}`;
const storageDigest = `sha256:${"3".repeat(64)}`;
const protocols = Object.freeze({
  framPlanSchemaVersion: 2,
  httpOperationProtocolVersion: 2,
  pluginAbiVersion: 1,
});
const stringType = Object.freeze({ kind: "string", minLength: 1, maxBytes: 1024 });

const term = (tag, value) => [tag, value];
const triple = (first, second, third) => ["triple", first, second, third];
const input = name => ({ kind: "input", name });
const injected = name => ({ kind: "injected", name });

function receiptEntity() {
  const entityStorageId = "neutral/entity/command-receipt";
  const identityStorageId = "neutral/field/command-receipt/id";
  const scoped = value => triple(
    term("keyword", "wake/app"),
    term("keyword", applicationId),
    value,
  );
  const predicate = storageId => scoped(triple(
    term("keyword", "field"),
    term("keyword", entityStorageId),
    term("keyword", storageId),
  ));
  const field = (name, type = "String") => {
    const storageId = `neutral/field/command-receipt/${name}`;
    return {
      name,
      storageId,
      type,
      cardinality: "single",
      valueKind: "literal",
      write: "command",
      predicateTerm: predicate(storageId),
    };
  };
  return {
    name: "command-receipt",
    storageId: entityStorageId,
    identity: {
      field: "id",
      storageId: identityStorageId,
      type: "String",
      cardinality: "single",
      valueKind: "literal",
      subjectTemplate: scoped(triple(
        term("keyword", "entity"),
        term("keyword", entityStorageId),
        { field: identityStorageId },
      )),
    },
    fields: [
      field("id"),
      field("actor"),
      field("command"),
      field("input-digest"),
      field("created-at", "Instant"),
      field("result-digest"),
    ],
  };
}

function checkedArtifacts() {
  const browserClient = "export const wakeClient = true;\n";
  const browserJavaScript = `// wake: checked-application ${fingerprint}\n`;
  const plugin = {
    alias: "fixture",
    allowedContributions: ["capability", "schema"],
    artifactDigest: `sha256:${"4".repeat(64)}`,
    configuration: {},
    configurationDigest: `sha256:${"5".repeat(64)}`,
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
  const receipt = {
    entity: "command-receipt",
    identityField: "id",
    actorField: "actor",
    commandField: "command",
    inputDigestField: "input-digest",
    createdAtField: "created-at",
    resultFields: [{ name: "digest", field: "result-digest", type: stringType }],
  };
  const planValue = {
    applicationId,
    backend: "fram",
    composition: {
      extensions: [],
      fills: [],
      mounts: [],
      providers: [{
        name: "content-parser",
        package_id: "wake-neutral-fixture",
        port: "fixture.content-parser",
        port_name: "content-parser",
      }],
    },
    commands: [{
      name: "parse-content",
      capabilities: [{ capability: "content:write" }],
      normalizerVersion: 1,
      input: [{ name: "content", type: stringType, required: true }],
      injections: [{
        name: "digest",
        kind: "provider",
        provider: "content-parser",
        input: {
          kind: "record",
          fields: [{ name: "content", value: input("content") }],
        },
        type: stringType,
      }],
      steps: [{ op: "assert", left: input("content"), right: input("content") }],
      result: [{ name: "digest", type: stringType, value: injected("digest") }],
      receipt,
    }],
    entities: [receiptEntity()],
    pluginClosure: [planPlugin],
    publications: [],
    queries: [],
    schemaVersion: 2,
    semanticFingerprint: fingerprint,
    stateMachines: [],
  };
  const plan = `${JSON.stringify(planValue, null, 2)}\n`;
  const manifest = canonicalDocument({
    applicationId,
    artifacts: {
      browserClient: { path: "wake-client.js", sha256: sha256Digest(browserClient) },
      browserJavaScript: { path: "app.js", sha256: sha256Digest(browserJavaScript) },
      framPlan: { path: "app.fram.json", sha256: sha256Digest(plan) },
    },
    checkedApplication: { fingerprint, schemaVersion: 1 },
    compiler: { name: "wake", sourceCommit: "b".repeat(40), version: "0.1.0" },
    digests: {
      operationSurface: operationDigest,
      stateSchema: `sha256:${"6".repeat(64)}`,
      storageProjection: storageDigest,
    },
    hostCapabilities: [],
    plugins: [plugin],
    protocols,
    schemaVersion: 1,
  });
  const deploymentReceipt = canonicalDocument({
    applicationId,
    applicationManifestDigest: sha256Digest(manifest),
    browserClientDigest: sha256Digest(browserClient),
    browserJavaScriptDigest: sha256Digest(browserJavaScript),
    framPlanDigest: sha256Digest(plan),
    schemaVersion: 1,
  });
  return {
    applicationReceipt: {
      applicationId,
      deploymentArtifactReceiptDigest: sha256Digest(deploymentReceipt),
      operationSurfaceDigest: operationDigest,
      protocols,
      schemaVersion: 1,
      semanticFingerprint: fingerprint,
      storageProjectionDigest: storageDigest,
    },
    browserClient,
    browserJavaScript,
    deploymentReceipt,
    manifest,
    plan,
  };
}

test("checked provider rejections propagate directly and map to HTTP 400 without mutation", async () => {
  const calls = { provider: 0, query: 0, schema: 0 };
  const publicDetail = { field: "content", reason: "unsupported-syntax" };
  const publicMessage = "Article content uses unsupported syntax.";
  const provider = (value, context) => {
    calls.provider += 1;
    expect(value).toEqual({ content: "{{unsafe}}" });
    expect(context).toEqual({
      actor: { capabilities: ["content:write"], id: "actor-1" },
      command: "parse-content",
    });
    rejectProviderInput(publicMessage, publicDetail);
  };
  const fram = {
    async query() {
      calls.query += 1;
      return {
        page: { done: true, nextCursor: null, ordinal: 0 },
        result: [],
        servedVersion: 1n,
      };
    },
    async status() {
      return { result: { state: "ready" }, servedVersion: 1n };
    },
  };
  const mutation = async () => {
    calls.schema += 1;
    throw new Error("provider rejection must precede FRAM mutation");
  };
  const schema = {
    createUnique: mutation,
    transactUnique: mutation,
    updateUnique: mutation,
    updateUniqueMany: mutation,
  };
  const actor = Object.freeze({
    capabilities: Object.freeze(["content:write"]),
    id: "actor-1",
  });
  const adapter = createWakeBunAdapter({
    ...checkedArtifacts(),
    authorize: () => ({ actor, allowed: true }),
    fram,
    providers: { "content-parser": provider },
    schema,
  });
  const context = Object.freeze({ actor: Object.freeze({ id: "session-1" }), traceId: "trace-provider" });

  let directError;
  try {
    await adapter.invokeCommand(
      "parse-content",
      "request-direct",
      { content: "{{unsafe}}" },
      context,
    );
  } catch (error) {
    directError = error;
  }
  expect(directError).toMatchObject({
    code: "command/provider-rejected",
    detail: publicDetail,
    message: publicMessage,
  });
  expect(Object.hasOwn(directError, "cause")).toBe(false);
  expect(Object.isFrozen(directError.detail)).toBe(true);

  const response = await adapter.handleOperation(new Request(
    "https://wake.test/api/wake/command",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: "parse-content",
        fingerprint,
        input: { content: "{{unsafe}}" },
        op: "invoke",
        requestId: "request-http",
      }),
    },
  ), context);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: {
      code: "command/provider-rejected",
      message: publicMessage,
    },
  });
  expect(calls).toEqual({ provider: 2, query: 2, schema: 0 });
});
