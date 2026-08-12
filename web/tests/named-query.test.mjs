import { describe, expect, test } from "bun:test";
import { canonicalDocument } from "../compiler/canonical.mjs";
import { packPlugin } from "../compiler/plugin-package.mjs";

const webRoot = `${import.meta.dir}/..`;
const fixture = `${webRoot}/tests/fixtures/named-query.wake`;
const invalidRefFixture = `${webRoot}/tests/fixtures/named-query-invalid-ref.wake`;
const derivedFixture = `${webRoot}/tests/fixtures/named-query-derived.wake`;
const refParamFixture = `${webRoot}/tests/fixtures/named-query-ref-param.wake`;
const unknownParamFixture = `${webRoot}/tests/fixtures/named-query-unknown-param.wake`;
const pluginStateFixture = `${webRoot}/tests/fixtures/plugin-state-query`;

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

function temporaryDirectory() {
  const result = Bun.spawnSync([
    "mktemp",
    "-d",
    "/tmp/wake-plugin-state-query.XXXXXX",
  ], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  const path = result.stdout.toString().trim();
  if (!path.startsWith("/tmp/wake-plugin-state-query.")) {
    throw new Error(`mktemp returned an unexpected path: ${path}`);
  }
  return path;
}

async function compilePluginStateQuery() {
  const temporary = temporaryDirectory();
  try {
    const packed = await packPlugin(pluginStateFixture);
    await Bun.write(
      `${temporary}/app.wake`,
      await Bun.file(`${pluginStateFixture}/app.wake`).text(),
    );
    await Bun.write(`${temporary}/plugin.wakepkg.json`, packed.bytes);
    await Bun.write(`${temporary}/wake.lock`, canonicalDocument({
      pluginAbiVersion: 1,
      plugins: [{
        artifact: "plugin.wakepkg.json",
        digest: packed.digest,
        packageId: "wake-state-query-fixture",
        source: { commit: "0000000000000000000000000000000000000000", kind: "git" },
        version: "0.1.0",
      }],
      schemaVersion: 1,
    }));
    return compileFram(`${temporary}/app.wake`);
  } finally {
    Bun.spawnSync(["rm", "-rf", "--", temporary]);
  }
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
      capabilities: ["wake-tests/cap/browse-releases"],
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
      resultProviders: [],
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
    expect(join.capabilities).toEqual([
      "wake-tests/cap/read-approvals",
      "wake-tests/cap/admin",
    ]);
    expect(join.where[1]).toEqual({
      op: "eq",
      left: {
        kind: "field",
        binding: "approval",
        entity: "approval",
        field: "release",
        type: "Ref",
        targetEntity: "release",
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

  test("rejects equality between references with different entity targets", () => {
    const compiled = compileFram(invalidRefFixture);
    expect(compiled.status).not.toBe(0);
    expect(compiled.stderr).toContain(
      "compares references to different entity targets 'release' and 'actor'",
    );
  }, 30_000);

  test("rejects derived fields because FRAM cannot serve them", () => {
    const compiled = compileFram(derivedFixture);
    expect(compiled.status).not.toBe(0);
    expect(compiled.stderr).toContain(
      "cannot read derived field 'release.label' from FRAM",
    );
  }, 30_000);

  test("closes query parameters over typed FRAM values", () => {
    const ref = compileFram(refParamFixture);
    expect(ref.status).not.toBe(0);
    expect(ref.stderr).toContain(
      "parameter 'owner' cannot use Ref without a target entity",
    );

    const unknown = compileFram(unknownParamFixture);
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain(
      "parameter 'opaque' has unsupported type 'Opaque'",
    );
  }, 30_000);

  test("qualifies plugin-local state parameter types", async () => {
    const compiled = await compilePluginStateQuery();
    expect(compiled.status, compiled.stderr).toBe(0);
    const plan = JSON.parse(compiled.stdout);
    expect(plan.queries).toHaveLength(1);
    expect(plan.queries[0].parameters).toEqual([
      { name: "phase", type: "fixture.Phase" },
    ]);
    expect(plan.queries[0].capabilities).toEqual([
      "wake-state-query-fixture/cap/read-releases",
    ]);
    expect(plan.queries[0].where[0]).toMatchObject({
      left: { type: "fixture.Phase" },
      right: { type: "fixture.Phase" },
    });
  }, 30_000);
});
