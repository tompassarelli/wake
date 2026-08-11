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
const WIKI_APP = "wake.wiki";
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

function subjectTemplate(app, entity, identityField) {
  return appScope(app, [
    "triple",
    ["keyword", "entity"],
    ["keyword", entity],
    { field: identityField },
  ]);
}

function predicateTerm(app, entity, field) {
  return appScope(app, [
    "triple",
    ["keyword", "field"],
    ["keyword", entity],
    ["keyword", field],
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
    identity: {
      field: identityField,
      type: identityType,
      cardinality: "single",
      valueKind: "literal",
      subjectTemplate: subjectTemplate(app, name, identityField),
    },
    fields,
  };
}

test("the wiki compiles as a FRAM-native Wake application", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "wake-wiki-fram-"));

  try {
    const compiled = spawnSync(
      join(webRoot, "bin", "wake-compile"),
      ["--all", "demo/wiki.wake", outputDir],
      { cwd: webRoot },
    );
    const diagnostics = [
      compiled.stdout,
      compiled.stderr,
    ].filter(Boolean).join("\n");
    assert.equal(compiled.status, 0, diagnostics);

    const framPath = join(outputDir, "app.fram.json");
    const appPath = join(outputDir, "app.js");
    assert.equal(existsSync(framPath), true, "app.fram.json was not emitted");
    assert.equal(existsSync(appPath), true, "app.js was not emitted");
    assert.deepEqual(readdirSync(outputDir).sort(), ["app.fram.json", "app.js"]);

    const framSource = readFileSync(framPath, "utf8");
    assert.ok(framSource.endsWith("\n"));
    assert.ok(!framSource.endsWith("\n\n"));
    assert.deepEqual(JSON.parse(framSource), {
      schemaVersion: 1,
      app: WIKI_APP,
      backend: "fram",
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
    for (const token of [
      "/api/wake/query",
      "/api/wake/command",
      "/api/wake/changes",
      "sinceVersion",
    ]) {
      assert.ok(
        appSource.includes(token),
        `app.js is missing FRAM gateway connector token ${token}`,
      );
    }
    assert.ok(appSource.includes('["canonical-revision"]'));
    assert.ok(appSource.includes('["links-to"]:'));
    assert.ok(appSource.includes("function wakeFramReadInput(input, meta)"));
    assert.ok(appSource.includes(".split(',')"));
    assert.ok(appSource.includes(".map(piece => piece.trim())"));
    assert.ok(appSource.includes(".filter(piece => piece.length > 0)"));
    assert.ok(appSource.includes(
      "Object.is(raw, -0) || !Number.isFinite(number) || Object.is(number, -0)",
    ));
    assert.match(
      appSource,
      /\["links-to"\]: wakeFramReadInput\([^,]+, wakeFramFieldMeta\["revision"\]\["links-to"\]\)/,
    );
    assert.doesNotMatch(
      appSource,
      /\["canonical-revision"\]: wakeFramReadInput/,
    );
    for (const token of [
      "const wakeFramPublications",
      "async function wakeFramPublish",
      "op: 'publish'",
      "expectedPointer: currentPointer == null ? null : currentPointer",
      "wakeFramAttachPublicationActions",
      "Publish ${String(revision)}",
    ]) {
      assert.ok(appSource.includes(token), `app.js is missing publication token ${token}`);
    }
    assert.doesNotMatch(appSource, /\b(?:canonical_revision|links_to)\s*:/);

  } finally {
    rmSync(outputDir, { force: true, recursive: true });
  }
}, COMPILER_TEST_TIMEOUT_MS);
