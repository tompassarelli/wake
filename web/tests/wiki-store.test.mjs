import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");
const WIKI_APP = "wake-demo-wiki";
const COMPILER_TEST_TIMEOUT_MS = 20_000;

function spawnSync(command, args, { cwd, env = process.env } = {}) {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function appScope(app, value) {
  return [
    "triple",
    ["keyword", "wake/app"],
    ["keyword", app],
    value,
  ];
}

function entityStorageId(app, entity) {
  return `app:${app}/entity:${entity}`;
}

function fieldStorageId(app, entity, field) {
  return `${entityStorageId(app, entity)}/field:${field}`;
}

function subjectTemplate(app, entity, identityField) {
  return appScope(app, [
    "triple",
    ["keyword", "entity"],
    ["keyword", entityStorageId(app, entity)],
    { field: fieldStorageId(app, entity, identityField) },
  ]);
}

function predicateTerm(app, entity, field) {
  return appScope(app, [
    "triple",
    ["keyword", "field"],
    ["keyword", entityStorageId(app, entity)],
    ["keyword", fieldStorageId(app, entity, field)],
  ]);
}

function fieldPlan(
  app,
  entity,
  name,
  type,
  { cardinality = "single", targetEntity, write = "set" } = {},
) {
  const plan = {
    name,
    storageId: fieldStorageId(app, entity, name),
    type,
    cardinality,
    valueKind: targetEntity === undefined ? "literal" : "ref",
    write,
    predicateTerm: predicateTerm(app, entity, name),
  };
  if (targetEntity !== undefined) plan.targetEntity = targetEntity;
  return plan;
}

function entityPlan(app, name, identityField, identityType, fields) {
  return {
    name,
    storageId: entityStorageId(app, name),
    identity: {
      field: identityField,
      storageId: fieldStorageId(app, name, identityField),
      type: identityType,
      cardinality: "single",
      valueKind: "literal",
      subjectTemplate: subjectTemplate(app, name, identityField),
    },
    fields,
  };
}

test("the wiki compiles as a Store-native Wake application", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "wake-wiki-store-"));

  try {
    const compiled = spawnSync(
      join(webRoot, "bin", "wake-compile"),
      ["--all", "demo/wiki.bjs", outputDir],
      { cwd: webRoot },
    );
    const diagnostics = [
      compiled.stdout,
      compiled.stderr,
    ].filter(Boolean).join("\n");
    assert.equal(compiled.status, 0, diagnostics);

    const storePath = join(outputDir, "app.store.json");
    const appPath = join(outputDir, "app.js");
    const clientPath = join(outputDir, "wake-client.js");
    const deploymentPath = join(outputDir, "app.wake.deployment.json");
    const manifestPath = join(outputDir, "app.wake.manifest.json");
    assert.equal(existsSync(storePath), true, "app.store.json was not emitted");
    assert.equal(existsSync(appPath), true, "app.js was not emitted");
    assert.equal(existsSync(clientPath), true, "wake-client.js was not emitted");
    assert.equal(
      existsSync(deploymentPath),
      true,
      "app.wake.deployment.json was not emitted",
    );
    assert.equal(
      existsSync(manifestPath),
      true,
      "app.wake.manifest.json was not emitted",
    );
    assert.deepEqual(readdirSync(outputDir).sort(), [
      "app.store.json",
      "app.js",
      "app.wake.deployment.json",
      "app.wake.manifest.json",
      "wake-client.js",
    ]);

    const storeSource = readFileSync(storePath, "utf8");
    assert.ok(storeSource.endsWith("\n"));
    assert.ok(!storeSource.endsWith("\n\n"));
    const storePlan = JSON.parse(storeSource);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.match(
      storePlan.semanticFingerprint,
      /^sha256:[0-9a-f]{64}$/u,
    );
    assert.equal(
      storePlan.semanticFingerprint,
      manifest.checkedApplication.fingerprint,
    );
    assert.equal(manifest.applicationId, WIKI_APP);
    assert.deepEqual(storePlan, {
      schemaVersion: 2,
      applicationId: WIKI_APP,
      backend: "store",
      semanticFingerprint: storePlan.semanticFingerprint,
      pluginClosure: [],
      composition: {
        extensions: [],
        fills: [],
        mounts: [],
        providers: [],
      },
      entities: [
        entityPlan(WIKI_APP, "page", "slug", "String", [
          fieldPlan(WIKI_APP, "page", "slug", "String"),
          fieldPlan(WIKI_APP, "page", "title", "String"),
          fieldPlan(WIKI_APP, "page", "canonical-revision", "Ref", {
            targetEntity: "revision",
            write: "command",
          }),
        ]),
        entityPlan(WIKI_APP, "revision", "id", "String", [
          fieldPlan(WIKI_APP, "revision", "id", "String"),
          fieldPlan(WIKI_APP, "revision", "page", "Ref", {
            targetEntity: "page",
            write: "create",
          }),
          fieldPlan(WIKI_APP, "revision", "body", "String", {
            write: "create",
          }),
          fieldPlan(WIKI_APP, "revision", "status", "RevisionStatus", {
            write: "command",
          }),
          fieldPlan(WIKI_APP, "revision", "links-to", "Ref", {
            cardinality: "multi",
            targetEntity: "page",
            write: "create",
          }),
        ]),
      ],
      commands: [],
      queries: [],
      routes: [
        {
          inputParameters: [],
          parameters: [],
          path: "pages",
          queries: [],
          requiredProps: [],
          view: "pages",
        },
        {
          inputParameters: [],
          parameters: [],
          path: "revisions",
          queries: [],
          requiredProps: [],
          view: "revisions",
        },
      ],
      stateMachines: [
        {
          entity: "revision",
          field: "status",
          stateType: "RevisionStatus",
          initial: "draft",
          transitions: {
            draft: ["canonical", "obsolete"],
            canonical: ["obsolete"],
            obsolete: [],
          },
        },
      ],
      publications: [
        {
          name: "canonical",
          owner: { entity: "page", pointer: "canonical-revision" },
          revision: {
            entity: "revision",
            ownerField: "page",
            stateField: "status",
          },
          states: {
            draft: "draft",
            published: "canonical",
            retired: "obsolete",
          },
        },
      ],
    });

    const appSource = readFileSync(appPath, "utf8");
    assert.equal(
      appSource.split("\n")[0],
      `// wake: checked-application ${storePlan.semanticFingerprint}`,
    );
    assert.ok(appSource.includes(
      `const wakeApplicationFingerprint = ${JSON.stringify(storePlan.semanticFingerprint)};`,
    ));
    assert.ok(appSource.includes(
      "JSON.stringify({ ...body, fingerprint: wakeApplicationFingerprint })",
    ));
    for (const token of [
      "/api/wake/query",
      "/api/wake/command",
      "/api/wake/changes",
      "sinceVersion",
    ]) {
      assert.ok(
        appSource.includes(token),
        `app.js is missing Store gateway connector token ${token}`,
      );
    }
    assert.ok(appSource.includes('["canonical-revision"]'));
    assert.ok(appSource.includes('["links-to"]:'));
    assert.ok(appSource.includes("function wakeStoreReadInput(input, meta)"));
    assert.ok(appSource.includes(".split(',')"));
    assert.ok(appSource.includes(".map(piece => piece.trim())"));
    assert.ok(appSource.includes(".filter(piece => piece.length > 0)"));
    assert.ok(appSource.includes(
      "Object.is(raw, -0) || !Number.isFinite(number) || Object.is(number, -0)",
    ));
    assert.match(
      appSource,
      /\["links-to"\]: wakeStoreReadInput\([^,]+, wakeStoreFieldMeta\["revision"\]\["links-to"\]\)/,
    );
    assert.doesNotMatch(
      appSource,
      /\["canonical-revision"\]: wakeStoreReadInput/,
    );
    for (const token of [
      "const wakeStorePublications",
      "async function wakeStorePublish",
      "op: 'publish'",
      "expectedPointer: currentPointer == null ? null : currentPointer",
      "wakeStoreAttachPublicationActions",
      "Publish ${String(revision)}",
    ]) {
      assert.ok(appSource.includes(token), `app.js is missing publication token ${token}`);
    }
    assert.doesNotMatch(appSource, /\b(?:canonical_revision|links_to)\s*:/);

  } finally {
    rmSync(outputDir, { force: true, recursive: true });
  }
}, COMPILER_TEST_TIMEOUT_MS);
