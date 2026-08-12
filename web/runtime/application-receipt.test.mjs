import { describe, expect, test } from "bun:test";

import { loadApplicationReceipt } from "./application-receipt.mjs";
import { canonicalDocument, sha256Digest } from "./canonical.mjs";

const applicationId = "neutral.receipt.fixture";
const fingerprint = `sha256:${"1".repeat(64)}`;
const operationDigest = `sha256:${"2".repeat(64)}`;
const storageDigest = `sha256:${"3".repeat(64)}`;
const browserDigest = `sha256:${"4".repeat(64)}`;
const protocols = Object.freeze({
  framPlanSchemaVersion: 2,
  httpOperationProtocolVersion: 2,
  pluginAbiVersion: 1,
});

function artifacts() {
  const plugin = {
    alias: "fixture",
    artifactDigest: `sha256:${"5".repeat(64)}`,
    packageId: "neutral-plugin",
    version: "0.1.0",
  };
  const planValue = {
    applicationId,
    backend: "fram",
    entities: [],
    pluginClosure: [plugin],
    publications: [],
    queries: [],
    schemaVersion: 2,
    semanticFingerprint: fingerprint,
    stateMachines: [],
  };
  const plan = `${JSON.stringify(planValue, null, 2)}\n`;
  const manifestValue = {
    applicationId,
    artifacts: {
      browserJavaScript: { path: "app.js", sha256: browserDigest },
      framPlan: { path: "app.fram.json", sha256: sha256Digest(plan) },
    },
    checkedApplication: { fingerprint, schemaVersion: 1 },
    compiler: { name: "wake", sourceCommit: "a".repeat(40), version: "1.0.0" },
    digests: {
      operationSurface: operationDigest,
      stateSchema: `sha256:${"6".repeat(64)}`,
      storageProjection: storageDigest,
    },
    hostCapabilities: [],
    plugins: [plugin],
    protocols: { ...protocols },
    schemaVersion: 1,
  };
  const manifest = canonicalDocument(manifestValue);
  const deploymentReceipt = canonicalDocument({
    applicationId,
    applicationManifestDigest: sha256Digest(manifest),
    browserJavaScriptDigest: browserDigest,
    framPlanDigest: sha256Digest(plan),
    schemaVersion: 1,
  });
  const receipt = Object.freeze({
    applicationId,
    deploymentArtifactReceiptDigest: sha256Digest(deploymentReceipt),
    operationSurfaceDigest: operationDigest,
    protocols: { ...protocols },
    schemaVersion: 1,
    semanticFingerprint: fingerprint,
    storageProjectionDigest: storageDigest,
  });
  return { deploymentReceipt, manifest, plan, receipt };
}

const keyword = value => ["keyword", value];
const string = value => ["string", value];
const triple = (t1, t2, t3) => ["triple", t1, t2, t3];
const scoped = value => triple(keyword("wake/app"), keyword(applicationId), value);
const receiptSubject = scoped(triple(
  keyword("entity"),
  keyword("wake/core/entity/application-plan-receipt"),
  string(applicationId),
));

function subjectResponse(subjects = [receiptSubject]) {
  return {
    page: { done: true, nextCursor: null, ordinal: 0 },
    result: subjects.map(subject => [subject]),
    servedVersion: 42n,
  };
}

function documentResponse(receipts) {
  return {
    page: { done: true, nextCursor: null, ordinal: 0 },
    result: receipts.map(receipt => [["string", canonicalDocument(receipt)]]),
    servedVersion: 42n,
  };
}

function runtime(replies) {
  const checked = artifacts();
  const calls = [];
  const queue = replies instanceof Error
    ? replies
    : [...(replies ?? [subjectResponse(), documentResponse([checked.receipt])])];
  return {
    calls,
    checked,
    input: {
      applicationId,
      deploymentReceipt: checked.deploymentReceipt,
      fram: {
        async query(query, options) {
          calls.push({ options, query });
          if (queue instanceof Error) throw queue;
          return queue.shift();
        },
      },
      manifest: checked.manifest,
      plan: checked.plan,
    },
  };
}

describe("durable application receipt loader", () => {
  test("reads one closed receipt through the fixed application-scoped query", async () => {
    const { calls, checked, input } = runtime();
    const receipt = await loadApplicationReceipt(input);

    expect(receipt).toEqual(checked.receipt);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.protocols)).toBe(true);
    expect(Object.keys(receipt).sort()).toEqual([
      "applicationId",
      "deploymentArtifactReceiptDigest",
      "operationSurfaceDigest",
      "protocols",
      "schemaVersion",
      "semanticFingerprint",
      "storageProjectionDigest",
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0].options).toEqual({ page: { limit: 2 }, timeoutMs: 5_000 });
    expect(calls[0].query).toEqual({
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
            scoped(triple(
              keyword("field"),
              keyword("wake/core/entity/application-plan-receipt"),
              keyword("wake/core/field/application-plan-receipt/application-id"),
            )),
            string(applicationId),
          ],
        }],
      }],
    });
    expect(calls[1]).toEqual({
      options: {
        asOf: 42n,
        page: { limit: 2 },
        timeoutMs: 5_000,
      },
      query: {
        find: "wake/runtime/application-receipt-document",
        rules: [{
          head: {
            rel: "wake/runtime/application-receipt-document",
            args: [{ var: "document" }],
          },
          body: [{
            rel: "triple",
            args: [
              receiptSubject,
              scoped(triple(
                keyword("field"),
                keyword("wake/core/entity/application-plan-receipt"),
                keyword("wake/core/field/application-plan-receipt/document"),
              )),
              { var: "document" },
            ],
          }],
        }],
      },
    });
  });

  test("fails closed when the singleton is absent or duplicated", async () => {
    const missing = runtime([subjectResponse([])]);
    await expect(loadApplicationReceipt(missing.input)).rejects.toMatchObject({
      code: "receipt/missing",
    });

    const duplicate = runtime([subjectResponse([receiptSubject, ["string", "other-subject"]])]);
    await expect(loadApplicationReceipt(duplicate.input)).rejects.toMatchObject({
      code: "receipt/duplicate",
    });

    const unfinished = runtime([{
      ...subjectResponse(),
      page: { done: false, nextCursor: ["string", "more"], ordinal: 0 },
    }]);
    await expect(loadApplicationReceipt(unfinished.input)).rejects.toMatchObject({
      code: "receipt/duplicate",
    });

    const checked = artifacts();
    const duplicateDocument = runtime([
      subjectResponse(),
      documentResponse([checked.receipt, checked.receipt]),
    ]);
    await expect(loadApplicationReceipt(duplicateDocument.input)).rejects.toMatchObject({
      code: "receipt/duplicate",
    });

    const missingDocument = runtime([subjectResponse(), documentResponse([])]);
    await expect(loadApplicationReceipt(missingDocument.input)).rejects.toMatchObject({
      code: "receipt/malformed",
    });
  });

  test("rejects stale receipts and artifact drift before serving", async () => {
    const checked = artifacts();
    const stale = runtime([
      subjectResponse(),
      documentResponse([{
        ...checked.receipt,
        semanticFingerprint: `sha256:${"9".repeat(64)}`,
      }]),
    ]);
    await expect(loadApplicationReceipt(stale.input)).rejects.toMatchObject({
      code: "receipt/mismatch",
    });

    const drift = runtime();
    drift.input.plan = `${drift.input.plan} `;
    await expect(loadApplicationReceipt(drift.input)).rejects.toMatchObject({
      code: "receipt/artifact-mismatch",
    });
    expect(drift.calls).toHaveLength(0);
  });

  test("closes malformed and unavailable FRAM results", async () => {
    const malformed = runtime([
      subjectResponse(),
      {
        page: { done: true, nextCursor: null, ordinal: 0 },
        result: [["not-a-term"]],
        servedVersion: 42n,
      },
    ]);
    await expect(loadApplicationReceipt(malformed.input)).rejects.toMatchObject({
      code: "receipt/protocol",
    });

    const unavailable = runtime(new Error("socket closed"));
    await expect(loadApplicationReceipt(unavailable.input)).rejects.toMatchObject({
      code: "receipt/unavailable",
    });
  });
});
