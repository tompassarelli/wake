import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  checkedDeclarationProgramFromBundle,
} from "../../../compiler/checked-declarations.mjs";
import {
  canonicalDocument,
  parseCanonicalDocument,
  sha256Digest,
} from "../../../compiler/canonical.mjs";
import { linkCheckedDeclarations } from "../../../compiler/declaration-linker.mjs";
import {
  packPlugin,
  validatePluginManifest,
} from "../../../compiler/plugin-package.mjs";

const pluginRoot = `${import.meta.dir}/..`;
const webRoot = `${pluginRoot}/../..`;
const repositoryRoot = `${webRoot}/..`;
const beagleRoot = process.env.BEAGLE_PROJECTION_ROOT
  ?? process.env.BEAGLE_ROOT
  ?? join(homedir(), "code", "beagle", "main");
const beagle = join(beagleRoot, "bin", "beagle");
const declarationPaths = Object.freeze({
  handbook: `${pluginRoot}/fixtures/handbook/handbook.bjs`,
  plugin: `${pluginRoot}/plugin.bjs`,
  wakeCore: `${webRoot}/wake/core.bjs`,
  wakeIr: `${webRoot}/wake/ir.bjs`,
});
const declarationSourceIds = Object.freeze({
  handbook: "handbook.bjs",
  plugin: "plugin.bjs",
  wakeCore: "web/wake/core.bjs",
  wakeIr: "web/wake/ir.bjs",
});
const declarationSourceTexts = Object.freeze(Object.fromEntries(
  Object.entries(declarationPaths).map(([name, path]) => [
    declarationSourceIds[name],
    readFileSync(path, "utf8"),
  ]),
));

function suppliedSource(sourceId, authority) {
  return {
    authority,
    bytesBase64: Buffer.from(declarationSourceTexts[sourceId]).toString("base64"),
    sourceId,
  };
}

function checkedBundle(entrySourceId, sources) {
  const result = Bun.spawnSync([beagle, "ast-bundle"], {
    cwd: repositoryRoot,
    stdin: Buffer.from(JSON.stringify({
      entrySourceId,
      kind: "beagle.checked-bundle.request",
      schemaVersion: 4,
      sources,
    })),
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return JSON.parse(result.stdout.toString());
}

let declarationCorpus;
function checkedDeclarationCorpus() {
  if (declarationCorpus !== undefined) return declarationCorpus;
  const wakeCoreModelBundle = checkedBundle(declarationSourceIds.wakeCore, [
    suppliedSource(declarationSourceIds.wakeCore, "trusted"),
  ]);
  const wakeIrModelBundle = checkedBundle(declarationSourceIds.wakeIr, [
    suppliedSource(declarationSourceIds.wakeIr, "trusted"),
  ]);
  const decode = (entrySourceId) => {
    const bundle = checkedBundle(entrySourceId, [
      suppliedSource(entrySourceId, "package"),
      suppliedSource(declarationSourceIds.wakeCore, "trusted"),
    ]);
    const sourceIds = new Set([
      ...bundle.modules.map((module) => module.sourceId),
      ...wakeCoreModelBundle.modules.map((module) => module.sourceId),
      ...wakeIrModelBundle.modules.map((module) => module.sourceId),
    ]);
    const sourceTexts = Object.fromEntries(
      [...sourceIds].map((sourceId) => [
        sourceId,
        declarationSourceTexts[sourceId],
      ]),
    );
    return checkedDeclarationProgramFromBundle(bundle, {
      compilerVersion: "0.1.0",
      sourceTexts,
      wakeCoreModelBundle,
      wakeIrModelBundle,
    });
  };
  declarationCorpus = Object.freeze({
    handbook: decode(declarationSourceIds.handbook),
    plugin: decode(declarationSourceIds.plugin),
  });
  return declarationCorpus;
}

function wikiProgram() {
  return checkedDeclarationCorpus().plugin.program;
}

function wikiPlugin() {
  return wikiProgram().root.plugin;
}

function referenceNames(references) {
  return references.map((reference) => reference.name);
}

const configurationFields = Object.freeze([
  "ints",
  "strings",
  "bools",
  "keywords",
  "entity_names",
  "field_names",
  "state_names",
  "state_value_names",
  "external_entities",
  "values",
]);

function configurationRoles(configuration) {
  return configurationFields.flatMap((field) => configuration[field]);
}

function taggedValues(value, tag, result = [], seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return result;
  seen.add(value);
  if (value._tag === tag) result.push(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) taggedValues(child, tag, result, seen);
  return result;
}

async function linkedHandbook() {
  const packed = await packPlugin(pluginRoot);
  const commit = run(["git", "rev-parse", "HEAD"]).trim();
  return linkCheckedDeclarations({
    application: checkedDeclarationCorpus().handbook,
    compilerVersion: "0.1.0",
    plugins: [{
      artifact: packed.artifact,
      checked: checkedDeclarationCorpus().plugin,
      lockEntry: {
        artifact: "wake-wiki.wakepkg.json",
        digest: packed.digest,
        packageId: "wake-wiki",
        source: { commit, kind: "git" },
        version: "0.1.0",
      },
    }],
  });
}

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
      `${pluginRoot}/fixtures/substrate/substrate.bjs`,
    ).text();
    await Bun.write(`${temporary}/substrate.bjs`, source);
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
      `${temporary}/substrate.bjs`,
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
      plan: JSON.parse(await Bun.file(`${temporary}/out/app.store.json`).text()),
    };
  } finally {
    run(["rm", "-rf", "--", temporary]);
  }
}

checkedDeclarationCorpus();

describe("wake-wiki K0C data contract", () => {
  test("uses the frozen W0C manifest envelope", async () => {
    const manifestText = await Bun.file(`${pluginRoot}/wake-plugin.json`).text();
    const manifest = parseCanonicalDocument(manifestText, "wake-plugin.json");
    expect(validatePluginManifest(manifest)).toBe(manifest);
    expect(Object.keys(manifest)).toEqual([
      "compatibleWake",
      "durableSchemaVersion",
      "entry",
      "packageId",
      "pluginAbiVersion",
      "schemaVersion",
      "sources",
      "version",
    ]);
    expect(manifest).toEqual({
      compatibleWake: "0.1.0",
      durableSchemaVersion: 1,
      entry: "plugin.bjs",
      packageId: "wake-wiki",
      pluginAbiVersion: 1,
      schemaVersion: 1,
      sources: ["plugin.bjs"],
      version: "0.1.0",
    });

    const plugin = wikiPlugin();
    expect(plugin.identity).toMatchObject({
      compatible_wake: "0.1.0",
      durable_schema_version: 1,
      package_id: "wake-wiki",
      plugin_abi_version: 1,
      version: "0.1.0",
    });
    expect(plugin.contributions.map((contribution) => contribution._tag)).toEqual([
      "IrSchemaContribution",
      "IrQueryContribution",
      "IrCommandContribution",
      "IrCapabilityContribution",
      "IrUiContribution",
      "IrRouteContribution",
    ]);
    expect(plugin.migrations).toEqual([]);

    const packageMetadata = await jsonAt("package.json");
    expect(packageMetadata.name).toBe(manifest.packageId);
    expect(packageMetadata.version).toBe(manifest.version);
  });

  test("freezes every plugin-owned storage identity", () => {
    const program = wikiProgram();
    const entityStorage = Object.fromEntries(
      program.entities.map((entity) => [
        entity.ref.declaration_id,
        entity.storage_id,
      ]),
    );
    const fieldStorage = Object.fromEntries([
      ...program.entities.flatMap((entity) => entity.fields),
      ...program.receipt_fields,
    ].filter((field) => field.storage_id?.startsWith("wake-wiki/"))
      .map((field) => [field.ref.declaration_id, field.storage_id]));
    const storageIds = [
      ...Object.values(entityStorage),
      ...Object.values(fieldStorage),
    ];
    expect({ entities: entityStorage, fields: fieldStorage }).toEqual({
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
    expect(referenceNames(wikiPlugin().exports.entities)).toEqual([
      "resource",
      "revision",
    ]);
  });

  test("exports only the first vertical slice", () => {
    const program = wikiProgram();
    const plugin = wikiPlugin();
    expect(referenceNames(plugin.exports.commands)).toEqual([
      "create-resource-draft",
      "start-revision-draft",
      "replace-draft",
      "abandon-draft",
      "publish",
    ]);
    expect(referenceNames(plugin.exports.queries)).toEqual([
      "browse-published",
      "read-published",
      "read-source-for-draft",
      "read-draft",
      "review",
      "history-current",
      "history-superseded",
      "backlinks",
    ]);
    expect(referenceNames(plugin.exports.capabilities)).toEqual([
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
    expect(referenceNames(plugin.exports.route_templates)).toEqual([
      "browse",
      "new",
      "read",
      "edit",
      "review",
      "history",
    ]);
    expect(referenceNames(plugin.exports.provider_ports)).toEqual([
      "content-parser",
    ]);
    expect(referenceNames(plugin.required_providers)).toEqual(["content-parser"]);
    expect(program.entity_fields_ports.map((port) => ({
      name: port.ref.name,
      policy: port.policy._tag,
      requireStorageId: port.policy.require_storage_id,
      target: port.target._tag,
      write: port.policy.write._tag,
    }))).toEqual([
      {
        name: "revision-fields",
        policy: "IrOpenManyEntityFields",
        requireStorageId: true,
        target: "IrDeclaredEntityFieldsTarget",
        write: "IrCreateWrite",
      },
      {
        name: "receipt-fields",
        policy: "IrOpenManyEntityFields",
        requireStorageId: true,
        target: "IrReceiptEntityFieldsTarget",
        write: "IrServerWrite",
      },
    ]);
    expect(referenceNames(plugin.exports.route_slots)).toEqual([
      "browse",
      "new",
      "read",
      "edit",
      "review",
      "history",
    ]);
  });

  test("requires a closed and complete application binding", () => {
    const configuration = wikiPlugin().configuration;
    const roles = configurationRoles(configuration);
    const names = roles.map((role) => role.ref.name).sort();
    expect(names).toEqual([
      "actor-entity",
      "author-field",
      "base-field",
      "content-limits",
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
    expect(Object.fromEntries([
      ...configuration.entity_names.map((role) => [
        role.ref.name,
        role.target.declaration_id,
      ]),
      ...configuration.field_names.map((role) => [
        role.ref.name,
        role.target.field.declaration_id,
      ]),
      ...configuration.state_names.map((role) => [
        role.ref.name,
        role.target.declaration_id,
      ]),
      ...configuration.state_value_names.map((role) => [
        role.ref.name,
        role.target.declaration_id,
      ]),
    ])).toEqual({
      "author-field": "revision/author",
      "base-field": "revision/based-on",
      "content-source-field": "revision/content-source",
      "created-at-field": "revision/created-at",
      "digest-field": "revision/digest",
      "draft-pointer": "resource/draft-revision",
      "draft-state": "RevisionLifecycle/value/draft",
      "lifecycle-type": "RevisionLifecycle",
      "links-field": "revision/links-to",
      "owner-field": "revision/resource",
      "published-at-field": "revision/published-at",
      "published-pointer": "resource/published-revision",
      "published-state": "RevisionLifecycle/value/published",
      "receipt-result-resource-field": "receipt-result-resource-field",
      "receipt-result-revision-field": "receipt-result-revision-field",
      "replaces-field": "revision/replaces-draft",
      resource: "resource",
      "resource-id": "resource/id",
      revision: "revision",
      "revision-id": "revision/id",
      "state-field": "revision/state",
      "summary-field": "revision/summary",
      "superseded-state": "RevisionLifecycle/value/superseded",
      "title-field": "revision/title",
    });
    expect(configuration.external_entities.map((role) => role.ref.name))
      .toEqual(["actor-entity"]);
    expect(names).not.toContain("content-provider");
    const valueRoles = new Map(
      configuration.values.map((role) => [role.ref.name, role.value_type]),
    );
    expect(Object.fromEntries(
      valueRoles.get("content-limits").fields.map((field) => [
        field.name,
        field.value_type.maximum.value,
      ]),
    )).toEqual({
      titleBytes: 1_048_576,
      titleScalars: 1_048_576,
      summaryBytes: 1_048_576,
      contentSourceBytes: 1_048_576,
      links: 200,
    });
    expect(valueRoles.get("query-limits").fields.every(
      (field) => field.value_type.maximum.value === 247,
    )).toBe(true);
    expect(Object.fromEntries(
      valueRoles.get("safe-document-limits").fields.map((field) => [
        field.name,
        field.value_type.maximum.value,
      ]),
    )).toEqual({
      maxBytes: 1_048_576,
      maxDepth: 256,
      maxNodes: 65_536,
    });
    expect(valueRoles.get("safe-document-limits").fields.find(
      (field) => field.name === "maxDepth",
    ).value_type.minimum.value).toBe(5);
  });

  test("keeps product semantics out of the reusable package", async () => {
    const entry = await Bun.file(`${pluginRoot}/plugin.bjs`).text();
    const semanticText = [...collectStrings(wikiProgram()), entry].join("\n")
      .replaceAll("canonical-digest", "");
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
    expect(entry.trimStart()).toStartWith("#lang beagle/js");
    expect(entry).toContain("(ns wake.plugins.wiki");
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

  test("materializes the schema, lifecycle, and every exported component", () => {
    const program = wikiProgram();
    const plugin = wikiPlugin();
    expect(program.entities.map((entity) => entity.ref.declaration_id)).toEqual([
      "resource",
      "revision",
    ]);
    const revision = program.entities.find(
      (entity) => entity.ref.declaration_id === "revision",
    );
    expect(revision.fields.find(
      (field) => field.ref.declaration_id === "revision/published-at",
    ).value_type._tag).toBe("IrInstantField");
    expect(referenceNames(plugin.exports.components)).toEqual([
      "browse-page",
      "new-draft-page",
      "read-page",
      "edit-draft-page",
      "review-page",
      "history-page",
      "resource-card",
      "revision-summary",
      "safe-document-component",
      "link-list",
      "backlink-list",
      "conflict-notice",
    ]);
    expect(plugin.exports.components.every((reference) =>
      program.components.some((component) => component.ref === reference)
    )).toBe(true);
    expect(program.states.map((state) => ({
      initial: state.initial.name,
      name: state.ref.name,
      transitions: state.transitions.map((transition) => [
        transition.from.name,
        referenceNames(transition.to),
      ]),
    }))).toEqual([{
      initial: "draft",
      name: "RevisionLifecycle",
      transitions: [
        ["draft", ["published", "superseded"]],
        ["published", ["superseded"]],
        ["superseded", []],
      ],
    }]);
    expect(taggedValues(program, "IrConfiguredProjectionBound")
      .map((bound) => bound.projection.role.name)).toEqual(
        expect.arrayContaining(["content-limits", "safe-document-limits"]),
      );
  });

  test("materializes every checked command with closed write invariants", () => {
    const program = wikiProgram();
    expect(program.commands.map((command) => command.ref.name)).toEqual(
      referenceNames(wikiPlugin().exports.commands),
    );
    const digest = program.entities.flatMap((entity) => entity.fields).find(
      (field) => field.ref.declaration_id === "revision/digest",
    );
    expect(digest.value_type._tag).toBe("IrDigestField");
    expect(taggedValues(program.commands, "IrProviderInjection")).toHaveLength(3);
    expect(taggedValues(program.commands, "IrCanonicalDigestInjection"))
      .toHaveLength(3);
    expect(taggedValues(program.commands, "IrExtensionCommandWrite"))
      .toHaveLength(3);
    expect(taggedValues(program.commands, "IrCommandReceiptTimeExpr"))
      .toHaveLength(4);
    expect(taggedValues(program.commands, "IrCommandInputExpr")
      .map((expression) => expression.name)).toContain("expected-links-to");
    for (const command of program.commands) {
      expect(command.receipt.results.map((result) => [
        result.name,
        result.field.name,
      ])).toEqual([
        ["resource-id", "resource-id"],
        ["revision-id", "revision-id"],
      ]);
    }
    const abandon = program.commands.find(
      (command) => command.ref.name === "abandon-draft",
    );
    expect(referenceNames(abandon.capabilities)).toEqual([
      "abandon-own-draft",
      "abandon-any-draft",
    ]);
    const publish = program.commands.find((command) => command.ref.name === "publish");
    expect(publish.input.map((input) => input.name)).toEqual(
      expect.arrayContaining(["expected-links-to", "expected-published-revision"]),
    );
  });

  test("materializes every exported query without draft leakage", () => {
    const program = wikiProgram();
    expect(program.queries.map((query) => query.ref.name)).toEqual(
      referenceNames(wikiPlugin().exports.queries),
    );
    expect(taggedValues(program.queries, "IrQueryProviderSelection"))
      .toHaveLength(1);
    expect(taggedValues(program.queries, "IrQueryExtensionSelection"))
      .toHaveLength(8);
    expect(taggedValues(program.queries, "IrQueryExtensionSelection").every(
      (selection) => selection.port.name === "revision-fields",
    )).toBe(true);
    expect(taggedValues(program.queries, "IrQueryStateValue")
      .map((value) => value.value.name)).toEqual(
        expect.arrayContaining(["published", "superseded"]),
      );
  });

  test("packs deterministically from the real declaration source", async () => {
    const first = await packPlugin(pluginRoot);
    const second = await packPlugin(pluginRoot);
    expect(first.bytes).toBe(second.bytes);
    expect(first.digest).toBe(second.digest);
    expect(first.digest).toBe(sha256Digest(first.bytes));
    expect(first.artifact.files).toHaveLength(1);
    expect(first.artifact.files[0].path).toBe("plugin.bjs");
    expect(first.artifact.files[0].content)
      .toBe(declarationSourceTexts[declarationSourceIds.plugin]);
  });

  test("links the delivered substrate into one checked Store graph", async () => {
    const { application, client, manifest: applicationManifest, plan } =
      await compileSubstratePlan();
    expect(plan.applicationId).toBe("wake-wiki-substrate-fixture");
    expect(plan.pluginClosure).toHaveLength(1);
    const manifestPlugin = applicationManifest.plugins[0];
    expect(manifestPlugin).toMatchObject({
      allowedContributions: ["schema", "query", "command", "capability", "ui", "route"],
      packageId: "wake-wiki",
      version: "0.1.0",
    });
    expect(plan.pluginClosure[0]).toEqual({
      alias: manifestPlugin.alias,
      artifact_digest: manifestPlugin.artifactDigest,
      artifact_path: "wake-wiki.wakepkg.json",
      configuration_digest: manifestPlugin.configurationDigest,
      durable_schema_version: manifestPlugin.durableSchemaVersion,
      entry_path: "plugin.bjs",
      migration_ordinal: manifestPlugin.migrationOrdinal,
      package_id: manifestPlugin.packageId,
      source_kind: manifestPlugin.source.kind,
      source_revision: manifestPlugin.source.commit,
      version: manifestPlugin.version,
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
        requiredProps: ["title", "summary", "safe-document"],
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
    const linked = await linkedHandbook();
    expect(linked.plugins).toHaveLength(1);
    const instance = linked.plugins[0];
    expect(instance).toMatchObject({
      alias: "wiki",
      evidence: {
        durable_schema_version: 1,
        package_id: "wake-wiki",
        version: "0.1.0",
      },
      use: {
        package_id: "wake-wiki",
        version: "0.1.0",
      },
    });
    const configuredRoles = configurationRoles(wikiPlugin().configuration)
      .map((role) => role.ref.name)
      .sort();
    const boundRoles = configurationFields.flatMap(
      (field) => instance.use.bindings[field].map((binding) => binding.role.name),
    ).sort();
    expect(boundRoles).toEqual(configuredRoles);
    expect(instance.composition.mounts.map((mount) => mount.slot.name)).toEqual(
      referenceNames(wikiPlugin().exports.route_slots),
    );
    expect(instance.composition.extensions.flatMap((extension) =>
      extension.fields.map((field) => [
        field.ref.name,
        field.storage_id,
      ])
    )).toEqual([
      ["audience", "handbook-fixture/field/edition/audience"],
      [
        "release-rule-digest",
        "handbook-fixture/field/receipt/release-rule-digest",
      ],
    ]);

    const source = await Bun.file(
      `${pluginRoot}/fixtures/handbook/handbook.bjs`,
    ).text();
    expect(source).not.toMatch(
      /greywrought|\barticle\b|\bcanonical\b|\bobsolete\b|\bprincipal\b|\blore\b/iu,
    );
  });
});
