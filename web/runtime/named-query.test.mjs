import { describe, expect, test } from "bun:test";

import {
  NamedQueryError,
  compileNamedQueries,
  createNamedQueryRuntime,
} from "./named-query.mjs";

const keyword = value => ["keyword", value];
const string = value => ["string", value];
const triple = (t1, t2, t3) => ["triple", t1, t2, t3];
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
  result: { kind: "page", defaultLimit: 2, maxLimit: 5 },
  dependencies: [
    { entity: "release", field: "id" },
    { entity: "release", field: "channel" },
    { entity: "release", field: "title" },
  ],
};

const oneQuery = {
  name: "release-by-id",
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

function mockFram(responses) {
  const queue = [...responses];
  const calls = [];
  return {
    calls,
    fram: {
      async query(query, options) {
        calls.push({ query, options });
        if (queue.length === 0) throw new Error("unexpected FRAM query");
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
  test("lowers checked fields and exact typed parameters to one structured FRAM query", async () => {
    const cursor = triple(keyword("cursor"), string("release"), ["integer", "1"]);
    const mock = mockFram([
      response(
        [[subject("release", "r-1"), string("r-1"), string("First")]],
        7n,
        { ordinal: 0, done: false, nextCursor: cursor },
      ),
    ]);
    const runtime = createNamedQueryRuntime([pageQuery], { fram: mock.fram, entities });

    await expect(runtime.execute(
      "releases-by-channel",
      { channel: "stable" },
      { limit: 1, asOf: "7" },
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
    const mock = mockFram([response([], 8n, { ordinal: 1, done: true, nextCursor: null })]);
    const runtime = createNamedQueryRuntime([pageQuery], { fram: mock.fram, entities });

    await runtime.execute(
      "releases-by-channel",
      { channel: "stable" },
      { cursor, asOf: 8n },
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

  test("rejects open records and forged operand metadata before FRAM is reachable", () => {
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
    const mock = mockFram([
      response([rootRow], 11n, { ordinal: 0, done: true, nextCursor: null }),
      response([[string("runtime")]], 11n, { ordinal: 0, done: false, nextCursor: cursor }),
      response(
        [[string("compiler")], [string("runtime")]],
        11n,
        { ordinal: 1, done: true, nextCursor: null },
      ),
    ]);
    const runtime = createNamedQueryRuntime([oneQuery], { fram: mock.fram, entities });

    await expect(runtime.execute("release-by-id", { id: "r-1" }, { asOf: 11n })).resolves.toEqual({
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
    const mock = mockFram([
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
    const runtime = createNamedQueryRuntime([oneQuery], { fram: mock.fram, entities });

    await expect(runtime.execute("release-by-id", { id: "r-1" })).resolves.toEqual({
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
      fram: mockFram([response([], 4n, { ordinal: 0, done: true, nextCursor: null })]).fram,
    });

    await expect(runtime.execute("maybe-release", { id: "absent" })).resolves.toEqual({
      row: null,
      servedVersion: 4n,
    });
  });

  test("rejects exact-input violations before sending a query", async () => {
    const mock = mockFram([]);
    const runtime = createNamedQueryRuntime([pageQuery], { fram: mock.fram, entities });

    await expectRejectsCode(
      runtime.execute("releases-by-channel", {}),
      "gateway/invalid-input",
    );
    await expectRejectsCode(
      runtime.execute("releases-by-channel", { channel: "stable", extra: true }),
      "gateway/invalid-input",
    );
    await expectRejectsCode(
      runtime.execute("releases-by-channel", { channel: 1 }),
      "gateway/type-mismatch",
    );
    await expectRejectsCode(
      runtime.execute("releases-by-channel", { channel: "stable" }, { limit: 6 }),
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
      fram: mockFram([
        response([row("First"), row("Conflicting")], 12n, { ordinal: 0, done: true, nextCursor: null }),
      ]).fram,
    });

    await expectRejectsCode(
      runtime.execute("release-by-id", { id: "r-1" }),
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
      fram: mockFram([
        response([row("r-1"), row("r-2")], 13n, { ordinal: 0, done: true, nextCursor: null }),
      ]).fram,
    });
    await expectRejectsCode(
      multiple.execute("release-by-id", { id: "r-1" }),
      "gateway/data-integrity",
    );

    const cursor = triple(keyword("cursor"), string("skew"), ["integer", "1"]);
    const skew = createNamedQueryRuntime([oneQuery], {
      entities,
      fram: mockFram([
        response([row("r-1")], 13n, { ordinal: 0, done: false, nextCursor: cursor }),
        response([row("r-1")], 14n, { ordinal: 1, done: true, nextCursor: null }),
      ]).fram,
    });
    await expectRejectsCode(
      skew.execute("release-by-id", { id: "r-1" }),
      "gateway/protocol",
    );
  });
});
