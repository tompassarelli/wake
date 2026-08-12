import { describe, expect, test } from "bun:test";
import {
  canonicalDocument,
  parseCanonicalDocument,
  sha256Digest,
} from "../../../compiler/canonical.mjs";
import {
  packPlugin,
  validatePluginManifest,
} from "../../../compiler/plugin-package.mjs";

const pluginRoot = `${import.meta.dir}/..`;
const webRoot = `${pluginRoot}/../..`;

async function jsonAt(path) {
  return JSON.parse(await Bun.file(`${pluginRoot}/${path}`).text());
}

function collectStrings(value, result = []) {
  if (typeof value === "string") result.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, result);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, result);
  }
  return result;
}

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
  const path = run([
    "mktemp",
    "-d",
    "/tmp/wake-wiki-contract.XXXXXX",
  ]).trim();
  if (!path.startsWith("/tmp/wake-wiki-contract.")) {
    throw new Error(`mktemp returned an unexpected path: ${path}`);
  }
  return path;
}

async function compileSubstratePlan() {
  const temporary = temporaryDirectory();
  try {
    const packed = await packPlugin(pluginRoot);
    const commit = run(["git", "rev-parse", "HEAD"]).trim();
    const source = await Bun.file(
      `${pluginRoot}/fixtures/substrate/substrate.wake`,
    ).text();
    await Bun.write(`${temporary}/substrate.wake`, source);
    await Bun.write(`${temporary}/wake-wiki.wakepkg.json`, packed.bytes);
    await Bun.write(`${temporary}/wake.lock`, canonicalDocument({
      pluginAbiVersion: 1,
      plugins: [{
        artifact: "wake-wiki.wakepkg.json",
        digest: packed.digest,
        packageId: "wake-wiki",
        source: { commit, kind: "git" },
        version: "0.1.0",
      }],
      schemaVersion: 1,
    }));
    return JSON.parse(run([
      `${webRoot}/bin/wake-compile`,
      "--fram",
      `${temporary}/substrate.wake`,
    ]));
  } finally {
    run(["rm", "-rf", "--", temporary]);
  }
}

describe("wake-wiki K0C data contract", () => {
  test("uses the frozen W0C manifest envelope", async () => {
    const manifestText = await Bun.file(`${pluginRoot}/wake-plugin.json`).text();
    const manifest = parseCanonicalDocument(manifestText, "wake-plugin.json");
    expect(validatePluginManifest(manifest)).toBe(manifest);
    expect(Object.keys(manifest)).toEqual([
      "compatibleWake",
      "configuration",
      "contributions",
      "dependencies",
      "durableSchemaVersion",
      "entry",
      "exports",
      "extensionPorts",
      "migrations",
      "packageId",
      "pluginAbiVersion",
      "requiredHostCapabilities",
      "schemaVersion",
      "sources",
      "storageIds",
      "version",
    ]);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      packageId: "wake-wiki",
      version: "0.1.0",
      pluginAbiVersion: 1,
      entry: "plugin.wake",
      sources: ["plugin.wake"],
      dependencies: [],
      durableSchemaVersion: 1,
      migrations: [],
    });
    expect(manifest.contributions).toEqual([
      "schema",
      "query",
      "command",
      "capability",
      "ui",
      "route",
    ]);

    const packageMetadata = await jsonAt("package.json");
    expect(packageMetadata.name).toBe(manifest.packageId);
    expect(packageMetadata.version).toBe(manifest.version);
  });

  test("freezes every plugin-owned storage identity", async () => {
    const manifest = await jsonAt("wake-plugin.json");
    const storageIds = [
      ...Object.values(manifest.storageIds.entities),
      ...Object.values(manifest.storageIds.fields),
    ];
    expect(manifest.storageIds).toEqual({
      entities: {
        resource: "wake-wiki/entity/resource",
        revision: "wake-wiki/entity/revision",
      },
      fields: {
        "resource/id": "wake-wiki/field/resource/id",
        "resource/published-revision": "wake-wiki/field/resource/published-revision",
        "resource/draft-revision": "wake-wiki/field/resource/draft-revision",
        "revision/id": "wake-wiki/field/revision/id",
        "revision/resource": "wake-wiki/field/revision/resource",
        "revision/based-on": "wake-wiki/field/revision/based-on",
        "revision/replaces-draft": "wake-wiki/field/revision/replaces-draft",
        "revision/state": "wake-wiki/field/revision/state",
        "revision/author": "wake-wiki/field/revision/author",
        "revision/created-at": "wake-wiki/field/revision/created-at",
        "revision/digest": "wake-wiki/field/revision/digest",
        "revision/links-to": "wake-wiki/field/revision/links-to",
        "revision/title": "wake-wiki/field/revision/title",
        "revision/summary": "wake-wiki/field/revision/summary",
        "revision/content-source": "wake-wiki/field/revision/content-source",
        "receipt-result-resource-field": "wake-wiki/field/receipt/result-resource",
        "receipt-result-revision-field": "wake-wiki/field/receipt/result-revision",
      },
    });
    expect(new Set(storageIds).size).toBe(storageIds.length);
    expect(storageIds.every((storageId) =>
      typeof storageId === "string" && storageId.length > 0
    )).toBe(true);
    expect(manifest.exports.entities).toEqual(["resource", "revision"]);
  });

  test("exports only the first vertical slice", async () => {
    const manifest = await jsonAt("wake-plugin.json");
    expect(manifest.exports.commands).toEqual([
      "create-resource-draft",
      "start-revision-draft",
      "replace-draft",
      "abandon-draft",
      "publish",
    ]);
    expect(manifest.exports.queries).toEqual([
      "browse-published",
      "read-published",
      "read-draft",
      "review",
      "history",
      "backlinks",
    ]);
    expect(manifest.exports.capabilities).toEqual([
      "browse-published",
      "read-published",
      "read-draft",
      "review-draft",
      "read-history",
      "read-backlinks",
      "create-draft",
      "start-draft",
      "replace-own-draft",
      "abandon-own-draft",
      "abandon-any-draft",
      "publish-draft",
    ]);
    expect(manifest.exports.routes).toEqual([
      "browse",
      "new",
      "read",
      "edit",
      "review",
      "history",
    ]);
    expect(manifest.exports.providerPorts).toEqual([
      "content-parser",
    ]);
    expect(manifest.requiredHostCapabilities).toEqual(["content-parser"]);
    expect(manifest.extensionPorts.map((port) => port.name)).toEqual([
      "revision-fields",
      "receipt-fields",
      "browse",
      "new",
      "read",
      "edit",
      "review",
      "history",
    ]);
  });

  test("requires a closed and complete application binding", async () => {
    const manifest = await jsonAt("wake-plugin.json");
    const names = Object.keys(manifest.configuration);
    expect(names).toEqual([
      "actor-entity",
      "author-field",
      "base-field",
      "content-limits",
      "content-provider",
      "content-source-field",
      "created-at-field",
      "digest-field",
      "draft-pointer",
      "draft-state",
      "lifecycle-type",
      "links-field",
      "owner-field",
      "published-pointer",
      "published-state",
      "query-limits",
      "receipt-result-resource-field",
      "receipt-result-revision-field",
      "replaces-field",
      "resource",
      "resource-id",
      "revision",
      "revision-id",
      "safe-document-limits",
      "state-field",
      "summary-field",
      "superseded-state",
      "title-field",
    ]);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.values(manifest.configuration).every((entry) =>
      entry.required === true
    )).toBe(true);
  });

  test("keeps product semantics out of the reusable package", async () => {
    const manifest = await jsonAt("wake-plugin.json");
    const entry = await Bun.file(`${pluginRoot}/plugin.wake`).text();
    const semanticText = [...collectStrings(manifest), entry].join("\n");
    for (const forbidden of [
      /greywrought/iu,
      /\barticle\b/iu,
      /\bcanonical\b/iu,
      /\bobsolete\b/iu,
      /\bprincipal\b/iu,
      /\blore\b/iu,
    ]) {
      expect(semanticText).not.toMatch(forbidden);
    }
    expect(entry.trimStart()).toStartWith("(ns wake.plugins.wiki)");
    expect(entry).not.toMatch(/(?:callback|eval|Function|javascript:)/u);
  });

  test("materializes the schema, lifecycle, and every exported component", async () => {
    const manifest = await jsonAt("wake-plugin.json");
    const entry = await Bun.file(`${pluginRoot}/plugin.wake`).text();
    for (const entity of manifest.exports.entities) {
      expect(entry).toContain(`(entity ${entity}\n`);
    }
    for (const component of manifest.exports.components) {
      expect(entry).toContain(`(component ${component}\n`);
    }
    expect(entry).toContain("(defstate RevisionLifecycle\n");
    expect(entry).toContain("[:draft -> :published :superseded]");
    expect(entry).toContain("[:published -> :superseded]");
    expect(entry).toContain("[:superseded ->]");
  });

  test("packs deterministically from the real declaration source", async () => {
    const first = await packPlugin(pluginRoot);
    const second = await packPlugin(pluginRoot);
    expect(first.bytes).toBe(second.bytes);
    expect(first.digest).toBe(second.digest);
    expect(first.digest).toBe(sha256Digest(first.bytes));
    expect(first.artifact.files).toHaveLength(1);
    expect(first.artifact.files[0].path).toBe("plugin.wake");
    expect(first.artifact.files[0].content).toContain("(entity resource\n");
    expect(first.artifact.files[0].content).toContain("(entity revision\n");
  });

  test("links the delivered substrate into one checked FRAM graph", async () => {
    const plan = await compileSubstratePlan();
    expect(plan.applicationId).toBe("wake-wiki-substrate-fixture");
    expect(plan.pluginClosure).toHaveLength(1);
    expect(plan.pluginClosure[0]).toMatchObject({
      alias: "wiki",
      allowedContributions: ["schema", "ui"],
      packageId: "wake-wiki",
      version: "0.1.0",
    });
    expect(plan.entities.map((entity) => entity.name)).toEqual([
      "wiki.resource",
      "wiki.revision",
    ]);
    expect(plan.entities.map((entity) => entity.storageId)).toEqual([
      "wake-wiki/entity/resource",
      "wake-wiki/entity/revision",
    ]);
    const resource = plan.entities[0];
    const revision = plan.entities[1];
    expect(resource.identity).toMatchObject({
      field: "id",
      storageId: "wake-wiki/field/resource/id",
    });
    expect(resource.fields.filter((field) => field.name !== "id")
      .every((field) => field.write === "command")).toBe(true);
    expect(revision.identity).toMatchObject({
      field: "id",
      storageId: "wake-wiki/field/revision/id",
    });
    expect(revision.fields.filter((field) =>
      field.name !== "id" && field.name !== "state"
    ).every((field) => field.write === "create")).toBe(true);
    expect(revision.fields.find((field) => field.name === "state").write)
      .toBe("command");
    expect(plan.stateMachines).toEqual([{
      entity: "wiki.revision",
      field: "state",
      initial: "draft",
      stateType: "wiki.RevisionLifecycle",
      transitions: {
        draft: ["published", "superseded"],
        published: ["superseded"],
        superseded: [],
      },
    }]);
  }, 30_000);
});

describe("neutral handbook binding", () => {
  test("binds every required role and mounts every route explicitly", async () => {
    const manifest = await jsonAt("wake-plugin.json");
    const source = await Bun.file(
      `${pluginRoot}/fixtures/handbook/handbook.wake`,
    ).text();
    expect(source).toContain('(application :id "wake-wiki-handbook-fixture")');
    expect(source).toContain('(use "wake-wiki"');
    expect(source).toContain(':version "0.1.0"');
    for (const config of Object.keys(manifest.configuration)) {
      expect(source).toContain(config);
    }
    for (const route of manifest.exports.routes) {
      expect(source).toContain(`(mount wiki.${route} `);
    }
    expect(source).toContain(
      '"handbook-fixture/field/edition/audience"',
    );
    expect(source).toContain(
      '"handbook-fixture/field/receipt/release-rule-digest"',
    );
    expect(source).not.toMatch(
      /greywrought|\barticle\b|\bcanonical\b|\bobsolete\b|\bprincipal\b|\blore\b/iu,
    );
  });
});
