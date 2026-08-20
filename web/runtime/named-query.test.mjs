import { describe, expect, test } from "bun:test";

import {
  NamedQueryError,
  compileNamedQueries,
  createNamedQueryRuntime,
} from "./named-query.mjs";

const keyword = value => ["keyword", value];
const string = value => ["string", value];
const triple = (t1, t2, t3) => ["triple", t1, t2, t3];
const canonicalDigest = `sha256:${"a".repeat(64)}`;
const storageId = (entity, field) => `example/field/${entity}/${field}`;
const predicate = (entity, field) => triple(
  keyword("wake/field"),
  keyword(entity),
  keyword(storageId(entity, field)),
);
const subjectTemplate = entity => triple(
  keyword("wake/entity"),
  keyword(entity),
  { field: storageId(entity, "id") },
);
const subject = (entity, id) => triple(keyword("wake/entity"), keyword(entity), string(id));

function field(entity, name, type, {
  cardinality = "single",
  valueKind = "literal",
  targetEntity,
} = {}) {
  return {
    name,
    storageId: storageId(entity, name),
    type,
    cardinality,
    valueKind,
    predicateTerm: predicate(entity, name),
    ...(targetEntity === undefined ? {} : { targetEntity }),
  };
}

const entities = [
  {
    name: "release",
    identity: {
      field: "id",
      storageId: storageId("release", "id"),
      type: "String",
      cardinality: "single",
      valueKind: "literal",
      subjectTemplate: subjectTemplate("release"),
    },
    fields: [
      field("release", "id", "String"),
      field("release", "title", "String"),
      field("release", "channel", "Keyword"),
      field("release", "digest", "Digest"),
      field("release", "tags", "String", { cardinality: "multi" }),
      field("release", "owner", "Ref", { valueKind: "ref", targetEntity: "person" }),
    ],
  },
  {
    name: "person",
    identity: {
      field: "id",
      storageId: storageId("person", "id"),
      type: "String",
      cardinality: "single",
      valueKind: "literal",
      subjectTemplate: subjectTemplate("person"),
    },
    fields: [
      field("person", "id", "String"),
      field("person", "name", "String"),
    ],
  },
];

const pageQuery = {
  name: "releases-by-channel",
  capabilities: ["release:read", "release:review"],
  parameters: [{ name: "channel", type: "Keyword" }],
  bindings: [{ name: "release", entity: "release" }],
  where: [{
    op: "eq",
    left: {
      kind: "field",
      binding: "release",
      entity: "release",
      field: "channel",
      type: "Keyword",
    },
    right: { kind: "parameter", name: "channel", type: "Keyword" },
  }],
  select: [
    {
      name: "id",
      binding: "release",
      entity: "release",
      field: "id",
      type: "String",
      cardinality: "single",
      valueKind: "literal",
    },
    {
      name: "title",
      binding: "release",
      entity: "release",
      field: "title",
      type: "String",
      cardinality: "single",
      valueKind: "literal",
    },
  ],
  resultProviders: [],
  result: { kind: "page", defaultLimit: 2, maxLimit: 5 },
  dependencies: [
    { entity: "release", field: "id" },
    { entity: "release", field: "channel" },
    { entity: "release", field: "title" },
  ],
};

const oneQuery = {
  name: "release-by-id",
  capabilities: ["release:read"],
  parameters: [{ name: "id", type: "String" }],
  bindings: [
    { name: "release", entity: "release" },
    { name: "owner", entity: "person" },
  ],
  where: [
    {
      op: "eq",
      left: {
        kind: "field",
        binding: "release",
        entity: "release",
        field: "id",
        type: "String",
      },
      right: { kind: "parameter", name: "id", type: "String" },
    },
    {
      op: "eq",
      left: {
        kind: "field",
        binding: "release",
        entity: "release",
        field: "owner",
        type: "Ref",
        targetEntity: "person",
      },
      right: { kind: "binding", binding: "owner", entity: "person" },
    },
  ],
  select: [
    {
      name: "id",
      binding: "release",
      entity: "release",
      field: "id",
      type: "String",
      cardinality: "single",
      valueKind: "literal",
    },
    {
      name: "title",
      binding: "release",
      entity: "release",
      field: "title",
      type: "String",
      cardinality: "single",
      valueKind: "literal",
    },
    {
      name: "tags",
      binding: "release",
      entity: "release",
      field: "tags",
      type: "String",
      cardinality: "multi",
      valueKind: "literal",
    },
    {
      name: "owner",
      binding: "release",
      entity: "release",
      field: "owner",
      type: "Ref",
      cardinality: "single",
      valueKind: "ref",
      targetEntity: "person",
    },
    {
      name: "owner-name",
      binding: "owner",
      entity: "person",
      field: "name",
      type: "String",
      cardinality: "single",
      valueKind: "literal",
    },
  ],
  resultProviders: [],
  result: { kind: "one" },
  dependencies: [
    { entity: "release", field: "id" },
    { entity: "release", field: "title" },
    { entity: "release", field: "tags" },
    { entity: "release", field: "owner" },
    { entity: "person", field: "id" },
    { entity: "person", field: "name" },
  ],
};

const digestQuery = {
  name: "release-by-digest",
  capabilities: ["release:read"],
  parameters: [{ name: "digest", type: "Digest" }],
  bindings: [{ name: "release", entity: "release" }],
  where: [{
    op: "eq",
    left: {
      kind: "field",
      binding: "release",
      entity: "release",
      field: "digest",
      type: "Digest",
    },
    right: { kind: "parameter", name: "digest", type: "Digest" },
  }],
  select: [{
    name: "digest",
    binding: "release",
    entity: "release",
    field: "digest",
    type: "Digest",
    cardinality: "single",
    valueKind: "literal",
  }],
  resultProviders: [],
  result: { kind: "one" },
  dependencies: [
    { entity: "release", field: "id" },
    { entity: "release", field: "digest" },
  ],
};

const reader = Object.freeze({
  id: "actor-1",
  capabilities: Object.freeze(["release:read"]),
});
const reviewer = Object.freeze({
  id: "actor-2",
  capabilities: Object.freeze(["release:review"]),
});

const safeDocumentType = {
  kind: "bounded",
  maxBytes: 4096,
  maxDepth: 8,
  maxNodes: 64,
  definitions: [{
    name: "Document",
    value: {
      kind: "record",
      fields: [
        { name: "tag", required: true, value: { kind: "literal", value: "document" } },
        {
          name: "blocks",
          required: true,
          value: {
            kind: "list",
            maxItems: 8,
            items: { kind: "string", maxBytes: 1024 },
          },
        },
      ],
    },
  }],
  value: { kind: "ref", name: "Document" },
};

const providedQuery = {
  ...pageQuery,
  name: "rendered-releases",
  select: [
    pageQuery.select[0],
    { ...pageQuery.select[1], internal: true, name: "wake$provided$0$0" },
  ],
  resultProviders: [{
    name: "document",
    provider: "render-content",
    input: {
      kind: "record",
      fields: [
        {
          name: "contentSource",
          value: { kind: "column", name: "wake$provided$0$0" },
        },
        {
          name: "limits",
          value: {
            kind: "record",
            fields: [{ name: "maxNodes", value: { kind: "literal", value: 64 } }],
          },
        },
      ],
    },
    inputType: {
      kind: "record",
      fields: [
        { name: "contentSource", required: true, value: { kind: "string" } },
        {
          name: "limits",
          required: true,
          value: {
            kind: "record",
            fields: [{
              name: "maxNodes",
              required: true,
              value: { kind: "integer", minimum: 1, maximum: 64 },
            }],
          },
        },
      ],
    },
    outputType: safeDocumentType,
  }],
  result: { kind: "optional" },
};

function mockStore(responses) {
  const queue = [...responses];
  const calls = [];
  return {
    calls,
    store: {
      async query(query, options) {
        calls.push({ query, options });
        if (queue.length === 0) throw new Error("unexpected Store query");
        return queue.shift();
      },
    },
  };
}

function response(result, servedVersion, page = null) {
  return { result, servedVersion, page };
}

function errorCode(code) {
  return error => error instanceof NamedQueryError && error.code === code;
}

function expectThrowsCode(fn, code) {
  try {
    fn();
  } catch (error) {
    expect(errorCode(code)(error)).toBe(true);
    return;
  }
  throw new Error(`expected ${code}`);
}

async function expectRejectsCode(promise, code) {
  try {
    await promise;
  } catch (error) {
    expect(errorCode(code)(error)).toBe(true);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("named query plan lowering", () => {
  test("lowers checked fields and exact typed parameters to one structured Store query", async () => {
    const cursor = triple(keyword("cursor"), string("release"), ["integer", "1"]);
    const mock = mockStore([
      response(
        [[subject("release", "r-1"), string("r-1"), string("First")]],
        7n,
        { ordinal: 0, done: false, nextCursor: cursor },
      ),
    ]);
    const runtime = createNamedQueryRuntime([pageQuery], { store: mock.store, entities });

    await expect(runtime.execute(
      "releases-by-channel",
      { channel: "stable" },
      { limit: 1, asOf: "7" },
      reviewer,
    )).resolves.toEqual({
      rows: [{ id: "r-1", title: "First" }],
      page: { done: false, nextCursor: cursor },
      servedVersion: 7n,
    });

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].options).toEqual({
      timeoutMs: 5_000,
      asOf: 7n,
      page: { limit: 1 },
    });
    expect(mock.calls[0].query).toEqual({
      find: "wake/named/releases-by-channel",
      rules: [{
        head: {
          rel: "wake/named/releases-by-channel",
          args: [
            { var: "wake:q:b:0:subject" },
            { var: "wake:q:b:0:identity" },
            { var: "wake:q:f:1" },
          ],
        },
        body: [
          {
            rel: "triple",
            args: [
              { var: "wake:q:b:0:subject" },
              predicate("release", "id"),
              { var: "wake:q:b:0:identity" },
            ],
          },
          {
            rel: "triple",
            args: [
              { var: "wake:q:b:0:subject" },
              predicate("release", "channel"),
              { var: "wake:q:f:0" },
            ],
          },
          {
            rel: "triple",
            args: [
              { var: "wake:q:b:0:subject" },
              predicate("release", "title"),
              { var: "wake:q:f:1" },
            ],
          },
          {
            pred: "eq",
            args: [{ var: "wake:q:f:0" }, keyword("stable")],
          },
        ],
      }],
    });
  });

  test("passes the raw internal cursor unchanged on a pinned page continuation", async () => {
    const cursor = triple(keyword("cursor"), string("release"), ["integer", "1"]);
    const mock = mockStore([response([], 8n, { ordinal: 1, done: true, nextCursor: null })]);
    const runtime = createNamedQueryRuntime([pageQuery], { store: mock.store, entities });

    await runtime.execute(
      "releases-by-channel",
      { channel: "stable" },
      { cursor, asOf: 8n },
      reader,
    );

    expect(mock.calls[0].options).toEqual({
      timeoutMs: 5_000,
      asOf: 8n,
      page: { limit: 2, cursor },
    });
  });

  test("rejects stale field metadata and multi-cardinality page projections at startup", () => {
    expectThrowsCode(() => compileNamedQueries([{ ...pageQuery, select: [
      { ...pageQuery.select[0], type: "Integer" },
    ] }], entities), "gateway/invalid-plan");

    expectThrowsCode(() => compileNamedQueries([{ ...pageQuery, select: [{
      name: "tags",
      binding: "release",
      entity: "release",
      field: "tags",
      type: "String",
      cardinality: "multi",
      valueKind: "literal",
    }] }], entities), "gateway/invalid-plan");
  });

  test("requires a frozen bounded set of unique capability names", () => {
    const { capabilities: _capabilities, ...missing } = pageQuery;
    const invalid = [
      missing,
      { ...pageQuery, capabilities: [] },
      { ...pageQuery, capabilities: ["release:read", "release:read"] },
      { ...pageQuery, capabilities: [""] },
      { ...pageQuery, capabilities: [23] },
      {
        ...pageQuery,
        capabilities: Array.from({ length: 17 }, (_, index) => `release:read:${index}`),
      },
    ];
    for (const entry of invalid) {
      expectThrowsCode(() => compileNamedQueries([entry], entities), "gateway/invalid-plan");
    }

    const capabilities = compileNamedQueries([pageQuery], entities)
      .get("releases-by-channel").capabilities;
    expect(capabilities).toEqual(["release:read", "release:review"]);
    expect(Object.isFrozen(capabilities)).toBe(true);
  });

  test("rejects open records and forged operand metadata before Store is reachable", () => {
    const adversarial = [
      { ...pageQuery, extension: true },
      { ...pageQuery, parameters: [{ ...pageQuery.parameters[0], extension: true }] },
      { ...pageQuery, bindings: [{ ...pageQuery.bindings[0], extension: true }] },
      { ...pageQuery, where: [{ ...pageQuery.where[0], extension: true }] },
      {
        ...pageQuery,
        where: [{
          ...pageQuery.where[0],
          left: { ...pageQuery.where[0].left, entity: "person" },
        }],
      },
      {
        ...pageQuery,
        where: [{
          ...pageQuery.where[0],
          right: { ...pageQuery.where[0].right, type: "String" },
        }],
      },
      { ...pageQuery, select: [{ ...pageQuery.select[0], extension: true }] },
      { ...pageQuery, result: { ...pageQuery.result, extension: true } },
      {
        ...pageQuery,
        dependencies: [{ ...pageQuery.dependencies[0], extension: true }],
      },
    ];

    for (const entry of adversarial) {
      expectThrowsCode(() => compileNamedQueries([entry], entities), "gateway/invalid-plan");
    }
  });
});

describe("named query execution", () => {
  test("roundtrips canonical Digest values as string Terms without Keyword fallback", async () => {
    const mock = mockStore([
      response([[subject("release", "r-1"), string(canonicalDigest)]], 19n),
    ]);
    const runtime = createNamedQueryRuntime([digestQuery], { store: mock.store, entities });

    await expect(runtime.execute(
      "release-by-digest",
      { digest: canonicalDigest },
      {},
      reader,
    )).resolves.toEqual({
      row: { digest: canonicalDigest },
      servedVersion: 19n,
    });

    const predicateClause = mock.calls[0].query.rules[0].body.at(-1);
    expect(predicateClause.args[1]).toEqual(string(canonicalDigest));
    expect(predicateClause.args[1]).not.toEqual(keyword(canonicalDigest));
  });

  test("rejects malformed Digest input before Store dispatch", async () => {
    const mock = mockStore([]);
    const runtime = createNamedQueryRuntime([digestQuery], { store: mock.store, entities });
    const malformed = [
      `sha256:${"A".repeat(64)}`,
      "sha256:not-a-digest",
      keyword(canonicalDigest),
    ];

    for (const digest of malformed) {
      await expectRejectsCode(
        runtime.execute("release-by-digest", { digest }, {}, reader),
        "gateway/type-mismatch",
      );
    }
    expect(mock.calls).toHaveLength(0);
  });

  test("rejects malformed or Keyword-backed stored Digest output as data corruption", async () => {
    for (const stored of [
      string(`sha256:${"A".repeat(64)}`),
      string("sha256:not-a-digest"),
      keyword(canonicalDigest),
    ]) {
      const runtime = createNamedQueryRuntime([digestQuery], {
        entities,
        store: mockStore([
          response([[subject("release", "r-1"), stored]], 19n),
        ]).store,
      });

      await expectRejectsCode(
        runtime.execute("release-by-digest", { digest: canonicalDigest }, {}, reader),
        "gateway/data-integrity",
      );
    }
  });

  test("replaces internal hydrated fields with revalidated provider results", async () => {
    const calls = [];
    const mock = mockStore([response(
      [[subject("release", "r-1"), string("r-1"), string("# Safe")]],
      21n,
      { ordinal: 0, done: true, nextCursor: null },
    )]);
    const runtime = createNamedQueryRuntime([providedQuery], {
      entities,
      store: mock.store,
      providers: {
        "render-content": async (input, context) => {
          calls.push({ context, input });
          expect(Object.isFrozen(input)).toBe(true);
          expect(Object.isFrozen(input.limits)).toBe(true);
          return { tag: "document", blocks: [input.contentSource] };
        },
      },
    });

    await expect(runtime.execute(
      "rendered-releases",
      { channel: "stable" },
      {},
      reader,
    )).resolves.toEqual({
      row: {
        id: "r-1",
        document: { tag: "document", blocks: ["# Safe"] },
      },
      servedVersion: 21n,
    });
    expect(calls).toEqual([{
      input: { contentSource: "# Safe", limits: { maxNodes: 64 } },
      context: { query: "rendered-releases", servedVersion: "21" },
    }]);
    expect(calls[0].input).not.toHaveProperty("wake$provided$0$0");
  });

  test("fails closed on missing, failed, malformed, and forged result providers", async () => {
    expectThrowsCode(() => createNamedQueryRuntime([providedQuery], {
      entities,
      store: mockStore([]).store,
    }), "gateway/missing-provider");

    for (const [provider, code] of [
      [async () => { throw new Error("private parser detail"); }, "gateway/provider-failed"],
      [async () => ({ tag: "script", blocks: [] }), "gateway/provider-output"],
    ]) {
      const runtime = createNamedQueryRuntime([providedQuery], {
        entities,
        store: mockStore([response(
          [[subject("release", "r-1"), string("r-1"), string("source")]],
          22n,
          { ordinal: 0, done: true, nextCursor: null },
        )]).store,
        providers: { "render-content": provider },
      });
      await expectRejectsCode(runtime.execute(
        "rendered-releases",
        { channel: "stable" },
        {},
        reader,
      ), code);
    }

    expectThrowsCode(() => compileNamedQueries([{
      ...providedQuery,
      resultProviders: [{
        ...providedQuery.resultProviders[0],
        input: { kind: "column", name: "id" },
      }],
    }], entities), "gateway/invalid-plan");
    expectThrowsCode(() => compileNamedQueries([{
      ...providedQuery,
      resultProviders: [],
    }], entities), "gateway/invalid-plan");

    expectThrowsCode(() => compileNamedQueries([{
      ...providedQuery,
      result: { kind: "page", defaultLimit: 1, maxLimit: 1 },
    }], entities), "gateway/invalid-plan");
    expectThrowsCode(() => compileNamedQueries([{
      ...providedQuery,
      resultProviders: [{
        ...providedQuery.resultProviders[0],
        outputType: { kind: "record", fields: [] },
      }],
    }], entities), "gateway/invalid-plan");
    expectThrowsCode(() => compileNamedQueries([{
      ...providedQuery,
      resultProviders: [{
        ...providedQuery.resultProviders[0],
        outputType: {
          ...safeDocumentType,
          maxBytes: 1024 * 1024 + 1,
        },
      }],
    }], entities), "gateway/invalid-plan");
  });

  test("requires one exact checked capability and authorizes any declared choice", async () => {
    const allowed = mockStore([
      response([], 6n, { ordinal: 0, done: true, nextCursor: null }),
    ]);
    const runtime = createNamedQueryRuntime([pageQuery], { store: allowed.store, entities });

    await expect(runtime.execute(
      "releases-by-channel",
      { channel: "stable" },
      {},
      reviewer,
    )).resolves.toEqual({
      rows: [],
      page: { done: true, nextCursor: null },
      servedVersion: 6n,
    });
    expect(allowed.calls).toHaveLength(1);
  });

  test("rejects missing, empty, malformed, and denied authority before Store dispatch", async () => {
    const mock = mockStore([]);
    const runtime = createNamedQueryRuntime([pageQuery], { store: mock.store, entities });
    const denied = [
      undefined,
      null,
      {},
      { id: "", capabilities: ["release:read"] },
      { id: "actor-1", capabilities: [] },
      { id: "actor-1", capabilities: [""] },
      { id: "actor-1", capabilities: [17] },
      { id: "actor-1", capabilities: ["read"] },
      { id: "actor-1", capabilities: ["release:write"] },
    ];

    for (const authority of denied) {
      await expectRejectsCode(
        runtime.execute(
          "releases-by-channel",
          { channel: "stable" },
          {},
          authority,
        ),
        "gateway/forbidden",
      );
    }
    await expectRejectsCode(
      runtime.execute("releases-by-channel", {}, {}, { id: "actor-1", capabilities: [] }),
      "gateway/forbidden",
    );
    expect(mock.calls).toHaveLength(0);
  });

  test("hydrates unique multi values across cursor-pinned pages and decodes refs", async () => {
    const release = subject("release", "r-1");
    const owner = subject("person", "p-1");
    const cursor = triple(keyword("cursor"), string("release-by-id"), ["integer", "1"]);
    const rootRow = [
      release,
      owner,
      string("r-1"),
      string("First"),
      owner,
      string("Ada"),
    ];
    const mock = mockStore([
      response([rootRow], 11n, { ordinal: 0, done: true, nextCursor: null }),
      response([[string("runtime")]], 11n, { ordinal: 0, done: false, nextCursor: cursor }),
      response(
        [[string("compiler")], [string("runtime")]],
        11n,
        { ordinal: 1, done: true, nextCursor: null },
      ),
    ]);
    const runtime = createNamedQueryRuntime([oneQuery], { store: mock.store, entities });

    await expect(runtime.execute("release-by-id", { id: "r-1" }, { asOf: 11n }, reader)).resolves.toEqual({
      row: {
        id: "r-1",
        title: "First",
        tags: ["runtime", "compiler"],
        owner: "p-1",
        "owner-name": "Ada",
      },
      servedVersion: 11n,
    });

    expect(mock.calls).toHaveLength(3);
    expect(mock.calls[0].options).toEqual({
      timeoutMs: 5_000,
      asOf: 11n,
      page: { limit: 247 },
    });
    expect(mock.calls[1].options).toEqual({
      timeoutMs: 5_000,
      asOf: 11n,
      page: { limit: 247 },
    });
    expect(mock.calls[2].options).toEqual({
      timeoutMs: 5_000,
      asOf: 11n,
      page: { limit: 247, cursor },
    });
    const equality = mock.calls[0].query.rules[0].body.filter(clause => clause.pred === "eq");
    expect(equality).toEqual([
      { pred: "eq", args: [{ var: "wake:q:b:0:identity" }, string("r-1")] },
      { pred: "eq", args: [{ var: "wake:q:f:0" }, { var: "wake:q:b:1:subject" }] },
    ]);
  });

  test("hydrates an absent multi field as an empty array at the root snapshot", async () => {
    const release = subject("release", "r-1");
    const owner = subject("person", "p-1");
    const mock = mockStore([
      response([[
        release,
        owner,
        string("r-1"),
        string("First"),
        owner,
        string("Ada"),
      ]], 15n, { ordinal: 0, done: true, nextCursor: null }),
      response([], 15n, { ordinal: 0, done: true, nextCursor: null }),
    ]);
    const runtime = createNamedQueryRuntime([oneQuery], { store: mock.store, entities });

    await expect(runtime.execute("release-by-id", { id: "r-1" }, {}, reader)).resolves.toEqual({
      row: {
        id: "r-1",
        title: "First",
        tags: [],
        owner: "p-1",
        "owner-name": "Ada",
      },
      servedVersion: 15n,
    });
    expect(mock.calls[1].options.asOf).toBe(15n);
  });

  test("returns null for an empty optional result", async () => {
    const optional = { ...oneQuery, name: "maybe-release", result: { kind: "optional" } };
    const runtime = createNamedQueryRuntime([optional], {
      entities,
      store: mockStore([response([], 4n, { ordinal: 0, done: true, nextCursor: null })]).store,
    });

    await expect(runtime.execute("maybe-release", { id: "absent" }, {}, reader)).resolves.toEqual({
      row: null,
      servedVersion: 4n,
    });
  });

  test("rejects exact-input violations before sending a query", async () => {
    const mock = mockStore([]);
    const runtime = createNamedQueryRuntime([pageQuery], { store: mock.store, entities });

    await expectRejectsCode(
      runtime.execute("releases-by-channel", {}, {}, reader),
      "gateway/invalid-input",
    );
    await expectRejectsCode(
      runtime.execute("releases-by-channel", { channel: "stable", extra: true }, {}, reader),
      "gateway/invalid-input",
    );
    await expectRejectsCode(
      runtime.execute("releases-by-channel", { channel: 1 }, {}, reader),
      "gateway/type-mismatch",
    );
    await expectRejectsCode(
      runtime.execute("releases-by-channel", { channel: "stable" }, { limit: 6 }, reader),
      "gateway/invalid-input",
    );
    expect(mock.calls).toHaveLength(0);
  });

  test("treats unequal live values for a single field as typed corruption", async () => {
    const release = subject("release", "r-1");
    const owner = subject("person", "p-1");
    const row = title => [
      release,
      owner,
      string("r-1"),
      string(title),
      owner,
      string("Ada"),
    ];
    const runtime = createNamedQueryRuntime([oneQuery], {
      entities,
      store: mockStore([
        response([row("First"), row("Conflicting")], 12n, { ordinal: 0, done: true, nextCursor: null }),
      ]).store,
    });

    await expectRejectsCode(
      runtime.execute("release-by-id", { id: "r-1" }, {}, reader),
      "gateway/data-integrity",
    );
  });

  test("treats two logical subjects and mid-read snapshot skew as typed corruption", async () => {
    const owner = subject("person", "p-1");
    const row = id => [
      subject("release", id),
      owner,
      string(id),
      string("Title"),
      owner,
      string("Ada"),
    ];
    const multiple = createNamedQueryRuntime([oneQuery], {
      entities,
      store: mockStore([
        response([row("r-1"), row("r-2")], 13n, { ordinal: 0, done: true, nextCursor: null }),
      ]).store,
    });
    await expectRejectsCode(
      multiple.execute("release-by-id", { id: "r-1" }, {}, reader),
      "gateway/data-integrity",
    );

    const cursor = triple(keyword("cursor"), string("skew"), ["integer", "1"]);
    const skew = createNamedQueryRuntime([oneQuery], {
      entities,
      store: mockStore([
        response([row("r-1")], 13n, { ordinal: 0, done: false, nextCursor: cursor }),
        response([row("r-1")], 14n, { ordinal: 1, done: true, nextCursor: null }),
      ]).store,
    });
    await expectRejectsCode(
      skew.execute("release-by-id", { id: "r-1" }, {}, reader),
      "gateway/protocol",
    );
  });
});
