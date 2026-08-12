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
  source_id: "test:graph-ui-router-guards",
  path: "graph-ui-router-guards.test.bjs",
  package_id: "application",
  package_version: "0.1.0",
};

let buildDir;
let checkProgram;

function spawnSync(command, args, { env = process.env } = {}) {
  const result = Bun.spawnSync([command, ...args], {
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

function entity(name) {
  return {
    name,
    attrs: [{ name: "id", type: "String", opts: { identity: true } }],
  };
}

function attribute(name, type = "String", opts = {}) {
  return { name, type, opts };
}

function listDetail(overrides = {}) {
  return {
    entity_name: "page",
    title: "Pages",
    columns: ["id"],
    search_cols: ["id"],
    detail_tabs: [{
      label: "Overview",
      content_type: "fields",
      fields: ["id"],
      entity_name: null,
      relation_field: null,
      infer_relation: false,
      display_fields: [],
    }],
    ...overrides,
  };
}

function component(name) {
  return { name, props: ["id"], body: [] };
}

function view(name, entityName, componentName, selectComponent = null) {
  return {
    name,
    entity_name: entityName,
    component: componentName,
    add_fields: [],
    title: name,
    select_component: selectComponent,
    tabs: [],
    filters: [],
    date_filters: [],
  };
}

function route(path, viewName, {
  inputParameters = [],
  parameters = [],
  queries = [],
} = {}) {
  return {
    path,
    view_name: viewName,
    queries,
    parameters,
    input_parameters: inputParameters,
    required_props: [],
  };
}

function query(name, parameters = []) {
  const predicates = parameters.map(parameter => ({
    op: "eq",
    left: {
      kind: "field",
      name: null,
      binding: "item",
      field: "id",
      value: null,
    },
    right: {
      kind: "parameter",
      name: parameter,
      binding: null,
      field: null,
      value: null,
    },
  }));
  return {
    name,
    capabilities: ["test/read-page"],
    params: parameters.map(parameter => ({ name: parameter, type: "String" })),
    bindings: [{ name: "item", entity_name: "page" }],
    predicates,
    selection: [{
      _tag: "IrQuerySelect",
      name: "id",
      binding: "item",
      field: "id",
    }],
    result_kind: parameters.length === 0 ? "page" : "optional",
    page: parameters.length === 0
      ? { default_limit: 20, max_limit: 64 }
      : null,
  };
}

function program(overrides = {}) {
  return {
    source_unit: sourceUnit,
    source_units: [sourceUnit],
    plugin_closure: [],
    application: { id: "graph-ui-router-guards" },
    uses: [],
    providers: [],
    value_types: [],
    provider_ports: [],
    extends: [],
    fills: [],
    mounts: [],
    declaration_provenance: [],
    ns: "wake.tests.graph-ui-router-guards",
    backend: { kind: "fram" },
    entities: [entity("page")],
    persist: null,
    defstates: [],
    publications: [],
    queries: [],
    commands: [],
    list_details: [],
    forms: [],
    theme: null,
    components: [component("page-row")],
    views: [view("pages", "page", "page-row")],
    router: {
      default_route: "pages",
      routes: [route("pages", "pages")],
    },
    layout: null,
    ...overrides,
  };
}

beforeAll(async () => {
  buildDir = mkdtempSync(join(tmpdir(), "wake-graph-ui-router-guards-"));
  const output = join(buildDir, "graph.js.tmp");
  const built = spawnSync(
    "beagle",
    ["build", join(webRoot, "compiler", "graph.bjs"), output],
    { env: { ...process.env, BEAGLE_JS_RUNTIME_PREFIX: "./beagle/" } },
  );
  assert.equal(built.status, 0, built.stderr || built.stdout);

  const compiled = readFileSync(output, "utf8").replace(
    "from './wake/ir.js';",
    "from './ir.js';",
  );
  writeFileSync(join(buildDir, "graph.js"), `${compiled}\nexport { check_program };\n`);
  writeFileSync(join(buildDir, "ir.js"), `
export function IrRoute(
  path,
  view_name,
  queries,
  parameters,
  input_parameters,
  required_props,
) {
  return {
    _tag: "IrRoute",
    path,
    view_name,
    queries,
    parameters,
    input_parameters,
    required_props,
  };
}
export function IrRouter(default_route, routes) {
  return { _tag: "IrRouter", default_route, routes };
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

  ({ check_program: checkProgram } = await import(
    pathToFileURL(join(buildDir, "graph.js")).href
  ));
});

afterAll(() => {
  rmSync(buildDir, { force: true, recursive: true });
});

test("accepts a complete UI and router graph", () => {
  assert.doesNotThrow(() => checkProgram(program()));
  assert.doesNotThrow(() => checkProgram(program({
    router: {
      default_route: "pages",
      routes: [route("pages", "pages"), route("home", "pages")],
    },
  })));
});

test("treats the routes default as a view name rather than a route path", () => {
  assert.doesNotThrow(() => checkProgram(program({
    router: {
      default_route: "pages",
      routes: [route("browse-pages", "pages")],
    },
  })));
  assert.throws(
    () => checkProgram(program({
      router: {
        default_route: "browse-pages",
        routes: [route("browse-pages", "pages")],
      },
    })),
    /routes default 'browse-pages' does not name a routed view/,
  );
});

test("checks root route queries before code generation", () => {
  const pageById = query("page-by-id", ["id"]);
  const mounted = checkProgram(program({
    queries: [pageById],
    router: {
      default_route: "pages",
      routes: [route("/pages/:page-id", "pages", {
        inputParameters: ["id"],
        parameters: ["page-id"],
        queries: [{ name: "page-by-id", prefix: null }],
      })],
    },
  }));
  assert.deepEqual(mounted.router.routes[0].input_parameters, ["id"]);
  assert.deepEqual(mounted.router.routes[0].parameters, ["page-id"]);
  assert.deepEqual(mounted.router.routes[0].required_props, ["id"]);

  assert.throws(
    () => checkProgram(program({
      router: {
        default_route: "pages",
        routes: [route("browse-pages", "pages", {
          queries: [{ name: "missing-query", prefix: null }],
        })],
      },
    })),
    /route 'browse-pages' names unknown query 'missing-query'/,
  );
  assert.throws(
    () => checkProgram(program({
      queries: [pageById],
      router: {
        default_route: "pages",
        routes: [route("browse-pages", "pages", {
          inputParameters: ["page-id"],
          parameters: ["page-id"],
          queries: [{ name: "page-by-id", prefix: null }],
        })],
      },
    })),
    /route 'browse-pages' input parameters must exactly match query 'page-by-id' parameters/,
  );
});

test("requires root route query projections to cover component props", () => {
  assert.throws(
    () => checkProgram(program({
      components: [{ name: "page-row", props: ["id", "title"], body: [] }],
      queries: [query("pages-query")],
      router: {
        default_route: "pages",
        routes: [route("browse-pages", "pages", {
          queries: [{ name: "pages-query", prefix: null }],
        })],
      },
    })),
    /route 'browse-pages' queries do not provide component props: title/,
  );
});

test("rejects duplicate entity, component, and view declarations", () => {
  const cases = [
    [program({ entities: [entity("page"), entity("page")] }), /entity 'page' is duplicated/],
    [
      program({ components: [component("page-row"), component("page-row")] }),
      /component 'page-row' is duplicated/,
    ],
    [
      program({ views: [view("pages", "page", "page-row"), view("pages", "page", "page-row")] }),
      /view 'pages' is duplicated/,
    ],
  ];

  for (const [source, expected] of cases) {
    assert.throws(() => checkProgram(source), expected);
  }
});

test("rejects missing view entity and component references", () => {
  const cases = [
    [
      program({ views: [view("pages", "missing", "page-row")] }),
      /view 'pages' names unknown entity 'missing'/,
    ],
    [
      program({ views: [view("pages", "page", "missing")] }),
      /view 'pages' names unknown component 'missing'/,
    ],
    [
      program({ views: [view("pages", "page", "page-row", "missing")] }),
      /view 'pages' names unknown select component 'missing'/,
    ],
  ];

  for (const [source, expected] of cases) {
    assert.throws(() => checkProgram(source), expected);
  }
});

test("rejects duplicate and unresolved routes", () => {
  assert.throws(
    () => checkProgram(program({
      router: {
        default_route: "pages",
        routes: [route("pages", "pages"), route("pages", "pages")],
      },
    })),
    /route path 'pages' is duplicated/,
  );
  assert.throws(
    () => checkProgram(program({
      router: {
        default_route: "pages",
        routes: [route("missing", "missing")],
      },
    })),
    /route 'missing' names unknown view 'missing'/,
  );
  assert.throws(
    () => checkProgram(program({
      router: {
        default_route: "missing",
        routes: [route("pages", "pages")],
      },
    })),
    /routes default 'missing' does not name a routed view/,
  );
});

test("resolves list-detail fields and explicit related relations", () => {
  const checked = checkProgram(program({
    entities: [
      entity("page"),
      {
        name: "note",
        attrs: [
          attribute("id", "String", { identity: true }),
          attribute("page", "Ref", { "target-entity": "page" }),
          attribute("summary"),
        ],
      },
    ],
    list_details: [listDetail({
      detail_tabs: [
        listDetail().detail_tabs[0],
        {
          label: "Notes",
          content_type: "related",
          fields: [],
          entity_name: "note",
          relation_field: "page",
          infer_relation: false,
          display_fields: ["id", "summary"],
        },
      ],
    })],
  }));
  assert.deepEqual(checked.list_details[0].detail_tabs[1], {
    _tag: "GDetailTab",
    label: "Notes",
    content_type: "related",
    fields: [],
    entity_name: "note",
    relation_field: "page",
    display_fields: ["id", "summary"],
  });
});

test("rejects invalid list-detail fields, searches, and relations", () => {
  const derivedExpr = {
    _tag: "IrDerivedExpr",
    kind: "field",
    field: "id",
    value: null,
    parts: [],
  };
  const pageWithEdges = {
    name: "page",
    attrs: [
      attribute("id", "String", { identity: true }),
      attribute("tags", "String", { many: true }),
      attribute("owner", "Ref", { "target-entity": "user" }),
      attribute("label", "Derived", { deps: ["id"], expr: derivedExpr }),
    ],
  };
  const note = {
    name: "note",
    attrs: [
      attribute("id", "String", { identity: true }),
      attribute("wrong", "Ref", { "target-entity": "user" }),
      attribute("page-a", "Ref", { "target-entity": "page" }),
      attribute("page-b", "Ref", { "target-entity": "page" }),
    ],
  };
  const base = { entities: [pageWithEdges, entity("user"), note] };
  for (const [detail, expected] of [
    [listDetail({ columns: ["label"] }), /column cannot name derived field/],
    [listDetail({ search_cols: ["tags"] }), /must be a single stored literal/],
    [listDetail({ search_cols: ["owner"] }), /must be a single stored literal/],
    [listDetail({ detail_tabs: [{
      label: "Notes", content_type: "related", fields: [], entity_name: "note",
      relation_field: "wrong", infer_relation: false, display_fields: ["id"],
    }] }), /relation must name a single Ref field/],
    [listDetail({ detail_tabs: [{
      label: "Notes", content_type: "related", fields: [], entity_name: "note",
      relation_field: null, infer_relation: true, display_fields: ["id"],
    }] }), /cannot infer one relation/],
  ]) {
    assert.throws(() => checkProgram(program({ ...base, list_details: [detail] })), expected);
  }
});

test("recomputes closed derived expressions and rejects forged dependencies", () => {
  const expression = (field, overrides = {}) => ({
    _tag: "IrDerivedExpr",
    kind: "field",
    field,
    value: null,
    parts: [],
    ...overrides,
  });
  const derived = (name, dependency, expr = expression(dependency)) =>
    attribute(name, "Derived", { deps: [dependency], expr });
  const fields = [
    attribute("id", "String", { identity: true }),
    attribute("title"),
    derived("label", "title"),
  ];

  assert.doesNotThrow(() => checkProgram(program({
    entities: [{ name: "page", attrs: fields }],
  })));

  for (const [attrs, expected] of [
    [
      [...fields.slice(0, 2), derived("label", "ghost")],
      /references unknown field 'ghost'/,
    ],
    [
      [...fields, derived("slug", "label")],
      /cannot reference derived field 'label'/,
    ],
    [
      [...fields.slice(0, 2), attribute("label", "Derived", {
        deps: [],
        expr: expression("title"),
      })],
      /dependencies do not exactly match its expression/,
    ],
    [
      [...fields.slice(0, 2), derived("label", "title", {
        ...expression("title"),
        untrusted: true,
      })],
      /derived expression has unsupported fields/,
    ],
    [
      [...fields.slice(0, 2), derived("label", "title", expression("title", {
        kind: "evaluate-javascript",
      }))],
      /unknown derived expression kind 'evaluate-javascript'/,
    ],
    [
      [...fields.slice(0, 2), derived("label", "title", expression(null))],
      /invalid field derived expression/,
    ],
  ]) {
    assert.throws(
      () => checkProgram(program({ entities: [{ name: "page", attrs }] })),
      expected,
    );
  }
});

test("derived fields only read single stored String fields", () => {
  for (const [source, expected] of [
    [attribute("count", "Int"), /dependency 'count'.*single stored String/],
    [attribute("enabled", "Bool"), /dependency 'enabled'.*single stored String/],
    [attribute("tags", "String", { many: true }), /dependency 'tags'.*single stored String/],
    [
      attribute("owner", "Ref", { "target-entity": "user" }),
      /dependency 'owner'.*single stored String/,
    ],
  ]) {
    const attrs = [
      attribute("id", "String", { identity: true }),
      source,
      attribute("label", "Derived", {
        deps: [source.name],
        expr: {
          _tag: "IrDerivedExpr",
          kind: "field",
          field: source.name,
          value: null,
          parts: [],
        },
      }),
    ];
    assert.throws(
      () => checkProgram(program({
        entities: [{ name: "page", attrs }, entity("user")],
      })),
      expected,
    );
  }
});

test("rejects list-detail tab codegen collisions", () => {
  const related = (label, entityName, relationField) => ({
    label,
    content_type: "related",
    fields: [],
    entity_name: entityName,
    relation_field: relationField,
    infer_relation: false,
    display_fields: ["id"],
  });
  const note = {
    name: "note",
    attrs: [
      attribute("id", "String", { identity: true }),
      attribute("page", "Ref", { "target-entity": "page" }),
      attribute("alternate-page", "Ref", { "target-entity": "page" }),
    ],
  };
  const event = {
    name: "event",
    attrs: [
      attribute("id", "String", { identity: true }),
      attribute("page", "Ref", { "target-entity": "page" }),
    ],
  };

  assert.throws(
    () => checkProgram(program({
      entities: [entity("page"), note],
      list_details: [listDetail({
        detail_tabs: [
          related("Notes", "note", "page"),
          related("History", "note", "alternate-page"),
        ],
      })],
    })),
    /repeats related entity 'note'/,
  );
  assert.throws(
    () => checkProgram(program({
      entities: [entity("page"), note, event],
      list_details: [listDetail({
        detail_tabs: [related("Notes", "note", "page"), related("notes", "event", "page")],
      })],
    })),
    /tab labels collide case-insensitively at 'notes'/,
  );
  assert.throws(
    () => checkProgram(program({
      entities: [entity("page"), note],
      list_details: [listDetail({
        detail_tabs: [related("OVERVIEW", "note", "page")],
      })],
    })),
    /related tab label 'OVERVIEW' conflicts with the built-in overview tab/,
  );
});
