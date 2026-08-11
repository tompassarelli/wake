import assert from "node:assert/strict";
import { after, before, test } from "node:test";
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
import { spawnSync } from "node:child_process";

const testDir = dirname(fileURLToPath(import.meta.url));
const wakeRoot = join(testDir, "..", "..");
const beagleRoot = process.env.BEAGLE_ROOT
  ?? join(homedir(), "code", "beagle", "main");

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

const checkedWiki = {
  ns: "wiki.app",
  backend: { kind: "fram" },
  entities: [
    {
      name: "page",
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

before(async () => {
  buildDir = mkdtempSync(join(tmpdir(), "wake-fram-plan-"));
  const source = join(wakeRoot, "web", "compiler", "emit-fram.bjs");
  const output = join(buildDir, "emit-fram.mjs");
  const built = spawnSync("beagle", ["build", source, output], {
    encoding: "utf8",
    env: { ...process.env, BEAGLE_JS_RUNTIME_PREFIX: "./beagle/" },
  });

  assert.equal(built.status, 0, built.stderr || built.stdout);
  writeFileSync(
    join(buildDir, "graph.js"),
    "export function check_program(value) { return value; }\n",
  );
  mkdirSync(join(buildDir, "beagle"));
  copyFileSync(
    join(beagleRoot, "beagle-lib", "lib", "beagle", "core.js"),
    join(buildDir, "beagle", "core.js"),
  );
  writeFileSync(join(buildDir, "package.json"), '{"type":"module"}\n');
  ({ gen_fram: genFram } = await import(pathToFileURL(output).href));
});

after(() => {
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
  const other = JSON.parse(genFram({ ...checkedWiki, ns: "other.app" }));

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

  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.app, "wiki.app");
  assert.equal(plan.backend, "fram");
  assert.deepEqual(Object.keys(plan), [
    "schemaVersion",
    "app",
    "backend",
    "entities",
    "stateMachines",
    "publications",
  ]);
  assert.deepEqual(
    plan.entities.map((entity) => entity.name),
    ["page", "revision"],
  );

  const page = plan.entities[0];
  assert.deepEqual(page.identity, {
    field: "slug",
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
        ["keyword", "page"],
        { field: "slug" },
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
      ["keyword", "page"],
      ["keyword", "title"],
    ],
  ]);
  assert.deepEqual(page.fields[2], {
    name: "canonical-revision",
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
        ["keyword", "page"],
        ["keyword", "canonical-revision"],
      ],
    ],
    targetEntity: "revision",
  });

  const revision = plan.entities[1];
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
