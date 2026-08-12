import { describe, expect, test } from "bun:test";

const webRoot = `${import.meta.dir}/..`;
const fixture = `${webRoot}/tests/fixtures/named-query.wake`;

function compileFram(source = fixture) {
  const result = Bun.spawnSync([
    `${webRoot}/bin/wake-compile`,
    "--fram",
    source,
    "-",
  ], {
    cwd: webRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("W1 checked named query compiler", () => {
  test("emits deterministic typed joins, projections, bounds, and dependencies", () => {
    const first = compileFram();
    const second = compileFram();
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.stdout).toBe(second.stdout);

    const plan = JSON.parse(first.stdout);
    expect(plan.schemaVersion).toBe(2);
    expect(plan.queries.map((query) => query.name)).toEqual([
      "browse-releases",
      "release-by-id",
      "approvals-for-release",
    ]);

    expect(plan.queries[0]).toMatchObject({
      parameters: [],
      bindings: [{ name: "release", entity: "release" }],
      where: [{
        op: "eq",
        left: {
          kind: "field",
          binding: "release",
          entity: "release",
          field: "state",
          type: "ReleaseState",
        },
        right: {
          kind: "literal",
          type: "ReleaseState",
          value: "published",
        },
      }],
      result: { kind: "page", defaultLimit: 20, maxLimit: 64 },
    });
    expect(plan.queries[0].select[0]).toEqual({
      name: "id",
      binding: "release",
      entity: "release",
      field: "id",
      type: "String",
      cardinality: "single",
      valueKind: "literal",
    });

    const lookup = plan.queries[1];
    expect(lookup.parameters).toEqual([{ name: "release-id", type: "String" }]);
    expect(lookup.result).toEqual({ kind: "optional" });
    expect(lookup.select[2]).toMatchObject({
      name: "tags",
      cardinality: "multi",
      type: "String",
      valueKind: "literal",
    });

    const join = plan.queries[2];
    expect(join.where[1]).toEqual({
      op: "eq",
      left: {
        kind: "field",
        binding: "approval",
        entity: "approval",
        field: "release",
        type: "Ref",
      },
      right: {
        kind: "binding",
        binding: "release",
        entity: "release",
      },
    });
    expect(join.dependencies).toEqual([
      { entity: "release", field: "id" },
      { entity: "approval", field: "id" },
      { entity: "approval", field: "release" },
      { entity: "approval", field: "state" },
    ]);
  }, 30_000);
});
