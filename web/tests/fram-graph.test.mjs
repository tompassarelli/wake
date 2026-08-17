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
const sourceUnit = {
  source_id: "test:root",
  path: "fram-graph.test.bjs",
  package_id: "",
  package_version: "",
};

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
let checkResolvedDeclarationProgram;

const linkedDeclarations = Object.freeze({
  _tag: "IrLinkedDeclarationProgram",
  application: null,
  plugins: [],
});

function field(name, type, opts = {}) {
  return {
    _tag: "GField",
    name,
    storage_id: "",
    type,
    identity: opts.identity === true,
    cardinality: opts.many === true ? "multi" : "single",
    value_kind: type === "Ref" ? "ref" : "literal",
    target_entity: opts["target-entity"] ?? null,
    write_policy: opts.write ?? "set",
    derived: type === "Derived",
    deps: type === "Derived" ? (opts.deps ?? []) : [],
    expr: type === "Derived" ? (opts.expr ?? null) : null,
  };
}

function resolvedEntity(source) {
  const fields = (source.fields ?? source.attrs ?? []).map(candidate => ({
    ...candidate,
    storage_id: candidate.storage_id || `test/entity/${source.name}/field/${candidate.name}`,
  }));
  const storedFields = fields.filter(candidate => !candidate.derived);
  const derivedFields = fields.filter(candidate => candidate.derived);
  return {
    _tag: "GEntity",
    name: source.name,
    storage_id: source.storage_id ?? `test/entity/${source.name}`,
    fields,
    stored_fields: storedFields,
    derived_fields: derivedFields,
    ref_fields: fields.filter(candidate => candidate.value_kind === "ref"),
    identity_field: storedFields.find(candidate => candidate.identity) ?? null,
    store_name: source.store_name ?? `${source.name}s`,
  };
}

function resolvedProgram({
  backend = { kind: "fram" },
  entities,
  defstates = [],
  publications = [],
  components = [],
  views = [],
  router = null,
  forms = [],
  listDetails = [],
}) {
  return {
    _tag: "ResolvedDeclarationProgram",
    linked_declarations: linkedDeclarations,
    application_id: "type-test",
    source_unit: sourceUnit,
    source_units: [sourceUnit],
    plugin_closure: [],
    declaration_provenance: [],
    ns: "type.test",
    backend,
    entities: entities.map(resolvedEntity),
    persist: null,
    defstates,
    publications,
    queries: [],
    commands: [],
    list_details: listDetails,
    forms,
    theme: null,
    components,
    views,
    router,
    providers: [],
    value_types: [],
    provider_ports: [],
    extends: [],
    fills: [],
    mounts: [],
    route_templates: [],
    layout: null,
  };
}

beforeAll(async () => {
  buildDir = mkdtempSync(join(tmpdir(), "wake-fram-graph-"));
  const output = join(buildDir, "graph.js.tmp");
  const built = spawnSync(
    "beagle",
    ["build", "--module-root", `web=${webRoot}`, join(webRoot, "wake", "graph.bjs"), output],
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
    `${compiled}\nexport { check_resolved_declaration_program };\n`,
  );
  writeFileSync(join(buildDir, "ir.js"), `
export function IrView(
  name,
  entity_name,
  component,
  add_fields,
  title,
  select_component,
  tabs,
  filters,
  date_filters,
) {
  return {
    _tag: "IrView",
    name,
    entity_name,
    component,
    add_fields,
    title,
    select_component,
    tabs,
    filters,
    date_filters,
  };
}
`);
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

  ({ check_resolved_declaration_program: checkResolvedDeclarationProgram } = await import(
    pathToFileURL(join(buildDir, "graph.js")).href
  ));
});

afterAll(() => {
  rmSync(buildDir, { force: true, recursive: true });
});

test("FRAM rejects misspelled stored field types", () => {
  const source = resolvedProgram({
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
    () => checkResolvedDeclarationProgram(source),
    /FRAM-backed field 'page\.title' has unsupported type 'Strng'/,
  );
});

test("generated JavaScript surfaces reject prototype-chain names", () => {
  const entity = () => ({
    name: "page",
    attrs: [field("slug", "String", { identity: true })],
  });
  const cases = [
    resolvedProgram({ entities: [{ ...entity(), name: "__proto__" }] }),
    resolvedProgram({
      entities: [{
        ...entity(),
        attrs: [field("constructor", "String", { identity: true })],
      }],
    }),
    resolvedProgram({
      entities: [entity()],
      components: [{ name: "page-row", props: ["prototype"], body: [] }],
    }),
    resolvedProgram({
      entities: [entity()],
      views: [{ name: "__proto__" }],
    }),
    resolvedProgram({
      entities: [entity()],
      router: {
        default_route: "main",
        routes: [{ path: "constructor", view_name: "main" }],
      },
    }),
    resolvedProgram({
      entities: [entity()],
      publications: [{ name: "prototype" }],
    }),
    resolvedProgram({
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
      () => checkResolvedDeclarationProgram(source),
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
  const pageDetail = {
    entity_name: "page",
    title: "Pages",
    columns: ["slug"],
    search_cols: ["slug"],
    detail_tabs: [],
  };

  assert.throws(
    () => checkResolvedDeclarationProgram(resolvedProgram({
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
    () => checkResolvedDeclarationProgram(resolvedProgram({
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
    () => checkResolvedDeclarationProgram(resolvedProgram({
      entities: [entity],
      forms: [{
        name: "add-page",
        entity_name: "page",
        fields: ["title"],
      }],
      listDetails: [pageDetail],
    })),
    /form 'add-page' must include identity field 'page\.slug'/,
  );
  assert.doesNotThrow(() => checkResolvedDeclarationProgram(resolvedProgram({
    entities: [entity],
    views: [{
      name: "pages",
      entity_name: "page",
      add_fields: ["slug", "title"],
    }],
  })));
  assert.doesNotThrow(() => checkResolvedDeclarationProgram(resolvedProgram({
    entities: [entity],
    forms: [{
      name: "add-page",
      entity_name: "page",
      fields: ["slug", "title"],
    }],
    listDetails: [pageDetail],
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
  const source = resolvedProgram({
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

  const checked = checkResolvedDeclarationProgram(source);
  assert.equal(checked.state_machines.length, 1);
  assert.equal(checked.state_machines[0].state_type, "Lifecycle");
});

test("state machine fields must be single-cardinality", () => {
  const source = resolvedProgram({
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
    () => checkResolvedDeclarationProgram(source),
    /state field 'page\.status' must be single-cardinality/,
  );
});

test("defstate transitions may target only declared states", () => {
  const source = resolvedProgram({
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
    () => checkResolvedDeclarationProgram(source),
    /defstate 'Lifecycle' transition from 'draft' targets undeclared state 'missing'/,
  );
});

test("local applications retain open field type spellings", () => {
  const source = resolvedProgram({
    backend: null,
    entities: [
      {
        name: "local-record",
        attrs: [field("value", "Strng")],
      },
    ],
  });

  assert.doesNotThrow(() => checkResolvedDeclarationProgram(source));
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
  return resolvedProgram({
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
  const checked = checkResolvedDeclarationProgram(publicationProgram());

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
  source.entities[0].fields[1].write_policy = "set";

  assert.throws(
    () => checkResolvedDeclarationProgram(source),
    /publication field 'page\.canonical-revision' must declare :write :command/,
  );
});
