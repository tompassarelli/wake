import { describe, expect, test } from "bun:test";
import {
  canonicalDocument,
} from "../compiler/canonical.mjs";
import { packPlugin } from "../compiler/plugin-package.mjs";

const webRoot = `${import.meta.dir}/..`;
const fixtureRoot = `${import.meta.dir}/fixtures/configured-plugin`;

function run(command, cwd = webRoot) {
  const result = Bun.spawnSync(command, {
    cwd,
    env: process.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error([
      `command failed (${result.exitCode}): ${command.join(" ")}`,
      result.stdout.toString(),
      result.stderr.toString(),
    ].join("\n"));
  }
  return result.stdout.toString();
}

function temporaryDirectory() {
  const path = run(["mktemp", "-d", "/tmp/wake-config-link.XXXXXX"]).trim();
  if (!path.startsWith("/tmp/wake-config-link.")) {
    throw new Error(`mktemp returned an unexpected path: ${path}`);
  }
  return path;
}

async function compileFixture() {
  const temporary = temporaryDirectory();
  try {
    const packed = await packPlugin(fixtureRoot);
    const commit = run(["git", "rev-parse", "HEAD"]).trim();
    const application = await Bun.file(`${fixtureRoot}/application.bjs`).text();
    await Bun.write(`${temporary}/application.bjs`, application);
    await Bun.write(`${temporary}/plugin.wakepkg.json`, packed.bytes);
    await Bun.write(`${temporary}/wake.lock`, canonicalDocument({
      pluginAbiVersion: 1,
      plugins: [{
        artifact: "plugin.wakepkg.json",
        digest: packed.digest,
        packageId: "wake-configured-plugin",
        source: { commit, kind: "git" },
        version: "0.1.0",
      }],
      schemaVersion: 1,
    }));
    const planPath = `${temporary}/app.fram.json`;
    run([
      `${webRoot}/bin/wake-compile`,
      "--fram",
      `${temporary}/application.bjs`,
      planPath,
    ]);
    return Bun.file(planPath).json();
  } finally {
    run(["rm", "-rf", "--", temporary]);
  }
}

describe("configured plugin declarations", () => {
  test("substitutes roles before schema, storage, query, and extension checking", async () => {
    const plan = await compileFixture();
    const entity = plan.entities.find(candidate => candidate.name === "configured.entry");
    expect(entity).toMatchObject({
      storageId: "wake-configured-plugin/entity/document",
    });
    expect(entity.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "entry-id",
        storageId: "wake-configured-plugin/field/document/id",
      }),
      expect.objectContaining({
        name: "status",
        storageId: "wake-configured-plugin/field/document/state",
      }),
      expect.objectContaining({
        name: "audience",
        storageId: "wake-configured-application/field/entry/audience",
      }),
    ]));

    const query = plan.queries.find(candidate => candidate.name === "configured.browse");
    expect(query.result).toEqual({ defaultLimit: 5, kind: "page", maxLimit: 12 });
    expect(query.bindings).toEqual([
      expect.objectContaining({ entity: "configured.entry", name: "item" }),
    ]);
    expect(query.where).toEqual([
      expect.objectContaining({
        left: expect.objectContaining({ field: "status" }),
        right: expect.objectContaining({ kind: "literal", value: "released" }),
      }),
    ]);
    expect(query.select).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "entry-id", name: "id" }),
      expect.objectContaining({ field: "status", name: "state" }),
    ]));
  }, 30_000);
});
