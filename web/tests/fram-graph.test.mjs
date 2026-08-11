import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");
const beagleRoot = process.env.BEAGLE_ROOT ?? join(homedir(), "code", "beagle", "main");
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

let buildDir;
let checkProgram;

function field(name, type, opts = {}) {
  return { name, type, opts };
}

function program({
  backend = { kind: "fram" },
  entities,
  defstates = [],
  publications = [],
  components = [],
  views = [],
  router = null,
  forms = [],
  panels = [],
}) {
  return {
    ns: "type.test",
    backend,
    entities,
    persist: null,
    defstates,
    publications,
    list_details: [],
    forms,
    theme: null,
    components,
    views,
    router,
    layout: null,
    panels,
  };
}

beforeAll(async () => {
  buildDir = mkdtempSync(join(tmpdir(), "wake-fram-graph-"));
  const output = join(buildDir, "graph.js.tmp");
  const built = spawnSync(
    "beagle",
    ["build", join(webRoot, "compiler", "graph.bjs"), output],
    {
      env: { ...process.env, BEAGLE_JS_RUNTIME_PREFIX: "./beagle/" },
    },
  );
  assert.equal(built.status, 0, built.stderr || built.stdout);

  const compiled = readFileSync(output, "utf8").replace(
    "from './wake/ir.js';",
    "from './ir.js';",
  );
  writeFileSync(
    join(buildDir, "graph.js"),
    `${compiled}\nexport { check_program };\n`,
  );
  writeFileSync(join(buildDir, "ir.js"), "export {};\n");
  writeFileSync(join(buildDir, "package.json"), '{"type":"module"}\n');
  mkdirSync(join(buildDir, "beagle"));
  copyFileSync(
    join(beagleRoot, "beagle-lib", "lib", "beagle", "core.js"),
    join(buildDir, "beagle", "core.js"),
  );
  copyFileSync(
    join(beagleRoot, "beagle-lib", "lib", "beagle", "hamt.js"),
    join(buildDir, "beagle", "hamt.js"),
  );

  ({ check_program: checkProgram } = await import(
    pathToFileURL(join(buildDir, "graph.js")).href
  ));
});

afterAll(() => {
  rmSync(buildDir, { force: true, recursive: true });
});

test("FRAM rejects misspelled stored field types", () => {
  const source = program({
    entities: [
      {
        name: "page",
        attrs: [
          field("slug", "String", { identity: true }),
          field("title", "Strng"),
        ],
      },
    ],
  });

  assert.throws(
    () => checkProgram(source),
    /FRAM-backed field 'page\.title' has unsupported type 'Strng'/,
  );
});

test("generated JavaScript surfaces reject prototype-chain names", () => {
  const entity = () => ({
    name: "page",
    attrs: [field("slug", "String", { identity: true })],
  });
  const cases = [
    program({ entities: [{ ...entity(), name: "__proto__" }] }),
    program({
      entities: [{
        ...entity(),
        attrs: [field("constructor", "String", { identity: true })],
      }],
    }),
    program({
      entities: [entity()],
      components: [{ name: "page-row", props: ["prototype"], body: [] }],
    }),
    program({
      entities: [entity()],
      views: [{ name: "__proto__" }],
    }),
    program({
      entities: [entity()],
      router: {
        default_route: "main",
        routes: [{ path: "constructor", view_name: "main" }],
      },
    }),
    program({
      entities: [entity()],
      publications: [{ name: "prototype" }],
    }),
    program({
      entities: [entity()],
      defstates: [{
        name: "constructor",
        transitions: { ":draft": [] },
        initial: ":draft",
      }],
    }),
  ];

  for (const source of cases) {
    assert.throws(
      () => checkProgram(source),
      /is reserved for generated JavaScript/,
    );
  }
});

test("FRAM add forms require identity and exclude command-only fields", () => {
  const entity = {
    name: "page",
    attrs: [
      field("slug", "String", { identity: true }),
      field("title", "String"),
      field("canonical-revision", "Ref", {
        "target-entity": "page",
        write: "command",
      }),
    ],
  };

  assert.throws(
    () => checkProgram(program({
      entities: [entity],
      views: [{
        name: "pages",
        entity_name: "page",
        add_fields: ["title"],
      }],
    })),
    /view 'pages' add form must include identity field 'page\.slug'/,
  );
  assert.throws(
    () => checkProgram(program({
      entities: [entity],
      views: [{
        name: "pages",
        entity_name: "page",
        add_fields: ["slug", "canonical-revision"],
      }],
    })),
    /view 'pages' add form cannot include command-only field 'page\.canonical-revision'/,
  );
  assert.throws(
    () => checkProgram(program({
      entities: [entity],
      forms: [{
        name: "add-page",
        entity_name: "page",
        fields: ["title"],
      }],
    })),
    /form 'add-page' must include identity field 'page\.slug'/,
  );
  assert.doesNotThrow(() => checkProgram(program({
    entities: [entity],
    views: [{
      name: "pages",
      entity_name: "page",
      add_fields: ["slug", "title"],
    }],
    forms: [{
      name: "add-page",
      entity_name: "page",
      fields: ["slug", "title"],
    }],
  })));
});

test("FRAM accepts literal aliases, known references, and defstate types", () => {
  const defstates = [
    {
      name: "Lifecycle",
      transitions: { ":draft": [":canonical"], ":canonical": [] },
      initial: ":draft",
    },
  ];
  const source = program({
    defstates,
    entities: [
      {
        name: "target",
        attrs: [field("id", "String", { identity: true })],
      },
      {
        name: "typed",
        attrs: [
          field("id", "String", { identity: true }),
          field("int", "Int"),
          field("integer", "Integer"),
          field("float", "Float"),
          field("double", "Double"),
          field("number", "Number"),
          field("bool", "Bool"),
          field("boolean", "Boolean"),
          field("keyword", "Keyword"),
          field("instant", "Instant"),
          field("target", "Ref", { "target-entity": "target" }),
          field("status", "Lifecycle"),
        ],
      },
    ],
  });

  const checked = checkProgram(source);
  assert.equal(checked.state_machines.length, 1);
  assert.equal(checked.state_machines[0].state_type, "Lifecycle");
});

test("state machine fields must be single-cardinality", () => {
  const source = program({
    defstates: [{
      name: "Lifecycle",
      transitions: { ":draft": [":canonical"], ":canonical": [] },
      initial: ":draft",
    }],
    entities: [{
      name: "page",
      attrs: [
        field("slug", "String", { identity: true }),
        field("status", "Lifecycle", { many: true }),
      ],
    }],
  });

  assert.throws(
    () => checkProgram(source),
    /state field 'page\.status' must be single-cardinality/,
  );
});

test("defstate transitions may target only declared states", () => {
  const source = program({
    defstates: [{
      name: "Lifecycle",
      transitions: { ":draft": [":missing"], ":canonical": [] },
      initial: ":draft",
    }],
    entities: [{
      name: "page",
      attrs: [
        field("slug", "String", { identity: true }),
        field("status", "Lifecycle"),
      ],
    }],
  });

  assert.throws(
    () => checkProgram(source),
    /defstate 'Lifecycle' transition from 'draft' targets undeclared state 'missing'/,
  );
});

test("reader requires the canonical defstate transition arrow", () => {
  const sourcePath = join(buildDir, "invalid-defstate-arrow.wake");
  const outputPath = join(buildDir, "invalid-defstate-arrow.fram.json");
  writeFileSync(sourcePath, `(ns invalid.state)
(backend :fram)
(defstate Lifecycle
  [:draft => :canonical]
  [:canonical ->])
(entity page
  (slug : String :identity)
  (status : Lifecycle))
`);

  const compiled = spawnSync(
    join(webRoot, "bin", "wake-compile"),
    ["--fram", sourcePath, outputPath],
    { cwd: webRoot },
  );
  const diagnostics = `${compiled.stdout}\n${compiled.stderr}`;
  assert.notEqual(compiled.status, 0, diagnostics);
  assert.match(
    diagnostics,
    /defstate 'Lifecycle' transitions must use -> after the source state/,
  );
}, COMPILER_TEST_TIMEOUT_MS);

test("local applications retain open field type spellings", () => {
  const source = program({
    backend: null,
    entities: [
      {
        name: "local-record",
        attrs: [field("value", "Strng")],
      },
    ],
  });

  assert.doesNotThrow(() => checkProgram(source));
});

function publicationSource(overrides = {}) {
  return {
    name: "canonical",
    owner_entity: "page",
    pointer_field: "canonical-revision",
    revision_entity: "revision",
    owner_field: "page",
    state_field: "status",
    draft_state: ":draft",
    published_state: ":canonical",
    retired_state: ":obsolete",
    ...overrides,
  };
}

function publicationProgram(overrides = {}) {
  const defstates = [{
    name: "RevisionStatus",
    transitions: {
      ":draft": [":canonical", ":obsolete"],
      ":canonical": [":obsolete"],
      ":obsolete": [],
    },
    initial: ":draft",
  }];
  return program({
    defstates,
    entities: [
      {
        name: "page",
        attrs: [
          field("slug", "String", { identity: true }),
          field("canonical-revision", "Ref", {
            "target-entity": "revision",
            write: "command",
          }),
        ],
      },
      {
        name: "revision",
        attrs: [
          field("id", "String", { identity: true }),
          field("page", "Ref", {
            "target-entity": "page",
            write: "create",
          }),
          field("body", "String", { write: "create" }),
          field("status", "RevisionStatus", { write: "command" }),
        ],
      },
    ],
    publications: [publicationSource(overrides)],
  });
}

test("publication policy resolves only with command and create write boundaries", () => {
  const checked = checkProgram(publicationProgram());

  assert.deepEqual(checked.publications, [{
    _tag: "PublicationPolicy",
    name: "canonical",
    owner_entity: "page",
    pointer_field: "canonical-revision",
    revision_entity: "revision",
    owner_field: "page",
    state_field: "status",
    draft_state: "draft",
    published_state: "canonical",
    retired_state: "obsolete",
  }]);
  assert.equal(checked.entities[1].fields[1].write_policy, "create");
  assert.equal(checked.entities[1].fields[2].write_policy, "create");
  assert.equal(checked.entities[1].fields[3].write_policy, "command");
});

test("publication rejects a generic-set pointer", () => {
  const source = publicationProgram();
  source.entities[0].attrs[1].opts.write = "set";

  assert.throws(
    () => checkProgram(source),
    /publication field 'page\.canonical-revision' must declare :write :command/,
  );
});

test("identity fields reject explicit write policies", () => {
  const source = publicationProgram();
  source.entities[0].attrs[0].opts.write = "create";

  assert.throws(
    () => checkProgram(source),
    /identity field 'slug' is immutable and cannot declare :write/,
  );
});
