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

function route(path, viewName) {
  return {
    path,
    view_name: viewName,
    queries: [],
    parameters: [],
    input_parameters: [],
    required_props: [],
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

test("accepts a complete UI and router graph", () => {
  assert.doesNotThrow(() => checkProgram(program()));
  assert.doesNotThrow(() => checkProgram(program({
    router: {
      default_route: "pages",
      routes: [route("pages", "pages"), route("home", "pages")],
    },
  })));
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
