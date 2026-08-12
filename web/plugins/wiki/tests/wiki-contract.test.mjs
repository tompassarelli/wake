import { describe, expect, test } from "bun:test";

const pluginRoot = `${import.meta.dir}/..`;

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

describe("wake-wiki K0C data contract", () => {
  test("uses the frozen W0C manifest envelope", async () => {
    const manifest = await jsonAt("wake-plugin.json");
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
        "resource-id": "wake-wiki/field/resource/id",
        "published-pointer": "wake-wiki/field/resource/published-revision",
        "draft-pointer": "wake-wiki/field/resource/draft-revision",
        "revision-id": "wake-wiki/field/revision/id",
        "owner-field": "wake-wiki/field/revision/resource",
        "base-field": "wake-wiki/field/revision/based-on",
        "replaces-field": "wake-wiki/field/revision/replaces-draft",
        "state-field": "wake-wiki/field/revision/state",
        "author-field": "wake-wiki/field/revision/author",
        "created-at-field": "wake-wiki/field/revision/created-at",
        "digest-field": "wake-wiki/field/revision/digest",
        "links-field": "wake-wiki/field/revision/links-to",
        "title-field": "wake-wiki/field/revision/title",
        "summary-field": "wake-wiki/field/revision/summary",
        "content-source-field": "wake-wiki/field/revision/content-source",
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
    expect(entry).not.toMatch(/\((?:query|command|entity|route|plugin)\b/u);
  });
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
