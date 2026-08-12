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
    run([
      `${webRoot}/bin/wake-compile`,
      "--all",
      `${temporary}/substrate.wake`,
      `${temporary}/out`,
    ]);
    run([
      "bun",
      "build",
      `${temporary}/out/app.js`,
      `${temporary}/out/wake-client.js`,
      "--outdir",
      `${temporary}/built`,
      "--target",
      "browser",
    ]);
    return {
      application: await Bun.file(`${temporary}/out/app.js`).text(),
      client: await Bun.file(`${temporary}/out/wake-client.js`).text(),
      manifest: JSON.parse(
        await Bun.file(`${temporary}/out/app.wake.manifest.json`).text(),
      ),
      plan: JSON.parse(await Bun.file(`${temporary}/out/app.fram.json`).text()),
    };
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
        "revision/published-at": "wake-wiki/field/revision/published-at",
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
      "read-source-for-draft",
      "read-draft",
      "review",
      "history-current",
      "history-superseded",
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
      "published-at-field",
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
    expect(Object.fromEntries(
      Object.entries(manifest.configuration)
        .filter(([, descriptor]) => descriptor.type.declarationId !== undefined)
        .map(([name, descriptor]) => [name, descriptor.type.declarationId]),
    )).toEqual({
      "author-field": "revision/author",
      "base-field": "revision/based-on",
      "content-source-field": "revision/content-source",
      "created-at-field": "revision/created-at",
      "digest-field": "revision/digest",
      "draft-pointer": "resource/draft-revision",
      "lifecycle-type": "RevisionLifecycle",
      "links-field": "revision/links-to",
      "owner-field": "revision/resource",
      "published-at-field": "revision/published-at",
      "published-pointer": "resource/published-revision",
      "receipt-result-resource-field": "receipt-result-resource-field",
      "receipt-result-revision-field": "receipt-result-revision-field",
      "replaces-field": "revision/replaces-draft",
      resource: "resource",
      "resource-id": "resource/id",
      revision: "revision",
      "revision-id": "revision/id",
      "state-field": "revision/state",
      "summary-field": "revision/summary",
      "title-field": "revision/title",
    });
    expect(manifest.configuration["actor-entity"].type.declarationId)
      .toBeUndefined();
    expect(manifest.configuration["content-provider"].type.declarationId)
      .toBeUndefined();
    expect(Object.fromEntries(
      manifest.configuration["content-limits"].type.fields.map(field => [
        field.name,
        field.type.maximum,
      ]),
    )).toEqual({
      titleBytes: 1_048_576,
      titleScalars: 1_048_576,
      summaryBytes: 1_048_576,
      contentSourceBytes: 1_048_576,
      links: 200,
    });
    expect(manifest.configuration["query-limits"].type.fields.every(
      field => field.type.maximum === 247,
    )).toBe(true);
    expect(Object.fromEntries(
      manifest.configuration["safe-document-limits"].type.fields.map(field => [
        field.name,
        field.type.maximum,
      ]),
    )).toEqual({
      maxBytes: 1_048_576,
      maxDepth: 256,
      maxNodes: 65_536,
    });
    expect(manifest.configuration["safe-document-limits"].type.fields.find(
      field => field.name === "maxDepth",
    ).type.minimum).toBe(5);
  });

  test("keeps product semantics out of the reusable package", async () => {
    const manifest = await jsonAt("wake-plugin.json");
    const entry = await Bun.file(`${pluginRoot}/plugin.wake`).text();
    const semanticText = [...collectStrings(manifest), entry].join("\n")
      .replaceAll(":canonical-digest", "");
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

  test("freezes a closed SafeDocument v1 transport contract", async () => {
    const contract = await Bun.file(`${pluginRoot}/SAFE-DOCUMENT.md`).text();
    for (const tag of [
      "document",
      "paragraph",
      "heading",
      "blockQuote",
      "list",
      "codeBlock",
      "thematicBreak",
      "text",
      "emphasis",
      "strong",
      "inlineCode",
      "link",
      "lineBreak",
    ]) {
      expect(contract).toContain(`tag: \"${tag}\"`);
    }
    expect(contract).toContain("SafeUrl");
    expect(contract).toContain('{ kind: "external", href: string }');
    expect(contract).toContain('{ kind: "internal", reference: string }');
    expect(contract).toContain("never a bare string");
    expect(contract).toContain("rejects unknown keys");
    expect(contract).toContain("raw source remains available");
    expect((await jsonAt("package.json")).files).toContain("SAFE-DOCUMENT.md");
  });

  test("materializes the schema, lifecycle, and every exported component", async () => {
    const manifest = await jsonAt("wake-plugin.json");
    const entry = await Bun.file(`${pluginRoot}/plugin.wake`).text();
    expect(entry).toContain("(entity (config resource)\n");
    expect(entry).toContain("(entity (config revision)\n");
    expect(entry).toContain(
      "((config published-at-field) : Instant :write :command)",
    );
    for (const component of manifest.exports.components) {
      expect(entry).toContain(`(component ${component}\n`);
    }
    expect(entry).toContain("(defstate (config lifecycle-type)\n");
    expect(entry).toContain(
      "[(config draft-state) -> (config published-state) (config superseded-state)]",
    );
    expect(entry).toContain(
      "[(config published-state) -> (config superseded-state)]",
    );
    expect(entry).toContain("[(config superseded-state) ->]");
  });

  test("materializes every checked command with closed write invariants", async () => {
    const manifest = await jsonAt("wake-plugin.json");
    const entry = await Bun.file(`${pluginRoot}/plugin.wake`).text();
    for (const command of manifest.exports.commands) {
      expect(entry).toContain(`(command ${command}\n`);
    }
    expect(entry).toContain("((config digest-field) : Digest :write :create)");
    expect(entry.match(/:provider \(config content-provider\) SafeDocument/gu))
      .toHaveLength(3);
    expect(entry.match(/:canonical-digest Digest/gu)).toHaveLength(3);
    expect(entry.match(/:extensions \[receipt-fields\]/gu)).toHaveLength(5);
    expect(entry).toContain(
      "(expected-published-revision : (Nullable String))",
    );
    expect(entry).toContain(
      "(assert (not-contains (input expected-links-to) (input resource-id)))",
    );
    expect(entry).toContain(
      "(config published-at-field) (receipt-time)",
    );
    const abandonStart = entry.indexOf("(command abandon-draft\n");
    const abandonEnd = entry.indexOf("\n(command publish\n", abandonStart);
    const abandon = entry.slice(abandonStart, abandonEnd);
    expect(abandon).toContain("abandon-own-draft");
    expect(abandon).toContain("abandon-any-draft");
    expect(abandon).toContain("(config author-field) (actor id)");
  });

  test("materializes every exported query without draft leakage", async () => {
    const manifest = await jsonAt("wake-plugin.json");
    const entry = await Bun.file(`${pluginRoot}/plugin.wake`).text();
    for (const query of manifest.exports.queries) {
      expect(entry).toContain(`(query ${query}\n`);
    }
    const publishedStart = entry.indexOf("(query read-published\n");
    const publishedEnd = entry.indexOf(
      "\n(query read-source-for-draft\n",
      publishedStart,
    );
    const published = entry.slice(publishedStart, publishedEnd);
    expect(published).toContain(
      "(= (field entry (config published-pointer)) published)",
    );
    expect(published).toContain(
      "(= (field published (config owner-field)) entry)",
    );
    expect(published).toContain(
      "(= (field published (config state-field)) (config published-state))",
    );
    expect(published).toContain(
      "(content-source (field published (config content-source-field)))",
    );
    expect(published).toContain(
      "(extension-fields revision-fields published)",
    );
    expect(published).not.toMatch(/draft|superseded/u);

    const sourceStart = entry.indexOf("(query read-source-for-draft\n");
    const sourceEnd = entry.indexOf("\n(query read-draft\n", sourceStart);
    const source = entry.slice(sourceStart, sourceEnd);
    expect(source).toContain(":capability start-draft");
    expect(source).toContain(
      "(= (field entry (config published-pointer)) published)",
    );
    expect(source).toContain(
      "(= (field published (config owner-field)) entry)",
    );
    expect(source).toContain(
      "(= (field published (config state-field)) (config published-state))",
    );
    expect(source).toContain(
      "(content-source (field published (config content-source-field)))",
    );
    expect(source).toContain(
      "(extension-fields revision-fields published)",
    );
    expect(source).not.toMatch(/draft-pointer|draft-state|superseded/u);

    const currentHistoryStart = entry.indexOf("(query history-current\n");
    const supersededHistoryStart = entry.indexOf(
      "\n(query history-superseded\n",
      currentHistoryStart,
    );
    const historyEnd = entry.indexOf("\n(query backlinks\n", supersededHistoryStart);
    const currentHistory = entry.slice(currentHistoryStart, supersededHistoryStart);
    const supersededHistory = entry.slice(supersededHistoryStart, historyEnd);
    expect(currentHistory).toContain(
      "(= (field entry (config published-pointer)) edition)",
    );
    expect(currentHistory).toContain(
      "(= (field edition (config owner-field)) entry)",
    );
    expect(currentHistory).toContain(
      "(= (field edition (config state-field)) (config published-state))",
    );
    expect(currentHistory).toContain(
      "(published-at (field edition (config published-at-field)))",
    );
    expect(currentHistory).not.toMatch(/draft|superseded/u);
    expect(supersededHistory).toContain(
      "(= (field edition (config owner-field)) entry)",
    );
    expect(supersededHistory).toContain(
      "(= (field edition (config state-field)) (config superseded-state))",
    );
    expect(supersededHistory).toContain(
      "(published-at (field edition (config published-at-field)))",
    );
    expect(supersededHistory).not.toMatch(/draft|published-pointer/u);

    const backlinksStart = entry.indexOf("(query backlinks\n");
    const backlinksEnd = entry.indexOf("\n(component browse-page\n", backlinksStart);
    const backlinks = entry.slice(backlinksStart, backlinksEnd);
    expect(backlinks).toContain(
      "(= (field target (config published-pointer)) target-published)",
    );
    expect(backlinks).toContain(
      "(= (field target-published (config owner-field)) target)",
    );
    expect(backlinks).toContain(
      "(= (field target-published (config state-field)) (config published-state))",
    );
    expect(backlinks).toContain(
      "(= (field source (config published-pointer)) published)",
    );
    expect(backlinks).toContain(
      "(= (field published (config state-field)) (config published-state))",
    );
    expect(backlinks).toContain(
      "(extension-fields revision-fields published)",
    );
    expect(backlinks).not.toMatch(/draft|superseded/u);
  });

  test("packs deterministically from the real declaration source", async () => {
    const first = await packPlugin(pluginRoot);
    const second = await packPlugin(pluginRoot);
    expect(first.bytes).toBe(second.bytes);
    expect(first.digest).toBe(second.digest);
    expect(first.digest).toBe(sha256Digest(first.bytes));
    expect(first.artifact.files).toHaveLength(1);
    expect(first.artifact.files[0].path).toBe("plugin.wake");
    expect(first.artifact.files[0].content).toContain(
      "(entity (config resource)\n",
    );
    expect(first.artifact.files[0].content).toContain(
      "(entity (config revision)\n",
    );
  });

  test("links the delivered substrate into one checked FRAM graph", async () => {
    const { application, client, manifest: applicationManifest, plan } =
      await compileSubstratePlan();
    expect(plan.applicationId).toBe("wake-wiki-substrate-fixture");
    expect(plan.pluginClosure).toHaveLength(1);
    expect(plan.pluginClosure[0]).toMatchObject({
      alias: "wiki",
      allowedContributions: ["schema", "query", "command", "capability", "ui", "route"],
      packageId: "wake-wiki",
      version: "0.1.0",
    });
    expect(plan.entities.map((entity) => entity.name)).toEqual([
      "member",
      "wiki.entry",
      "wiki.edition",
      "wake.core/command-receipt",
    ]);
    expect(plan.entities.map((entity) => entity.storageId)).toEqual([
      "wake-wiki-substrate-fixture/entity/member",
      "wake-wiki/entity/resource",
      "wake-wiki/entity/revision",
      "wake/core/entity/command-receipt",
    ]);
    const resource = plan.entities.find((entity) => entity.name === "wiki.entry");
    const revision = plan.entities.find((entity) => entity.name === "wiki.edition");
    expect(resource.identity).toMatchObject({
      field: "entry-id",
      storageId: "wake-wiki/field/resource/id",
    });
    expect(resource.fields.filter((field) => field.name !== "entry-id")
      .every((field) => field.write === "command")).toBe(true);
    expect(revision.identity).toMatchObject({
      field: "edition-id",
      storageId: "wake-wiki/field/revision/id",
    });
    expect(revision.fields.filter((field) =>
      field.name !== "edition-id"
        && field.name !== "phase"
        && field.name !== "released-at"
    ).every((field) => field.write === "create")).toBe(true);
    expect(revision.fields.find((field) => field.name === "phase").write)
      .toBe("command");
    expect(revision.fields.find((field) => field.name === "released-at"))
      .toMatchObject({
        storageId: "wake-wiki/field/revision/published-at",
        type: "Instant",
        write: "command",
      });
    expect(plan.stateMachines).toEqual([{
      entity: "wiki.edition",
      field: "phase",
      initial: "working",
      stateType: "wiki.EditionPhase",
      transitions: {
        working: ["released", "withdrawn"],
        released: ["withdrawn"],
        withdrawn: [],
      },
    }]);
    expect(plan.queries.map((query) => query.name)).toEqual([
      "wiki.browse-published",
      "wiki.read-published",
      "wiki.read-source-for-draft",
      "wiki.read-draft",
      "wiki.review",
      "wiki.history-current",
      "wiki.history-superseded",
      "wiki.backlinks",
    ]);
    expect(plan.queries.filter((query) => query.result.kind === "page")
      .map((query) => [
        query.name,
        query.result.defaultLimit,
        query.result.maxLimit,
      ])).toEqual([
      ["wiki.browse-published", 10, 20],
      ["wiki.history-superseded", 10, 20],
      ["wiki.backlinks", 10, 20],
    ]);
    for (const query of plan.queries) {
      const localName = query.name.slice("wiki.".length);
      const expectedCapability = {
        "browse-published": "wake-wiki/cap/browse-published",
        "read-published": "wake-wiki/cap/read-published",
        "read-source-for-draft": "wake-wiki/cap/start-draft",
        "read-draft": "wake-wiki/cap/read-draft",
        review: "wake-wiki/cap/review-draft",
        "history-current": "wake-wiki/cap/read-history",
        "history-superseded": "wake-wiki/cap/read-history",
        backlinks: "wake-wiki/cap/read-backlinks",
      }[localName];
      expect(query.capabilities).toEqual([expectedCapability]);
      expect(query.select[0]).toMatchObject({
        cardinality: "single",
        valueKind: "literal",
      });
      expect(query.dependencies.length).toBeGreaterThan(0);
    }

    const currentHistory = plan.queries.find(
      (query) => query.name === "wiki.history-current",
    );
    expect(currentHistory.result).toEqual({ kind: "optional" });
    expect(currentHistory.where).toEqual(expect.arrayContaining([
      expect.objectContaining({
        left: expect.objectContaining({
          binding: "entry",
          field: "released-edition",
          kind: "field",
        }),
        op: "eq",
        right: expect.objectContaining({
          binding: "edition",
          kind: "binding",
        }),
      }),
      expect.objectContaining({
        left: expect.objectContaining({
          binding: "edition",
          field: "phase",
          kind: "field",
        }),
        op: "eq",
        right: expect.objectContaining({
          kind: "literal",
          value: "released",
        }),
      }),
    ]));
    const supersededHistory = plan.queries.find(
      (query) => query.name === "wiki.history-superseded",
    );
    expect(supersededHistory.where).toEqual(expect.arrayContaining([
      expect.objectContaining({
        left: expect.objectContaining({
          binding: "edition",
          field: "phase",
          kind: "field",
        }),
        op: "eq",
        right: expect.objectContaining({
          kind: "literal",
          value: "withdrawn",
        }),
      }),
    ]));
    expect(supersededHistory.select).toEqual(expect.arrayContaining([
      expect.objectContaining({
        binding: "edition",
        field: "released-at",
        name: "published-at",
      }),
    ]));

    const backlinks = plan.queries.find(
      (query) => query.name === "wiki.backlinks",
    );
    expect(backlinks.where).toEqual(expect.arrayContaining([
      expect.objectContaining({
        left: expect.objectContaining({
          binding: "target",
          field: "released-edition",
          kind: "field",
        }),
        op: "eq",
        right: expect.objectContaining({
          binding: "target-published",
          kind: "binding",
        }),
      }),
      expect.objectContaining({
        left: expect.objectContaining({
          binding: "target-published",
          field: "phase",
          kind: "field",
        }),
        op: "eq",
        right: expect.objectContaining({
          kind: "literal",
          value: "released",
        }),
      }),
    ]));
    for (const name of [
      "wiki.browse-published",
      "wiki.read-published",
      "wiki.read-source-for-draft",
      "wiki.read-draft",
      "wiki.review",
      "wiki.history-current",
      "wiki.history-superseded",
      "wiki.backlinks",
    ]) {
      expect(plan.queries.find(query => query.name === name).select)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            field: "audience",
            name: "audience",
          }),
        ]));
    }

    expect(plan.routes).toEqual([
      {
        inputParameters: [],
        parameters: [],
        path: "/library",
        queries: [{ name: "wiki.browse-published", prefix: null }],
        requiredProps: ["title", "summary"],
        view: "wiki.browse-view",
      },
      {
        inputParameters: [],
        parameters: [],
        path: "/library/new",
        queries: [],
        requiredProps: [],
        view: "wiki.new-view",
      },
      {
        inputParameters: ["resource-id"],
        parameters: ["entry-id"],
        path: "/library/:entry-id",
        queries: [{ name: "wiki.read-published", prefix: null }],
        requiredProps: ["title", "summary", "content-source"],
        view: "wiki.read-view",
      },
      {
        inputParameters: ["resource-id"],
        parameters: ["entry-id"],
        path: "/library/:entry-id/edit",
        queries: [{ name: "wiki.read-draft", prefix: null }],
        requiredProps: ["title", "content-source"],
        view: "wiki.edit-view",
      },
      {
        inputParameters: ["resource-id"],
        parameters: ["entry-id"],
        path: "/library/:entry-id/review",
        queries: [
          { name: "wiki.review", prefix: "draft" },
          { name: "wiki.read-published", prefix: "published" },
        ],
        requiredProps: [
          "draft-title",
          "draft-summary",
          "published-title",
          "published-summary",
        ],
        view: "wiki.review-view",
      },
      {
        inputParameters: ["resource-id"],
        parameters: ["entry-id"],
        path: "/library/:entry-id/history",
        queries: [{ name: "wiki.history-current", prefix: null }],
        requiredProps: ["title", "state", "created-at"],
        view: "wiki.history-view",
      },
    ]);
    expect(plan.composition.providers).toEqual([
      expect.objectContaining({
        name: "plain-text",
        package_id: "wake-wiki",
        port_name: "content-parser",
      }),
    ]);
    expect(plan.composition.mounts).toHaveLength(6);
    expect(application).toContain("wakeMatchRoute(location.pathname)");
    expect(application).toContain('path: "/library/:entry-id/review"');
    expect(application).toContain('name: "wiki.read-published"');
    expect(client).toContain("wiki.browse-published");
    expect(applicationManifest.artifacts.browserClient.sha256)
      .toBe(sha256Digest(client));
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
