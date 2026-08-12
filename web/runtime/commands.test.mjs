import assert from "node:assert/strict";
import { test } from "bun:test";

import { CommandError, createCommandRuntime } from "./commands.mjs";

const fingerprint = `sha256:${"a".repeat(64)}`;
const stringType = Object.freeze({ kind: "string", minLength: 1, maxBytes: 1024 });
const nullableString = Object.freeze({ kind: "nullable", value: stringType });
const instantType = Object.freeze({ kind: "instant" });

const input = name => ({ kind: "input", name });
const injected = name => ({ kind: "injected", name });
const actor = name => ({ kind: "actor", name });
const literal = value => ({ kind: "literal", value });
const ifNull = (value, thenValue, elseValue) => ({
  kind: "if-null",
  value,
  then: thenValue,
  else: elseValue,
});

const listType = Object.freeze({ kind: "list", items: stringType, maxItems: 4 });

const receipt = Object.freeze({
  entity: "receipt",
  identityField: "id",
  actorField: "actor",
  commandField: "command",
  inputDigestField: "input-digest",
  createdAtField: "created-at",
  resultFields: [
    { name: "entry", field: "result-entry", type: stringType },
    { name: "version", field: "result-version", type: stringType },
  ],
});

const command = Object.freeze({
  name: "replace-release",
  capabilities: [{ capability: "release:replace" }],
  normalizerVersion: 1,
  input: [
    { name: "entry", type: stringType, required: true },
    { name: "expected", type: nullableString, required: true },
    { name: "content", type: stringType, required: true },
    { name: "links", type: listType, required: true },
  ],
  injections: [
    { name: "version", kind: "generated-id", type: stringType },
    {
      name: "digest",
      kind: "provider",
      provider: "content-digest",
      input: {
        kind: "record",
        fields: [{ name: "content", value: input("content") }],
      },
      type: stringType,
    },
    {
      name: "canonical",
      kind: "canonical-digest",
      input: {
        kind: "record",
        fields: [{ name: "content", value: input("content") }],
      },
      type: stringType,
    },
  ],
  steps: [
    { op: "assert", left: input("entry"), right: input("entry") },
    { op: "require", entity: "entry", identity: input("entry") },
    { op: "require-each", entity: "entry", identities: input("links") },
    {
      op: "guard",
      entity: "entry",
      identity: input("entry"),
      field: "links",
      equals: input("links"),
    },
    {
      op: "guard",
      entity: "entry",
      identity: input("entry"),
      field: "current-version",
      equals: input("expected"),
    },
    {
      op: "create",
      entity: "version",
      identity: injected("version"),
      fields: [
        { field: "entry", value: input("entry") },
        { field: "previous", value: input("expected"), omitIfNull: true },
        { field: "state", value: literal("candidate") },
        { field: "author", value: actor("id") },
        { field: "content", value: input("content") },
        { field: "digest", value: injected("digest") },
        { field: "created-at", value: { kind: "receipt-time" } },
        { field: "application", value: { kind: "artifact-digest" } },
      ],
    },
    {
      op: "update",
      entity: "entry",
      identity: input("entry"),
      fields: [{
        field: "current-version",
        value: injected("version"),
        allowedCurrent: input("expected"),
      }],
    },
    {
      op: "update",
      entity: "version",
      identity: input("expected"),
      when: { kind: "non-null", value: input("expected") },
      fields: [{
        field: "state",
        value: literal("superseded"),
        allowedCurrent: literal("released"),
      }],
    },
  ],
  result: [
    { name: "entry", type: stringType, value: input("entry") },
    { name: "version", type: stringType, value: injected("version") },
  ],
  receipt,
});

const plan = Object.freeze({
  applicationId: "neutral-release",
  backend: "fram",
  commands: [command],
  schemaVersion: 2,
  semanticFingerprint: fingerprint,
});

function subject(entity, identity) {
  return ["triple", ["keyword", "subject"], ["keyword", entity], ["string", identity]];
}

function predicate(entity, field) {
  return ["triple", ["keyword", "predicate"], ["keyword", entity], ["keyword", field]];
}

const refs = new Map([
  ["version/entry", "entry"],
  ["receipt/result-entry", "entry"],
  ["receipt/result-version", "version"],
]);

function storage() {
  return {
    identity(entity, value) {
      assert.equal(typeof value, "string");
      return {
        subject: subject(entity, value),
        predicate: predicate(entity, "id"),
        value: ["string", value],
      };
    },
    field(entity, field, value) {
      const target = refs.get(`${entity}/${field}`);
      if (value === undefined) {
        return {
          cardinality: field === "links" ? "multi" : "single",
          predicate: predicate(entity, field),
        };
      }
      if (target !== undefined) {
        return {
          cardinality: "single",
          predicate: predicate(entity, field),
          value: subject(target, value),
          requireUnique: [{
            subject: subject(target, value),
            predicate: predicate(target, "id"),
            value: ["string", value],
          }],
        };
      }
      const encoded = field === "created-at"
        ? ["instant", value.epochSeconds, String(value.nanos)]
        : ["string", value];
      return {
        cardinality: field === "links" ? "multi" : "single",
        predicate: predicate(entity, field),
        value: encoded,
      };
    },
  };
}

function harness(overrides = {}) {
  const calls = { ids: [], now: 0, providers: [], reads: [], transactions: [] };
  let receipts = [];
  const schema = {
    async transactUnique(transaction) {
      calls.transactions.push(transaction);
      return { servedVersion: 42n };
    },
  };
  const runtime = createCommandRuntime(plan, {
    async generateId(context) {
      calls.ids.push(context);
      return "version-2";
    },
    async now() {
      calls.now += 1;
      return { epochSeconds: "100", nanos: 25 };
    },
    providers: {
      async "content-digest"(value) {
        calls.providers.push(value);
        return "digest-v2";
      },
    },
    async readReceipt(entity, receiptId) {
      calls.reads.push({ entity, receiptId });
      return receipts.shift() ?? null;
    },
    schema,
    storage: storage(),
    ...overrides,
  });
  return { calls, runtime, schema, setReceipts(values) { receipts = [...values]; } };
}

const authority = Object.freeze({
  capabilities: Object.freeze(["release:replace"]),
  id: "actor-1",
});

function rejects(code) {
  return error => error instanceof CommandError && error.code === code;
}

test("receipt lookup precedes generated values, providers, guards, and transaction submission", async () => {
  const fixture = harness();
  fixture.setReceipts([{
    actor: "actor-1",
    command: "replace-release",
    "input-digest": "wrong",
    "result-entry": "entry-1",
    "result-version": "version-1",
  }]);

  await assert.rejects(
    fixture.runtime.invoke("replace-release", "request-1", {
      content: "new content",
      entry: "entry-1",
      expected: "version-1",
      links: ["entry-2", "entry-3"],
    }, authority),
    rejects("command/idempotency-conflict"),
  );
  assert.equal(fixture.calls.reads.length, 1);
  assert.equal(fixture.calls.now, 0);
  assert.deepEqual(fixture.calls.ids, []);
  assert.deepEqual(fixture.calls.providers, []);
  assert.deepEqual(fixture.calls.transactions, []);
});

test("compound command lowers mixed create, guarded updates, requirements, and receipt atomically", async () => {
  const fixture = harness();
  const result = await fixture.runtime.invoke("replace-release", "request-2", {
    content: "new content",
    entry: "entry-1",
    expected: "version-1",
    links: ["entry-2", "entry-3"],
  }, authority);

  assert.equal(result.replayed, false);
  assert.deepEqual(result.result, { entry: "entry-1", version: "version-2" });
  assert.equal(result.servedVersion, 42n);
  assert.equal(fixture.calls.transactions.length, 1);
  const transaction = fixture.calls.transactions[0];
  assert.deepEqual(transaction.creates.map(create => create.identity.value), [
    ["string", "version-2"],
    ["string", result.receiptId],
  ]);
  assert.equal(transaction.updates.length, 3);
  const fields = transaction.updates.flatMap(update => update.fields);
  const written = (entity, name) => fields.find(field => (
    JSON.stringify(field.predicate) === JSON.stringify(predicate(entity, name))
  ));
  assert.deepEqual(written("entry", "links"), {
    allowedCurrent: [["string", "entry-2"], ["string", "entry-3"]],
    cardinality: "multi",
    predicate: predicate("entry", "links"),
    values: [["string", "entry-2"], ["string", "entry-3"]],
  });
  assert.deepEqual(written("entry", "current-version"), {
    allowedCurrent: [["string", "version-1"]],
    cardinality: "single",
    predicate: predicate("entry", "current-version"),
    values: [["string", "version-2"]],
  });
  assert.deepEqual(written("version", "state"), {
    allowedCurrent: [["string", "released"]],
    cardinality: "single",
    predicate: predicate("version", "state"),
    values: [["string", "superseded"]],
  });
  assert.ok(transaction.requireUnique.some(requirement => (
    assert.deepEqual(requirement.subject, subject("entry", "entry-1")) === undefined
  )));
  assert.equal(fixture.calls.now, 1);
  assert.equal(fixture.calls.ids.length, 1);
  assert.deepEqual(fixture.calls.providers, [{ content: "new content" }]);
});

test("null branch lowers exact zero-or-one clear and omits conditional update", async () => {
  const fixture = harness();
  await fixture.runtime.invoke("replace-release", "request-clear", {
    content: "first content",
    entry: "entry-1",
    expected: null,
    links: [],
  }, authority);

  const transaction = fixture.calls.transactions[0];
  assert.equal(transaction.updates.length, 2);
  const pointer = transaction.updates.flatMap(update => update.fields).find(field => (
    JSON.stringify(field.predicate) === JSON.stringify(predicate("entry", "current-version"))
  ));
  assert.deepEqual(pointer, {
    allowedCurrent: [],
    cardinality: "single",
    predicate: predicate("entry", "current-version"),
    values: [["string", "version-2"]],
  });
});

test("ambiguous submit failure recovers the receipt without rerunning providers", async () => {
  let committedReceipt;
  const fixture = harness({
    schema: {
      async transactUnique(transaction) {
        fixture.calls.transactions.push(transaction);
        const receiptCreate = transaction.creates.at(-1);
        const decoded = Object.fromEntries(receiptCreate.fields.map(field => {
          const name = field.predicate[3][1];
          const value = name === "created-at"
            ? { epochSeconds: field.value[1], nanos: Number(field.value[2]) }
            : name.startsWith("result-")
              ? field.value[3][1]
              : field.value[1];
          return [name, value];
        }));
        committedReceipt = decoded;
        throw new Error("connection closed after commit");
      },
    },
    async readReceipt() {
      fixture.calls.reads.push(true);
      return committedReceipt ?? null;
    },
  });

  const result = await fixture.runtime.invoke("replace-release", "request-ambiguous", {
    content: "new content",
    entry: "entry-1",
    expected: "version-1",
    links: [],
  }, authority);

  assert.equal(result.replayed, true);
  assert.deepEqual(result.result, { entry: "entry-1", version: "version-2" });
  assert.equal(fixture.calls.providers.length, 1);
  assert.equal(fixture.calls.ids.length, 1);
  assert.equal(fixture.calls.now, 1);
  assert.equal(fixture.calls.reads.length, 2);
});

test("authority, input, provider, and plan failures occur before submission", async () => {
  const fixture = harness();
  await assert.rejects(
    fixture.runtime.invoke("replace-release", "request-3", {
      content: "new content",
      entry: "entry-1",
      expected: null,
      links: [],
    }, { id: "actor-1", capabilities: [] }),
    rejects("command/forbidden"),
  );
  await assert.rejects(
    fixture.runtime.invoke("replace-release", "request-4", {
      content: "",
      entry: "entry-1",
      expected: null,
      links: [],
    }, authority),
    rejects("command/invalid-input"),
  );
  assert.equal(fixture.calls.transactions.length, 0);

  assert.throws(
    () => createCommandRuntime({ ...plan, commands: [{ ...command, steps: [
      { op: "erase", entity: "entry", identity: input("entry") },
    ] }] }, {}),
    rejects("command/invalid-plan"),
  );
});

test("result-changing fields outside normalized caller input do not change its digest contract", async () => {
  const first = harness({ generateId: async () => "version-a" });
  const second = harness({ generateId: async () => "version-b" });
  const args = ["replace-release", "same-request", {
    content: "same content",
    entry: "entry-1",
    expected: null,
    links: [],
  }, authority];
  const a = await first.runtime.invoke(...args);
  const b = await second.runtime.invoke(...args);

  assert.equal(a.inputDigest, b.inputDigest);
  assert.equal(a.receiptId, b.receiptId);
  assert.notEqual(a.result.version, b.result.version);
});
