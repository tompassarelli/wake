import { describe, expect, test } from "bun:test";

import { installApplication } from "./application-installer.mjs";
import { loadApplicationReceipt } from "./application-receipt.mjs";
import { canonicalDocument, sha256Digest } from "./canonical.mjs";

const applicationId = "neutral.installer.fixture";
const fingerprint = `sha256:${"1".repeat(64)}`;
const browserClientDigest = `sha256:${"2".repeat(64)}`;
const browserJavaScriptDigest = `sha256:${"3".repeat(64)}`;
const operationSurfaceDigest = `sha256:${"4".repeat(64)}`;
const stateSchemaDigest = `sha256:${"5".repeat(64)}`;
const storageProjectionDigest = `sha256:${"6".repeat(64)}`;

function artifacts() {
  const plugin = {
    alias: "fixture",
    artifactDigest: `sha256:${"7".repeat(64)}`,
    packageId: "neutral-plugin",
    version: "1.0.0",
  };
  const planValue = {
    applicationId,
    backend: "fram",
    commands: [],
    composition: { extensions: [], fills: [], mounts: [], providers: [] },
    entities: [{
      fields: [],
      identity: {
        cardinality: "single",
        field: "id",
        storageId: "neutral/field/item/id",
        subjectTemplate: ["string", "template"],
        type: "String",
        valueKind: "scalar",
      },
      name: "Item",
      storageId: "neutral/entity/item",
    }],
    pluginClosure: [plugin],
    publications: [],
    queries: [],
    routes: [],
    schemaVersion: 2,
    semanticFingerprint: fingerprint,
    stateMachines: [],
  };
  const plan = `${JSON.stringify(planValue, null, 2)}\n`;
  const manifestValue = {
    applicationId,
    artifacts: {
      browserClient: { path: "wake-client.js", sha256: browserClientDigest },
      browserJavaScript: { path: "app.js", sha256: browserJavaScriptDigest },
      framPlan: { path: "app.fram.json", sha256: sha256Digest(plan) },
    },
    checkedApplication: { fingerprint, schemaVersion: 1 },
    compiler: { name: "wake", sourceCommit: "a".repeat(40), version: "0.2.0" },
    digests: {
      operationSurface: operationSurfaceDigest,
      stateSchema: stateSchemaDigest,
      storageProjection: storageProjectionDigest,
    },
    hostCapabilities: [],
    plugins: [plugin],
    protocols: {
      framPlanSchemaVersion: 2,
      httpOperationProtocolVersion: 2,
      pluginAbiVersion: 1,
    },
    schemaVersion: 1,
  };
  const manifest = canonicalDocument(manifestValue);
  const deploymentReceipt = canonicalDocument({
    applicationId,
    applicationManifestDigest: sha256Digest(manifest),
    browserClientDigest,
    browserJavaScriptDigest,
    framPlanDigest: sha256Digest(plan),
    schemaVersion: 1,
  });
  return { deploymentReceipt, manifest, plan };
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

function harness() {
  let state = null;
  let compiledSchema = null;
  let version = 40n;
  const calls = { initialize: [], query: [], transactions: [] };
  const faults = { create: null, finalize: null };

  const response = result => ({
    page: { done: true, nextCursor: null, ordinal: 0 },
    result,
    servedVersion: version,
  });
  const fram = {
    async query(query, options) {
      calls.query.push({ options, query });
      if (query.find.endsWith("subject")) {
        return response(state === null ? [] : [[receiptSubject]]);
      }
      if (query.find === "wake/runtime/application-install-documents") {
        return response(state === null ? [] : [[string(state), string(compiledSchema)]]);
      }
      if (query.find === "wake/runtime/application-receipt-document") {
        return response(state === null ? [] : [[string(state)]]);
      }
      throw new Error(`unexpected query ${query.find}`);
    },
  };
  const schema = {
    async createUnique() {},
    async updateUnique() {},
    async updateUniqueMany() {},
    async transactUnique(transaction) {
      calls.transactions.push(transaction);
      const create = transaction.creates?.[0];
      const update = transaction.updates?.[0];
      if (create) {
        if (faults.create === "before") throw new Error("create failed before commit");
        if (state !== null) throw Object.assign(new Error("exists"), {
          code: "schema/identity-exists",
        });
        state = create.fields[0].value[1];
        compiledSchema = create.fields[1].value[1];
        version += 1n;
        if (faults.create === "after") throw new Error("create reply lost");
      } else if (update) {
        if (faults.finalize === "before") throw new Error("finalize failed before commit");
        const field = update.fields[0];
        if (state !== field.allowedCurrent[0][1]) {
          throw Object.assign(new Error("guard rejected"), {
            code: "schema/current-value-rejected",
          });
        }
        state = field.values[0][1];
        version += 1n;
        if (faults.finalize === "after") throw new Error("finalize reply lost");
      } else {
        throw new Error("unexpected transaction");
      }
      return { servedVersion: version };
    },
  };
  const checked = artifacts();
  const input = {
    applicationId,
    ...checked,
    fram,
    async initialize(context) {
      calls.initialize.push(context);
    },
    schema,
  };
  return {
    calls,
    checked,
    faults,
    fram,
    input,
    schema,
    setState(document, schemaDocument) {
      state = document;
      compiledSchema = schemaDocument;
    },
    state: () => ({ compiledSchema, document: state }),
  };
}

describe("application installer", () => {
  test("persists intent and compiled schema, initializes, then guards the exact ready receipt", async () => {
    const fixture = harness();
    let released;
    const gate = new Promise(resolve => { released = resolve; });
    fixture.input.initialize = async context => {
      fixture.calls.initialize.push(context);
      await gate;
    };
    const pending = installApplication(fixture.input);
    await Bun.sleep(0);
    expect(fixture.calls.transactions).toHaveLength(1);
    expect(fixture.state().document).toContain('"state":"installing"');
    released();

    const receipt = await pending;
    expect(fixture.calls.transactions).toHaveLength(2);
    const create = fixture.calls.transactions[0].creates[0];
    expect(create.subject).toEqual(receiptSubject);
    expect(create.fields).toHaveLength(2);
    expect(create.fields[1].value[1]).toContain('"framPlanSchemaVersion":2');
    expect(create.fields[1].value[1]).toContain(`"semanticFingerprint":"${fingerprint}"`);
    const field = fixture.calls.transactions[1].updates[0].fields[0];
    expect(field).toEqual({
      allowedCurrent: [string(create.fields[0].value[1])],
      cardinality: "single",
      predicate: create.fields[0].predicate,
      values: [string(canonicalDocument(receipt))],
    });
    expect(fixture.calls.initialize).toHaveLength(1);
    expect(Object.keys(fixture.calls.initialize[0]).sort()).toEqual([
      "applicationReceipt",
      "plan",
      "schema",
    ]);
    expect(fixture.calls.initialize[0].schema).toBe(fixture.schema);
    expect(Object.isFrozen(fixture.calls.initialize[0].plan)).toBe(true);
    expect(await loadApplicationReceipt({
      applicationId,
      ...fixture.checked,
      fram: fixture.fram,
    })).toEqual(receipt);
  });

  test("initializer failure leaves an exact resumable intent", async () => {
    const fixture = harness();
    fixture.input.initialize = async () => { throw new Error("principal failed"); };
    await expect(installApplication(fixture.input)).rejects.toMatchObject({
      code: "application-install/initialize-failed",
    });
    const intent = fixture.state();
    expect(intent.document).toContain('"state":"installing"');
    expect(fixture.calls.transactions).toHaveLength(1);

    fixture.input.initialize = async context => { fixture.calls.initialize.push(context); };
    const receipt = await installApplication(fixture.input);
    expect(fixture.calls.transactions).toHaveLength(2);
    expect(fixture.state().document).toBe(canonicalDocument(receipt));
  });

  test("an exact ready install reruns principal reconciliation without writes", async () => {
    const fixture = harness();
    const receipt = await installApplication(fixture.input);
    fixture.calls.transactions.length = 0;
    fixture.calls.initialize.length = 0;

    expect(await installApplication(fixture.input)).toEqual(receipt);
    expect(fixture.calls.initialize).toHaveLength(1);
    expect(fixture.calls.transactions).toHaveLength(0);
  });

  test("artifact and installed-state drift fail before initialization or overwrite", async () => {
    const invalid = harness();
    invalid.input.plan = `${invalid.input.plan} `;
    await expect(installApplication(invalid.input)).rejects.toMatchObject({
      code: "application-install/artifact-mismatch",
    });
    expect(invalid.calls.query).toHaveLength(0);
    expect(invalid.calls.initialize).toHaveLength(0);
    expect(invalid.calls.transactions).toHaveLength(0);

    const drift = harness();
    await installApplication(drift.input);
    const prior = drift.state();
    drift.setState(prior.document.replace(fingerprint, `sha256:${"9".repeat(64)}`), prior.compiledSchema);
    drift.calls.initialize.length = 0;
    drift.calls.transactions.length = 0;
    await expect(installApplication(drift.input)).rejects.toMatchObject({
      code: "application-install/receipt-mismatch",
    });
    expect(drift.calls.initialize).toHaveLength(0);
    expect(drift.calls.transactions).toHaveLength(0);
  });

  test("recovers only exact commit-then-disconnect outcomes", async () => {
    const initial = harness();
    initial.faults.create = "after";
    expect(await installApplication(initial.input)).toMatchObject({ applicationId });
    expect(initial.calls.initialize).toHaveLength(1);

    const final = harness();
    final.faults.finalize = "after";
    expect(await installApplication(final.input)).toMatchObject({ applicationId });
    expect(final.calls.initialize).toHaveLength(1);

    const absent = harness();
    absent.faults.create = "before";
    await expect(installApplication(absent.input)).rejects.toMatchObject({
      code: "application-install/ambiguous-outcome",
    });
    expect(absent.calls.initialize).toHaveLength(0);

    const unfinished = harness();
    unfinished.faults.finalize = "before";
    await expect(installApplication(unfinished.input)).rejects.toMatchObject({
      code: "application-install/ambiguous-outcome",
    });
    expect(unfinished.state().document).toContain('"state":"installing"');
  });
});
