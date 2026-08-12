import assert from "node:assert/strict";
import { test } from "bun:test";

import { GatewayError, createFramGateway } from "./fram-gateway.mjs";

const keyword = value => ["keyword", value];
const string = value => ["string", value];
const triple = (t1, t2, t3) => ["triple", t1, t2, t3];
const APP = "wiki.app";
const SEMANTIC_FINGERPRINT = `sha256:${"a".repeat(64)}`;
const appScope = (app, value) => triple(keyword("wake/app"), keyword(app), value);
const subjectTemplate = (entity, identityField, app = APP) => appScope(
  app,
  triple(keyword("entity"), keyword(entity), { field: identityField }),
);
const subject = (entity, identity, app = APP) => appScope(
  app,
  triple(keyword("entity"), keyword(entity), string(identity)),
);
const predicate = (entity, field, app = APP) => appScope(
  app,
  triple(keyword("field"), keyword(entity), keyword(field)),
);

const PAGE = Object.freeze({
  slug: predicate("page", "slug"),
  title: predicate("page", "title"),
  canonical: predicate("page", "canonical-revision"),
  aliases: predicate("page", "aliases"),
});
const REVISION = Object.freeze({
  id: predicate("revision", "revision-id"),
  page: predicate("revision", "page"),
  body: predicate("revision", "body"),
  status: predicate("revision", "status"),
  links: predicate("revision", "links-to"),
});

const plan = {
  schemaVersion: 2,
  applicationId: APP,
  backend: "fram",
  semanticFingerprint: SEMANTIC_FINGERPRINT,
  pluginClosure: [],
  entities: [
    {
      name: "page",
      identity: {
        field: "slug",
        type: "String",
        cardinality: "single",
        valueKind: "literal",
        subjectTemplate: subjectTemplate("page", "slug"),
      },
      fields: [
        { name: "slug", type: "String", cardinality: "single", valueKind: "literal", write: "set", predicateTerm: PAGE.slug },
        { name: "title", type: "String", cardinality: "single", valueKind: "literal", write: "set", predicateTerm: PAGE.title },
        {
          name: "canonical-revision",
          type: "Ref",
          cardinality: "single",
          valueKind: "ref",
          write: "command",
          predicateTerm: PAGE.canonical,
          targetEntity: "revision",
        },
        { name: "aliases", type: "String", cardinality: "multi", valueKind: "literal", write: "set", predicateTerm: PAGE.aliases },
      ],
    },
    {
      name: "revision",
      identity: {
        field: "revision-id",
        type: "String",
        cardinality: "single",
        valueKind: "literal",
        subjectTemplate: subjectTemplate("revision", "revision-id"),
      },
      fields: [
        { name: "revision-id", type: "String", cardinality: "single", valueKind: "literal", write: "set", predicateTerm: REVISION.id },
        {
          name: "page",
          type: "Ref",
          cardinality: "single",
          valueKind: "ref",
          write: "create",
          predicateTerm: REVISION.page,
          targetEntity: "page",
        },
        { name: "body", type: "String", cardinality: "single", valueKind: "literal", write: "create", predicateTerm: REVISION.body },
        {
          name: "status",
          type: "RevisionStatus",
          cardinality: "single",
          valueKind: "literal",
          write: "command",
          predicateTerm: REVISION.status,
        },
        {
          name: "links-to",
          type: "Ref",
          cardinality: "multi",
          valueKind: "ref",
          write: "create",
          predicateTerm: REVISION.links,
          targetEntity: "page",
        },
      ],
    },
  ],
  stateMachines: [{
    entity: "revision",
    field: "status",
    stateType: "RevisionStatus",
    initial: "draft",
    transitions: {
      draft: ["canonical", "obsolete"],
      canonical: ["obsolete"],
      obsolete: [],
    },
  }],
  publications: [{
    name: "canonical",
    owner: { entity: "page", pointer: "canonical-revision" },
    revision: { entity: "revision", ownerField: "page", stateField: "status" },
    states: { draft: "draft", published: "canonical", retired: "obsolete" },
  }],
};

function planForApp(app) {
  const scoped = structuredClone(plan);
  scoped.applicationId = app;
  for (const entity of scoped.entities) {
    entity.identity.subjectTemplate = subjectTemplate(
      entity.name,
      entity.identity.field,
      app,
    );
    for (const field of entity.fields) {
      field.predicateTerm = predicate(entity.name, field.name, app);
    }
  }
  return scoped;
}

function mocks(responses = [], schemaOverrides = {}) {
  const calls = { query: [], createUnique: [], updateUnique: [], updateUniqueMany: [] };
  const queue = [...responses];
  return {
    calls,
    fram: {
      async query(query, options) {
        calls.query.push({ query, options });
        assert.ok(queue.length > 0, "unexpected FRAM query");
        return queue.shift();
      },
    },
    schema: {
      async createUnique(input) {
        calls.createUnique.push(input);
        return { subject: input.subject, created: true, changed: true, servedVersion: 31n, result: [] };
      },
      async updateUnique(input) {
        calls.updateUnique.push(input);
        return { subject: subject("page", "home"), created: false, changed: true, servedVersion: 32n, result: [] };
      },
      async updateUniqueMany(input) {
        calls.updateUniqueMany.push(input);
        return {
          subjects: input.updates.map(update => update.identity.value),
          changed: true,
          servedVersion: 33n,
          result: [],
        };
      },
      ...schemaOverrides,
    },
  };
}

function gatewayWith(responses = [], schemaOverrides = {}) {
  const mock = mocks(responses, schemaOverrides);
  return { ...mock, gateway: createFramGateway(plan, mock) };
}

function rejectsCode(code) {
  return error => error instanceof GatewayError && error.code === code;
}

test("list uses one structured, cursor-pinned read and merges single, multi, and ref fields", async () => {
  const home = subject("page", "home");
  const revision = subject("revision", "rev-1");
  const cursor = triple(keyword("cursor"), string("page"), ["integer", "1"]);
  const { gateway, calls } = gatewayWith([
    {
      servedVersion: 12n,
      result: [
        [home, PAGE.slug, string("home")],
        [home, PAGE.title, string("Home")],
        [home, PAGE.aliases, string("wiki")],
      ],
      page: { done: false, nextCursor: cursor },
    },
    {
      servedVersion: 12n,
      result: [
        [home, PAGE.canonical, revision],
        [home, PAGE.aliases, string("start")],
        [home, PAGE.aliases, string("wiki")],
      ],
      page: { done: true, nextCursor: null },
    },
  ]);

  assert.deepEqual(await gateway.list("page"), {
    rows: [{
      slug: "home",
      title: "Home",
      "canonical-revision": "rev-1",
      aliases: ["wiki", "start"],
    }],
    servedVersion: 12n,
  });

  assert.equal(calls.query.length, 2);
  assert.deepEqual(calls.query[0], {
    query: {
      find: "wake/read/page",
      rules: [{
        head: {
          rel: "wake/read/page",
          args: [{ var: "subject" }, { var: "predicate" }, { var: "value" }],
        },
        body: [
          {
            rel: "triple",
            args: [{ var: "subject" }, PAGE.slug, { var: "identity" }],
          },
          {
            rel: "triple",
            args: [{ var: "subject" }, { var: "predicate" }, { var: "value" }],
          },
        ],
      }],
    },
    options: { timeoutMs: 5_000, page: { limit: 128 } },
  });
  assert.deepEqual(calls.query[1].options, { timeoutMs: 5_000, page: { limit: 128, cursor } });
});

test("list fails with a stable result limit instead of draining without bound", async () => {
  const responses = Array.from({ length: 32 }, (_, index) => ({
    servedVersion: 12n,
    result: Array.from({ length: 128 }, () => []),
    page: {
      done: false,
      nextCursor: triple(keyword("cursor"), string("page"), ["integer", String(index + 1)]),
    },
  }));
  const { gateway, calls } = gatewayWith(responses);

  await assert.rejects(gateway.list("page"), rejectsCode("gateway/result-limit"));
  assert.equal(calls.query.length, 32);
});

test("get realizes the typed identity subject without flattening recursive Terms", async () => {
  const home = subject("page", "home");
  const { gateway, calls } = gatewayWith([{
    servedVersion: 18n,
    result: [
      [home, PAGE.slug, string("home")],
      [home, PAGE.title, string("Home")],
    ],
    page: null,
  }]);

  assert.deepEqual(await gateway.get("page", "home"), {
    row: { slug: "home", aliases: [], title: "Home" },
    servedVersion: 18n,
  });
  assert.deepEqual(calls.query[0].query.rules[0].body[0], {
    rel: "triple",
    args: [home, PAGE.slug, string("home")],
  });
  assert.deepEqual(calls.query[0].query.rules[0].head.args[0], home);
});

test("decoded rows preserve prototype-shaped field names as own data", async () => {
  const special = structuredClone(plan);
  const page = special.entities.find(entity => entity.name === "page");
  const specialFields = ["__proto__", "constructor", "prototype"].map(name => ({
    name,
    type: "String",
    cardinality: "single",
    valueKind: "literal",
    write: "set",
    predicateTerm: predicate("page", name),
  }));
  page.fields.push(...specialFields);

  const home = subject("page", "home");
  const mock = mocks([{
    servedVersion: 19n,
    result: [
      [home, PAGE.slug, string("home")],
      ...specialFields.map(field => [
        home,
        field.predicateTerm,
        string(`${field.name}-value`),
      ]),
    ],
    page: null,
  }]);
  const gateway = createFramGateway(special, mock);
  const result = await gateway.list("page");
  const row = result.rows[0];

  assert.equal(Object.getPrototypeOf(row), Object.prototype);
  for (const field of specialFields) {
    assert.equal(Object.hasOwn(row, field.name), true, field.name);
    assert.equal(row[field.name], `${field.name}-value`);
  }

  const decoded = JSON.parse(JSON.stringify(result, (_key, value) => (
    typeof value === "bigint" ? value.toString() : value
  )));
  const consumed = { ...decoded.rows[0], eid: 1 };
  for (const field of specialFields) {
    assert.equal(Object.hasOwn(consumed, field.name), true, field.name);
    assert.equal(consumed[field.name], `${field.name}-value`);
  }
});

test("create requires its identity and delegates exact typed fields to createUnique", async () => {
  const { gateway, calls } = gatewayWith();

  assert.deepEqual(await gateway.create("page", {
    slug: "home",
    title: "Home",
    aliases: ["wiki", "start"],
  }), { created: true, identity: "home", servedVersion: 31n });

  assert.deepEqual(calls.createUnique, [{
    subject: subject("page", "home"),
    identity: { predicate: PAGE.slug, value: string("home") },
    fields: [
      { predicate: PAGE.title, value: string("Home"), cardinality: "single" },
      { predicate: PAGE.aliases, value: string("wiki"), cardinality: "multi" },
      { predicate: PAGE.aliases, value: string("start"), cardinality: "multi" },
    ],
  }]);

  await assert.rejects(gateway.create("page", { title: "No identity" }), rejectsCode("gateway/missing-identity"));
  await assert.rejects(
    gateway.create("page", { slug: "bad", mystery: "unknown" }),
    rejectsCode("gateway/unknown-field"),
  );
  await assert.rejects(
    gateway.create("page", { slug: "bad", "canonical-revision": "rev-1" }),
    rejectsCode("gateway/write-policy"),
  );
  assert.equal(calls.createUnique.length, 1);
});

test("create defaults command-only lifecycle state and requires every ref", async () => {
  const { gateway, calls } = gatewayWith();

  assert.deepEqual(await gateway.create("revision", {
    "revision-id": "rev-1",
    page: "home",
    body: "First draft",
    "links-to": ["about", "home"],
  }), { created: true, identity: "rev-1", servedVersion: 31n });

  assert.deepEqual(calls.createUnique[0], {
    subject: subject("revision", "rev-1"),
    identity: { predicate: REVISION.id, value: string("rev-1") },
    fields: [
      { predicate: REVISION.page, value: subject("page", "home"), cardinality: "single" },
      { predicate: REVISION.body, value: string("First draft"), cardinality: "single" },
      { predicate: REVISION.status, value: keyword("draft"), cardinality: "single" },
      { predicate: REVISION.links, value: subject("page", "about"), cardinality: "multi" },
      { predicate: REVISION.links, value: subject("page", "home"), cardinality: "multi" },
    ],
    requireUnique: [
      { subject: subject("page", "home"), predicate: PAGE.slug, value: string("home") },
      { subject: subject("page", "about"), predicate: PAGE.slug, value: string("about") },
    ],
  });

  await assert.rejects(
    gateway.create("revision", { "revision-id": "rev-2", status: "canonical" }),
    rejectsCode("gateway/write-policy"),
  );
  assert.equal(calls.createUnique.length, 1);
});

test("set protects identity and enforces field write policy", async () => {
  const { gateway, calls } = gatewayWith();

  await assert.rejects(
    gateway.set("page", "home", "slug", "renamed"),
    rejectsCode("gateway/identity-mutation"),
  );
  await assert.rejects(
    gateway.set("missing", "home", "title", "Nope"),
    rejectsCode("gateway/unknown-entity"),
  );
  await assert.rejects(
    gateway.set("page", "home", "missing", "Nope"),
    rejectsCode("gateway/unknown-field"),
  );

  await assert.rejects(
    gateway.set("page", "home", "canonical-revision", "rev-2"),
    rejectsCode("gateway/write-policy"),
  );
  await assert.rejects(
    gateway.set("revision", "rev-1", "body", "rewritten"),
    rejectsCode("gateway/write-policy"),
  );

  assert.deepEqual(await gateway.set("page", "home", "title", "New home"), {
    changed: true,
    identity: "home",
    servedVersion: 32n,
  });
  assert.deepEqual(calls.updateUnique, [{
    identity: { predicate: PAGE.slug, value: string("home") },
    field: {
      predicate: PAGE.title,
      values: [string("New home")],
      cardinality: "single",
    },
    requireUnique: [
      { subject: subject("page", "home"), predicate: PAGE.slug, value: string("home") },
    ],
  }]);
});

test("set replaces a mutable multi field atomically", async () => {
  const { gateway, calls } = gatewayWith();

  assert.deepEqual(await gateway.set("page", "home", "aliases", ["wiki", "about", "wiki"]), {
    changed: true,
    identity: "home",
    servedVersion: 32n,
  });
  assert.deepEqual(calls.updateUnique[0], {
    identity: { predicate: PAGE.slug, value: string("home") },
    field: {
      predicate: PAGE.aliases,
      values: [string("wiki"), string("about"), string("wiki")],
      cardinality: "multi",
    },
    requireUnique: [
      { subject: subject("page", "home"), predicate: PAGE.slug, value: string("home") },
    ],
  });

  await gateway.set("page", "home", "aliases", []);
  assert.deepEqual(calls.updateUnique[1], {
    identity: { predicate: PAGE.slug, value: string("home") },
    field: { predicate: PAGE.aliases, values: [], cardinality: "multi" },
    requireUnique: [{
      subject: subject("page", "home"),
      predicate: PAGE.slug,
      value: string("home"),
    }],
  });
});

test("generic set cannot bypass command-only lifecycle policy", async () => {
  const { gateway, calls } = gatewayWith();

  await assert.rejects(
    gateway.set("revision", "rev-1", "status", "canonical"),
    rejectsCode("gateway/write-policy"),
  );
  assert.equal(calls.updateUnique.length, 0);
});

test("publish atomically swaps the pointer, publishes the candidate, and retires the prior revision", async () => {
  const { gateway, calls } = gatewayWith();

  assert.deepEqual(
    await gateway.publish("canonical", "home", "rev-2", "rev-1"),
    {
      changed: true,
      owner: "home",
      revision: "rev-2",
      previous: "rev-1",
      servedVersion: 33n,
    },
  );
  assert.equal(calls.query.length, 0);
  assert.deepEqual(calls.updateUniqueMany, [{
    updates: [
      {
        identity: { predicate: PAGE.slug, value: string("home") },
        fields: [{
          predicate: PAGE.canonical,
          values: [subject("revision", "rev-2")],
          cardinality: "single",
          allowedCurrent: [subject("revision", "rev-1")],
        }],
      },
      {
        identity: { predicate: REVISION.id, value: string("rev-2") },
        fields: [
          {
            predicate: REVISION.page,
            values: [subject("page", "home")],
            cardinality: "single",
            allowedCurrent: [subject("page", "home")],
          },
          {
            predicate: REVISION.status,
            values: [keyword("canonical")],
            cardinality: "single",
            allowedCurrent: [keyword("draft"), keyword("canonical")],
          },
        ],
      },
      {
        identity: { predicate: REVISION.id, value: string("rev-1") },
        fields: [
          {
            predicate: REVISION.page,
            values: [subject("page", "home")],
            cardinality: "single",
            allowedCurrent: [subject("page", "home")],
          },
          {
            predicate: REVISION.status,
            values: [keyword("obsolete")],
            cardinality: "single",
            allowedCurrent: [keyword("canonical"), keyword("obsolete")],
          },
        ],
      },
    ],
    requireUnique: [
      {
        subject: subject("page", "home"),
        predicate: PAGE.slug,
        value: string("home"),
      },
      {
        subject: subject("revision", "rev-2"),
        predicate: REVISION.id,
        value: string("rev-2"),
      },
      {
        subject: subject("revision", "rev-1"),
        predicate: REVISION.id,
        value: string("rev-1"),
      },
    ],
  }]);
});

test("publish uses an absence CAS and omits the prior revision when the pointer is empty", async () => {
  const { gateway, calls } = gatewayWith();

  await gateway.publish("canonical", "home", "rev-1", null);

  const call = calls.updateUniqueMany[0];
  assert.deepEqual(call.updates[0].fields[0].allowedCurrent, []);
  assert.equal(call.updates.length, 2);
  assert.equal(call.requireUnique.length, 2);
});

test("republishing the current revision is idempotent without a duplicate update target", async () => {
  const { gateway, calls } = gatewayWith();

  await gateway.publish("canonical", "home", "rev-1", "rev-1");

  const call = calls.updateUniqueMany[0];
  assert.equal(call.updates.length, 2);
  assert.equal(call.requireUnique.length, 2);
  assert.deepEqual(call.updates[0].fields[0].allowedCurrent, [subject("revision", "rev-1")]);
});

test("competing publication CAS failures propagate without a discovery read or Wake retry", async () => {
  const stale = Object.assign(new Error("pointer moved"), {
    code: "schema/current-value-rejected",
  });
  let attempts = 0;
  const { gateway, calls } = gatewayWith([], {
    async updateUniqueMany(input) {
      calls.updateUniqueMany.push(input);
      attempts += 1;
      if (attempts === 2) throw stale;
      return {
        subjects: input.updates.map(update => update.identity.value),
        changed: true,
        servedVersion: 33n,
        result: [],
      };
    },
  });

  await gateway.publish("canonical", "home", "rev-2", "rev-1");
  await assert.rejects(
    gateway.publish("canonical", "home", "rev-3", "rev-1"),
    error => error === stale,
  );
  assert.equal(calls.updateUniqueMany.length, 2);
  assert.equal(calls.query.length, 0);
});

test("publish rejects unknown policies and requires the batch schema primitive", async () => {
  const { gateway } = gatewayWith();
  await assert.rejects(
    gateway.publish("missing", "home", "rev-2", null),
    rejectsCode("gateway/unknown-publication"),
  );
  assert.throws(
    () => createFramGateway(plan, {
      fram: { query() {} },
      schema: { createUnique() {}, updateUnique() {} },
    }),
    rejectsCode("gateway/invalid-client"),
  );
});

test("schema constraint failures propagate unchanged", async () => {
  const failure = Object.assign(new Error("foreign sole owner"), {
    code: "schema/required-identity-missing",
  });
  const { gateway } = gatewayWith([], {
    async updateUnique() {
      throw failure;
    },
  });

  await assert.rejects(
    gateway.set("page", "foreign-owned", "title", "Rejected"),
    error => error === failure,
  );
});

test("changes queries the occurrence relation with an exact since selector", async () => {
  const pageChange = triple(subject("page", "home"), PAGE.title, string("New home"));
  const revisionChange = triple(subject("revision", "rev-1"), REVISION.body, string("Body"));
  const unrelated = triple(string("external"), keyword("external/predicate"), string("value"));
  const { gateway, calls } = gatewayWith([{
    servedVersion: 44n,
    result: [
      [triple(keyword("tx"), ["integer", "44"], ["integer", "0"]), keyword("assert"), revisionChange],
      [triple(keyword("tx"), ["integer", "43"], ["integer", "0"]), keyword("retract"), pageChange],
      [triple(keyword("tx"), ["integer", "42"], ["integer", "0"]), keyword("assert"), unrelated],
      [triple(keyword("tx"), ["integer", "43"], ["integer", "1"]), keyword("assert"), pageChange],
    ],
    page: { done: true, nextCursor: null },
  }]);

  assert.deepEqual(await gateway.changes(40n), {
    changes: [
      { entity: "page", identities: ["home"] },
      { entity: "revision", identities: ["rev-1"] },
    ],
    servedVersion: 44n,
  });
  assert.deepEqual(calls.query[0].query, {
    find: "wake/changes",
    rules: [{
      head: {
        rel: "wake/changes",
        args: [{ var: "where" }, { var: "action" }, { var: "proposition" }],
      },
      body: [{
        rel: "occurrence",
        args: [{ var: "where" }, { var: "action" }, { var: "proposition" }],
      }],
    }],
  });
  assert.deepEqual(calls.query[0].options, {
    timeoutMs: 5_000,
    since: { lowerExclusive: 40n, upper: "current" },
    page: { limit: 128 },
  });
});

test("changes requests a full resync when cursor draining reaches its page bound", async () => {
  const responses = Array.from({ length: 32 }, (_, index) => ({
    servedVersion: 44n,
    result: [],
    page: {
      done: false,
      nextCursor: triple(keyword("cursor"), string("changes"), ["integer", String(index + 1)]),
    },
  }));
  const { gateway, calls } = gatewayWith(responses);

  assert.deepEqual(await gateway.changes(40n), {
    resync: true,
    changes: [],
    servedVersion: 44n,
  });
  assert.equal(calls.query.length, 32);
});

test("gateway rejects empty or relabeled app scopes", () => {
  const mock = mocks();
  const mismatchedPredicate = planForApp("other.app");
  mismatchedPredicate.entities[0].fields[0].predicateTerm = PAGE.slug;
  assert.throws(
    () => createFramGateway({ ...plan, applicationId: "" }, mock),
    rejectsCode("gateway/invalid-plan"),
  );
  assert.throws(
    () => createFramGateway({ ...plan, applicationId: "other.app" }, mock),
    rejectsCode("gateway/invalid-plan"),
  );
  assert.throws(
    () => createFramGateway(mismatchedPredicate, mock),
    rejectsCode("gateway/invalid-plan"),
  );
  assert.doesNotThrow(() => createFramGateway(planForApp("other.app"), mock));
});

test("gateway accepts only the current plan-v2 application envelope", () => {
  const mock = mocks();
  for (const invalid of [
    { ...plan, schemaVersion: 1 },
    { ...plan, semanticFingerprint: "sha256:not-a-digest" },
    { ...plan, pluginClosure: null },
    { ...plan, pluginClosure: ["wake-wiki"] },
  ]) {
    assert.throws(
      () => createFramGateway(invalid, mock),
      rejectsCode("gateway/invalid-plan"),
    );
  }
});

test("app-scoped Terms isolate same-named schemas in one FRAM database", async () => {
  const foreignApp = "other.app";
  const foreignPlan = planForApp(foreignApp);
  const localHome = subject("page", "home");
  const foreignHome = subject("page", "home", foreignApp);
  const foreignSlug = predicate("page", "slug", foreignApp);
  const foreignTitle = predicate("page", "title", foreignApp);

  assert.notDeepEqual(localHome, foreignHome);
  assert.notDeepEqual(PAGE.slug, foreignSlug);

  const sharedWrites = mocks();
  const localWriter = createFramGateway(plan, sharedWrites);
  const foreignWriter = createFramGateway(foreignPlan, sharedWrites);
  await localWriter.create("page", { slug: "home", title: "Local home" });
  await foreignWriter.create("page", { slug: "home", title: "Foreign home" });
  assert.deepEqual(
    sharedWrites.calls.createUnique.map(call => call.subject),
    [localHome, foreignHome],
  );
  assert.notDeepEqual(
    sharedWrites.calls.createUnique[0].identity.predicate,
    sharedWrites.calls.createUnique[1].identity.predicate,
  );

  const mixedRead = {
    servedVersion: 60n,
    result: [
      [localHome, PAGE.slug, string("home")],
      [localHome, PAGE.title, string("Local home")],
      [foreignHome, foreignSlug, string("home")],
      [foreignHome, foreignTitle, string("Foreign home")],
    ],
    page: null,
  };
  const localRead = mocks([mixedRead]);
  const foreignRead = mocks([mixedRead]);
  assert.deepEqual(
    await createFramGateway(plan, localRead).list("page"),
    {
      rows: [{ slug: "home", aliases: [], title: "Local home" }],
      servedVersion: 60n,
    },
  );
  assert.deepEqual(
    await createFramGateway(foreignPlan, foreignRead).list("page"),
    {
      rows: [{ slug: "home", aliases: [], title: "Foreign home" }],
      servedVersion: 60n,
    },
  );
  assert.deepEqual(
    localRead.calls.query[0].query.rules[0].body[0].args[1],
    PAGE.slug,
  );
  assert.deepEqual(
    foreignRead.calls.query[0].query.rules[0].body[0].args[1],
    foreignSlug,
  );

  const localChanged = subject("page", "local-change");
  const foreignChanged = subject("page", "foreign-change", foreignApp);
  const mixedChanges = {
    servedVersion: 61n,
    result: [
      [
        triple(keyword("tx"), ["integer", "61"], ["integer", "0"]),
        keyword("assert"),
        triple(localChanged, PAGE.title, string("Local change")),
      ],
      [
        triple(keyword("tx"), ["integer", "61"], ["integer", "1"]),
        keyword("assert"),
        triple(foreignChanged, foreignTitle, string("Foreign change")),
      ],
    ],
    page: null,
  };
  const localChanges = mocks([mixedChanges]);
  const foreignChanges = mocks([mixedChanges]);
  assert.deepEqual(
    await createFramGateway(plan, localChanges).changes(60n),
    {
      changes: [{ entity: "page", identities: ["local-change"] }],
      servedVersion: 61n,
    },
  );
  assert.deepEqual(
    await createFramGateway(foreignPlan, foreignChanges).changes(60n),
    {
      changes: [{ entity: "page", identities: ["foreign-change"] }],
      servedVersion: 61n,
    },
  );
});

function float64(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, false);
  return ["float64", Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")];
}

function realizeTestTemplate(template, identity) {
  if (template !== null && typeof template === "object" && !Array.isArray(template)
      && Object.keys(template).length === 1 && typeof template.field === "string") {
    return identity;
  }
  return Array.isArray(template)
    ? template.map(part => realizeTestTemplate(part, identity))
    : template;
}

function numericPlan() {
  const numeric = structuredClone(plan);
  const page = numeric.entities.find(entity => entity.name === "page");
  page.identity.type = "Float";
  page.fields.find(field => field.name === "slug").type = "Float";
  page.fields.find(field => field.name === "title").type = "Number";
  page.fields.find(field => field.name === "aliases").type = "Float";
  return numeric;
}

function numericGateway(responses = []) {
  const numeric = numericPlan();
  const mock = mocks(responses);
  return { ...mock, plan: numeric, gateway: createFramGateway(numeric, mock) };
}

test("Float identities and Number fields accept every finite JSON-exact value", async () => {
  const { gateway, calls, plan: numeric } = numericGateway();
  const page = numeric.entities.find(entity => entity.name === "page");
  const slug = page.fields.find(field => field.name === "slug").predicateTerm;
  const title = page.fields.find(field => field.name === "title").predicateTerm;
  const aliases = page.fields.find(field => field.name === "aliases").predicateTerm;
  const identity = float64(1.25);

  assert.deepEqual(await gateway.create("page", {
    slug: 1.25,
    title: -2.5,
    aliases: [0, Number.MIN_VALUE, Number.MAX_VALUE],
  }), { created: true, identity: 1.25, servedVersion: 31n });
  assert.deepEqual(calls.createUnique, [{
    subject: realizeTestTemplate(page.identity.subjectTemplate, identity),
    identity: { predicate: slug, value: identity },
    fields: [
      { predicate: title, value: float64(-2.5), cardinality: "single" },
      { predicate: aliases, value: float64(0), cardinality: "multi" },
      { predicate: aliases, value: float64(Number.MIN_VALUE), cardinality: "multi" },
      { predicate: aliases, value: float64(Number.MAX_VALUE), cardinality: "multi" },
    ],
  }]);

  assert.deepEqual(await gateway.set("page", 1.25, "title", 3.5), {
    changed: true,
    identity: 1.25,
    servedVersion: 32n,
  });
  assert.deepEqual(calls.updateUnique[0], {
    identity: { predicate: slug, value: identity },
    field: { predicate: title, values: [float64(3.5)], cardinality: "single" },
    requireUnique: [{
      subject: realizeTestTemplate(page.identity.subjectTemplate, identity),
      predicate: slug,
      value: identity,
    }],
  });
});

test("Float identities and fields reject non-finite values and negative zero before schema I/O", async () => {
  const { gateway, calls } = numericGateway();

  for (const invalid of [NaN, Infinity, -Infinity, -0]) {
    await assert.rejects(
      gateway.create("page", { slug: invalid, title: 1 }),
      rejectsCode("gateway/type-mismatch"),
    );
    await assert.rejects(
      gateway.create("page", { slug: 2, title: invalid }),
      rejectsCode("gateway/type-mismatch"),
    );
    await assert.rejects(
      gateway.create("page", { slug: 2, title: 1, aliases: [invalid] }),
      rejectsCode("gateway/type-mismatch"),
    );
    await assert.rejects(
      gateway.set("page", invalid, "title", 1),
      rejectsCode("gateway/type-mismatch"),
    );
    await assert.rejects(
      gateway.set("page", 2, "title", invalid),
      rejectsCode("gateway/type-mismatch"),
    );
  }

  assert.equal(calls.createUnique.length, 0);
  assert.equal(calls.updateUnique.length, 0);
});

test("FRAM reads reject non-JSON-exact Float identities and fields", async () => {
  const numeric = numericPlan();
  const page = numeric.entities.find(entity => entity.name === "page");
  const slug = page.fields.find(field => field.name === "slug").predicateTerm;
  const title = page.fields.find(field => field.name === "title").predicateTerm;

  const finiteIdentity = float64(1.25);
  const finiteSubject = realizeTestTemplate(page.identity.subjectTemplate, finiteIdentity);
  const finite = numericGateway([{
    servedVersion: 50n,
    result: [
      [finiteSubject, slug, finiteIdentity],
      [finiteSubject, title, float64(-2.5)],
    ],
    page: null,
  }]);
  assert.deepEqual(await finite.gateway.list("page"), {
    rows: [{ slug: 1.25, aliases: [], title: -2.5 }],
    servedVersion: 50n,
  });

  for (const invalid of [NaN, Infinity, -Infinity, -0]) {
    const invalidTerm = float64(invalid);
    const invalidSubject = realizeTestTemplate(page.identity.subjectTemplate, invalidTerm);
    const invalidIdentity = numericGateway([{
      servedVersion: 51n,
      result: [[invalidSubject, slug, invalidTerm]],
      page: null,
    }]);
    await assert.rejects(
      invalidIdentity.gateway.list("page"),
      rejectsCode("gateway/data-integrity"),
    );

    const invalidField = numericGateway([{
      servedVersion: 52n,
      result: [
        [finiteSubject, slug, finiteIdentity],
        [finiteSubject, title, invalidTerm],
      ],
      page: null,
    }]);
    await assert.rejects(
      invalidField.gateway.list("page"),
      rejectsCode("gateway/data-integrity"),
    );
  }
});
