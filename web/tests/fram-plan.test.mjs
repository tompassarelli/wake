import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const wakeRoot = join(testDir, "..", "..");
const beagleRoot = process.env.BEAGLE_ROOT
  ?? join(homedir(), "code", "beagle", "main");

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

const field = (
  name,
  type,
  {
    identity = false,
    cardinality = "single",
    targetEntity = null,
    write = "set",
  } = {},
) => ({
  name,
  storage_id: `wiki/field/${name}`,
  type,
  identity,
  cardinality,
  value_kind: targetEntity === null ? "literal" : "ref",
  target_entity: targetEntity,
  write_policy: write,
  derived: false,
  deps: [],
  expr: null,
});

const pageSlug = field("slug", "String", { identity: true });
const revisionId = field("revision-id", "String", { identity: true });

const semanticFingerprint = `sha256:${"a".repeat(64)}`;
const pluginClosure = [{
  artifactDigest: `sha256:${"b".repeat(64)}`,
  configurationDigest: `sha256:${"c".repeat(64)}`,
  durableSchemaVersion: 1,
  migrationOrdinal: 0,
  packageId: "wake-wiki-core",
  version: "0.1.0",
}];

const checkedWiki = {
  application_id: "wiki.app",
  semantic_fingerprint: semanticFingerprint,
  plugin_closure: pluginClosure,
  ns: "wiki.app",
  backend: { kind: "fram" },
  entities: [
    {
      name: "page",
      storage_id: "wiki/entity/page",
      identity_field: pageSlug,
      stored_fields: [
        pageSlug,
        field("title", "String"),
        field("canonical-revision", "Ref", {
          targetEntity: "revision",
          write: "command",
        }),
        field("aliases", "String", { cardinality: "multi" }),
        field("visibility", "PageVisibility"),
      ],
    },
    {
      name: "revision",
      storage_id: "wiki/entity/revision",
      identity_field: revisionId,
      stored_fields: [
        revisionId,
        field("page", "Ref", { targetEntity: "page", write: "create" }),
        field("body", "String", { write: "create" }),
        field("links-to", "Ref", {
          cardinality: "multi",
          targetEntity: "page",
          write: "create",
        }),
        field("status", "RevisionStatus", { write: "command" }),
      ],
    },
  ],
  state_machines: [
    {
      entity: "page",
      field: "visibility",
      state_type: "PageVisibility",
      initial: ":draft",
      transitions: {
        ":draft": [":listed", ":hidden"],
        ":listed": [":hidden"],
        ":hidden": [":listed"],
      },
    },
    {
      entity: "revision",
      field: "status",
      state_type: "RevisionStatus",
      initial: ":draft",
      transitions: {
        ":draft": [":canonical"],
        ":canonical": [":obsolete"],
        ":obsolete": [],
      },
    },
  ],
  publications: [
    {
      name: "canonical",
      owner_entity: "page",
      pointer_field: "canonical-revision",
      revision_entity: "revision",
      owner_field: "page",
      state_field: "status",
      draft_state: "draft",
      published_state: "canonical",
      retired_state: "obsolete",
    },
  ],
};

let buildDir;
let genFram;

function assertAppScopedTerm(term, app) {
  assert.equal(term[0], "triple");
  assert.deepEqual(term[1], ["keyword", "wake/app"]);
  assert.deepEqual(term[2], ["keyword", app]);
}

beforeAll(async () => {
  buildDir = mkdtempSync(join(tmpdir(), "wake-fram-plan-"));
  const source = join(wakeRoot, "web", "compiler", "emit-fram.bjs");
  const output = join(buildDir, "emit-fram.mjs");
  const built = spawnSync("beagle", ["build", source, output], {
    env: { ...process.env, BEAGLE_JS_RUNTIME_PREFIX: "./beagle/" },
  });

  assert.equal(built.status, 0, built.stderr || built.stdout);
  mkdirSync(join(buildDir, "beagle"));
  copyFileSync(
    join(beagleRoot, "beagle-lib", "lib", "beagle", "core.js"),
    join(buildDir, "beagle", "core.js"),
  );
  writeFileSync(join(buildDir, "package.json"), '{"type":"module"}\n');
  ({ gen_fram: genFram } = await import(pathToFileURL(output).href));
});

afterAll(() => {
  rmSync(buildDir, { force: true, recursive: true });
});

test("FRAM plan emission is byte-deterministic", () => {
  const first = genFram(checkedWiki);
  const second = genFram(checkedWiki);

  assert.equal(first, second);
  assert.ok(first.endsWith("\n"));
  assert.ok(!first.endsWith("\n\n"));
});

test("FRAM subject and predicate Terms cannot alias across apps", () => {
  const wiki = JSON.parse(genFram(checkedWiki));
  const other = JSON.parse(genFram({
    ...checkedWiki,
    application_id: "other.app",
  }));

  for (let entityIndex = 0; entityIndex < wiki.entities.length; entityIndex += 1) {
    const wikiEntity = wiki.entities[entityIndex];
    const otherEntity = other.entities[entityIndex];
    assertAppScopedTerm(wikiEntity.identity.subjectTemplate, "wiki.app");
    assertAppScopedTerm(otherEntity.identity.subjectTemplate, "other.app");
    assert.notDeepEqual(
      wikiEntity.identity.subjectTemplate,
      otherEntity.identity.subjectTemplate,
    );
    for (let fieldIndex = 0; fieldIndex < wikiEntity.fields.length; fieldIndex += 1) {
      const wikiPredicate = wikiEntity.fields[fieldIndex].predicateTerm;
      const otherPredicate = otherEntity.fields[fieldIndex].predicateTerm;
      assertAppScopedTerm(wikiPredicate, "wiki.app");
      assertAppScopedTerm(otherPredicate, "other.app");
      assert.notDeepEqual(wikiPredicate, otherPredicate);
    }
  }
});

test("FRAM plan preserves wiki identities, fields, and recursive Terms", () => {
  const plan = JSON.parse(genFram(checkedWiki));

  assert.equal(plan.schemaVersion, 2);
  assert.equal(plan.applicationId, "wiki.app");
  assert.equal(plan.backend, "fram");
  assert.equal(plan.semanticFingerprint, semanticFingerprint);
  assert.deepEqual(plan.pluginClosure, pluginClosure);
  assert.deepEqual(Object.keys(plan), [
    "schemaVersion",
    "applicationId",
    "backend",
    "semanticFingerprint",
    "pluginClosure",
    "composition",
    "routes",
    "entities",
    "queries",
    "commands",
    "stateMachines",
    "publications",
  ]);
  assert.deepEqual(
    plan.entities.map((entity) => entity.name),
    ["page", "revision"],
  );
  assert.deepEqual(plan.queries, []);

  const page = plan.entities[0];
  assert.equal(page.storageId, "wiki/entity/page");
  assert.deepEqual(page.identity, {
    field: "slug",
    storageId: "wiki/field/slug",
    type: "String",
    cardinality: "single",
    valueKind: "literal",
    subjectTemplate: [
      "triple",
      ["keyword", "wake/app"],
      ["keyword", "wiki.app"],
      [
        "triple",
        ["keyword", "entity"],
        ["keyword", "wiki/entity/page"],
        { field: "wiki/field/slug" },
      ],
    ],
  });
  assert.deepEqual(
    page.fields.map((entry) => entry.name),
    ["slug", "title", "canonical-revision", "aliases", "visibility"],
  );
  assert.deepEqual(page.fields[1].predicateTerm, [
    "triple",
    ["keyword", "wake/app"],
    ["keyword", "wiki.app"],
    [
      "triple",
      ["keyword", "field"],
      ["keyword", "wiki/entity/page"],
      ["keyword", "wiki/field/title"],
    ],
  ]);
  assert.deepEqual(page.fields[2], {
    name: "canonical-revision",
    storageId: "wiki/field/canonical-revision",
    type: "Ref",
    cardinality: "single",
    valueKind: "ref",
    write: "command",
    predicateTerm: [
      "triple",
      ["keyword", "wake/app"],
      ["keyword", "wiki.app"],
      [
        "triple",
        ["keyword", "field"],
        ["keyword", "wiki/entity/page"],
        ["keyword", "wiki/field/canonical-revision"],
      ],
    ],
    targetEntity: "revision",
  });

  const revision = plan.entities[1];
  assert.equal(revision.storageId, "wiki/entity/revision");
  assert.deepEqual(
    revision.fields.map((entry) => entry.name),
    ["revision-id", "page", "body", "links-to", "status"],
  );
  assert.equal(revision.fields[3].cardinality, "multi");
  assert.equal(revision.fields[3].targetEntity, "page");
  assert.equal(revision.fields[1].write, "create");
  assert.equal(revision.fields[4].write, "command");
});

test("FRAM plan emits deterministic publication policy", () => {
  const { publications } = JSON.parse(genFram(checkedWiki));

  assert.deepEqual(publications, [
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
  ]);
});

test("FRAM plan normalizes state machines in declaration order", () => {
  const { stateMachines } = JSON.parse(genFram(checkedWiki));

  assert.deepEqual(stateMachines, [
    {
      entity: "page",
      field: "visibility",
      stateType: "PageVisibility",
      initial: "draft",
      transitions: {
        draft: ["listed", "hidden"],
        listed: ["hidden"],
        hidden: ["listed"],
      },
    },
    {
      entity: "revision",
      field: "status",
      stateType: "RevisionStatus",
      initial: "draft",
      transitions: {
        draft: ["canonical"],
        canonical: ["obsolete"],
        obsolete: [],
      },
    },
  ]);
  assert.deepEqual(Object.keys(stateMachines[0].transitions), [
    "draft",
    "listed",
    "hidden",
  ]);
});
