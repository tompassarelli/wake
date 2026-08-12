import { canonicalDocument, sha256Digest } from "./canonical.mjs";
import {
  loadApplicationReceipt,
  prepareApplicationReceipt,
} from "./application-receipt.mjs";

const QUERY_TIMEOUT_MS = 5_000;
const INSTALL_DOCUMENT_SCHEMA_VERSION = 1;

export class ApplicationInstallError extends Error {
  constructor(code, message, detail = undefined, options = undefined) {
    super(message, options);
    this.name = "ApplicationInstallError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

function fail(code, message, detail, options) {
  throw new ApplicationInstallError(code, message, detail, options);
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value, active = new Set()) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (active.has(value)) fail("application-install/invalid-artifact", "plan contains a cycle");
  active.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    deepFreeze(item, active);
  }
  active.delete(value);
  return Object.freeze(value);
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
    compiledSchemaPredicate: predicate(
      "wake/core/field/application-plan-receipt/compiled-schema",
    ),
    documentPredicate: predicate("wake/core/field/application-plan-receipt/document"),
    identityPredicate: predicate("wake/core/field/application-plan-receipt/application-id"),
    subject,
  });
}

function receiptSubjectQuery(applicationId, storage) {
  return {
    find: "wake/runtime/application-install-subject",
    rules: [{
      head: {
        rel: "wake/runtime/application-install-subject",
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

function receiptDocumentsQuery(storage) {
  return {
    find: "wake/runtime/application-install-documents",
    rules: [{
      head: {
        rel: "wake/runtime/application-install-documents",
        args: [{ var: "document" }, { var: "compiledSchema" }],
      },
      body: [
        {
          rel: "triple",
          args: [storage.subject, storage.documentPredicate, { var: "document" }],
        },
        {
          rel: "triple",
          args: [
            storage.subject,
            storage.compiledSchemaPredicate,
            { var: "compiledSchema" },
          ],
        },
      ],
    }],
  };
}

function compiledSchema(applicationReceipt, manifest, plan) {
  for (const name of ["entities", "publications", "stateMachines"]) {
    if (!Array.isArray(plan[name])) {
      fail("application-install/invalid-artifact", `plan.${name} must be an array`);
    }
  }
  return deepFreeze({
    applicationId: applicationReceipt.applicationId,
    entities: plan.entities,
    framPlanSchemaVersion: applicationReceipt.protocols.framPlanSchemaVersion,
    schemaVersion: 1,
    semanticFingerprint: applicationReceipt.semanticFingerprint,
    stateMachines: plan.stateMachines,
    publications: plan.publications,
    stateSchemaDigest: manifest.digests.stateSchema,
    storageProjectionDigest: applicationReceipt.storageProjectionDigest,
  });
}

function installingDocument(applicationReceipt, schemaDocument) {
  return deepFreeze({
    applicationReceipt,
    compiledSchemaDigest: sha256Digest(canonicalDocument(schemaDocument)),
    schemaVersion: INSTALL_DOCUMENT_SCHEMA_VERSION,
    state: "installing",
  });
}

function sameTerm(actual, expected) {
  return canonicalDocument(actual) === canonicalDocument(expected);
}

function checkedStoredString(term) {
  if (!Array.isArray(term) || term.length !== 2 || term[0] !== "string"
      || typeof term[1] !== "string") {
    fail("application-install/protocol", "FRAM returned a malformed install document");
  }
  return term[1];
}

async function readState(fram, applicationId, storage) {
  let subjects;
  try {
    subjects = await fram.query(receiptSubjectQuery(applicationId, storage), {
      page: { limit: 2 },
      timeoutMs: QUERY_TIMEOUT_MS,
    });
  } catch (error) {
    fail(
      "application-install/unavailable",
      "application install state query failed",
      undefined,
      { cause: error },
    );
  }
  if (!plainObject(subjects) || !Array.isArray(subjects.result)
      || typeof subjects.servedVersion !== "bigint" || !plainObject(subjects.page)
      || subjects.page.done !== true) {
    fail("application-install/protocol", "FRAM returned a malformed install state response");
  }
  if (subjects.result.length === 0) {
    return Object.freeze({ kind: "blank", servedVersion: subjects.servedVersion });
  }
  if (subjects.result.length !== 1) {
    fail("application-install/receipt-mismatch", "application install state is not unique");
  }
  const subjectRow = subjects.result[0];
  if (!Array.isArray(subjectRow) || subjectRow.length !== 1
      || !sameTerm(subjectRow[0], storage.subject)) {
    fail("application-install/protocol", "FRAM returned a malformed install state row");
  }

  let documents;
  try {
    documents = await fram.query(receiptDocumentsQuery(storage), {
      asOf: subjects.servedVersion,
      page: { limit: 2 },
      timeoutMs: QUERY_TIMEOUT_MS,
    });
  } catch (error) {
    fail(
      "application-install/unavailable",
      "application install document query failed",
      undefined,
      { cause: error },
    );
  }
  if (!plainObject(documents) || !Array.isArray(documents.result)
      || documents.servedVersion !== subjects.servedVersion || !plainObject(documents.page)
      || documents.page.done !== true) {
    fail("application-install/protocol", "FRAM returned malformed install documents");
  }
  if (documents.result.length !== 1) {
    fail(
      "application-install/receipt-mismatch",
      "application install receipt or compiled schema is missing or duplicated",
    );
  }
  const row = documents.result[0];
  if (!Array.isArray(row) || row.length !== 2) {
    fail("application-install/protocol", "FRAM returned malformed install documents");
  }
  return Object.freeze({
    document: checkedStoredString(row[0]),
    schemaDocument: checkedStoredString(row[1]),
    kind: "stored",
    servedVersion: documents.servedVersion,
  });
}

function classifyState(state, readyText, installingText, schemaText) {
  if (state.kind === "blank") return "blank";
  if (state.schemaDocument !== schemaText) {
    fail(
      "application-install/receipt-mismatch",
      "installed compiled schema does not match the checked artifacts",
    );
  }
  if (state.document === readyText) return "ready";
  if (state.document === installingText) return "installing";
  fail(
    "application-install/receipt-mismatch",
    "installed application state does not match the checked artifacts",
  );
}

function checkedSchemaResult(value, operation) {
  if (!plainObject(value) || typeof value.servedVersion !== "bigint") {
    fail(
      "application-install/protocol",
      `schema.${operation} returned an invalid result`,
    );
  }
  return value;
}

async function persistInstalling(schema, applicationId, storage, installingText, schemaText) {
  try {
    return checkedSchemaResult(await schema.transactUnique({
      creates: [{
        fields: [
          {
            cardinality: "single",
            predicate: storage.documentPredicate,
            value: string(installingText),
          },
          {
            cardinality: "single",
            predicate: storage.compiledSchemaPredicate,
            value: string(schemaText),
          },
        ],
        identity: {
          predicate: storage.identityPredicate,
          value: string(applicationId),
        },
        subject: storage.subject,
      }],
    }), "transactUnique");
  } catch {
    return null;
  }
}

async function finalize(schema, applicationId, storage, installingText, readyText) {
  try {
    return checkedSchemaResult(await schema.transactUnique({
      updates: [{
        fields: [{
          allowedCurrent: [string(installingText)],
          cardinality: "single",
          predicate: storage.documentPredicate,
          values: [string(readyText)],
        }],
        identity: {
          predicate: storage.identityPredicate,
          value: string(applicationId),
        },
      }],
    }), "transactUnique");
  } catch {
    return null;
  }
}

async function exactStateAfterWrite(fram, applicationId, storage, allowed, operation) {
  let state;
  try {
    state = await readState(fram, applicationId, storage);
  } catch (error) {
    fail(
      "application-install/ambiguous-outcome",
      `${operation} outcome could not be verified`,
      undefined,
      { cause: error },
    );
  }
  const classification = allowed(state);
  if (classification === null) {
    fail(
      "application-install/ambiguous-outcome",
      `${operation} did not produce the exact checked state`,
    );
  }
  return classification;
}

/**
 * Installs one checked Wake application. The callback receives only the
 * official schema client and must be idempotent because interrupted installs
 * resume it and ready installs reconcile it on every invocation.
 */
export async function installApplication({
  applicationId,
  deploymentReceipt,
  fram,
  initialize,
  manifest,
  plan,
  schema,
} = {}) {
  if (!fram || typeof fram.query !== "function") {
    fail("application-install/invalid-input", "fram.query is required");
  }
  if (!schema || ["createUnique", "transactUnique", "updateUnique", "updateUniqueMany"]
    .some(name => typeof schema[name] !== "function")) {
    fail("application-install/invalid-input", "schema must be the official Wake schema client");
  }
  if (typeof initialize !== "function") {
    fail("application-install/invalid-input", "initialize must be a function");
  }

  let prepared;
  try {
    prepared = prepareApplicationReceipt({
      applicationId,
      deploymentReceipt,
      manifest,
      plan,
    });
  } catch (error) {
    const code = error?.code === "receipt/invalid-input"
      ? "application-install/invalid-input"
      : error?.code === "receipt/artifact-mismatch"
        ? "application-install/artifact-mismatch"
        : "application-install/invalid-artifact";
    fail(code, "application artifacts are not a checked deployment closure", undefined, {
      cause: error,
    });
  }
  const applicationReceipt = prepared.applicationReceipt;
  const checkedPlan = deepFreeze(structuredClone(prepared.plan.value));
  const schemaDocument = compiledSchema(
    applicationReceipt,
    prepared.manifest.value,
    checkedPlan,
  );
  const installing = installingDocument(applicationReceipt, schemaDocument);
  const installingText = canonicalDocument(installing);
  const readyText = canonicalDocument(applicationReceipt);
  const schemaText = canonicalDocument(schemaDocument);
  const storage = receiptStorage(applicationId);

  let state = await readState(fram, applicationId, storage);
  let phase = classifyState(state, readyText, installingText, schemaText);
  if (phase === "blank") {
    const committed = await persistInstalling(
      schema,
      applicationId,
      storage,
      installingText,
      schemaText,
    );
    if (committed === null) {
      phase = await exactStateAfterWrite(
        fram,
        applicationId,
        storage,
        candidate => {
          const value = classifyState(candidate, readyText, installingText, schemaText);
          return value === "installing" || value === "ready" ? value : null;
        },
        "application install intent",
      );
    } else {
      phase = "installing";
    }
  }

  try {
    await initialize(Object.freeze({
      applicationReceipt,
      plan: checkedPlan,
      schema,
    }));
  } catch (error) {
    fail(
      "application-install/initialize-failed",
      "application principal initialization failed",
      undefined,
      { cause: error },
    );
  }

  if (phase === "installing") {
    const committed = await finalize(
      schema,
      applicationId,
      storage,
      installingText,
      readyText,
    );
    if (committed === null) {
      await exactStateAfterWrite(
        fram,
        applicationId,
        storage,
        candidate => classifyState(candidate, readyText, installingText, schemaText) === "ready"
          ? "ready"
          : null,
        "application install finalization",
      );
    }
  }

  const verified = await readState(fram, applicationId, storage);
  if (classifyState(verified, readyText, installingText, schemaText) !== "ready") {
    fail("application-install/receipt-mismatch", "application install did not reach ready state");
  }

  try {
    return await loadApplicationReceipt({
      applicationId,
      deploymentReceipt,
      fram,
      manifest,
      plan,
    });
  } catch (error) {
    fail(
      "application-install/receipt-mismatch",
      "final application receipt could not be verified",
      undefined,
      { cause: error },
    );
  }
}
