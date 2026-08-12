import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const webRoot = `${import.meta.dir}/..`;
const core = join(webRoot, "wake", "core.bjs");
const fixture = join(webRoot, "tests", "fixtures", "query-api", "results.bjs");
const wrongResultFixture = join(
  webRoot,
  "tests",
  "fixtures",
  "query-api",
  "wrong-result-type.bjs",
);
const beagleRoot = process.env.BEAGLE_PROJECTION_ROOT
  ?? process.env.BEAGLE_ROOT
  ?? join(homedir(), "code", "beagle", "main");
const beagle = join(beagleRoot, "bin", "beagle");

function runBeagle(args) {
  const result = Bun.spawnSync([beagle, ...args], {
    cwd: webRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString();
}

function failedBeagle(args) {
  const result = Bun.spawnSync([beagle, ...args], {
    cwd: webRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).not.toBe(0);
  return `${result.stdout}${result.stderr}`;
}

function checkedAst(path) {
  return JSON.parse(runBeagle(["ast", path]));
}

function exportedForm(ast, name) {
  const wrapper = ast.forms.find((candidate) =>
    candidate.node === "js-export" && candidate.form?.name === name);
  expect(wrapper, `missing exported ${name}`).toBeDefined();
  return wrapper.form;
}

function recordForm(ast, name) {
  const record = ast.forms.find((candidate) =>
    candidate.node === "record" && candidate.name === name);
  expect(record, `missing record ${name}`).toBeDefined();
  return record;
}

function type(name) {
  return { kind: "prim", name };
}

test("wake.core exposes the closed named-query data model", () => {
  runBeagle(["check", "--agent", core, fixture]);

  for (const path of [core, fixture]) {
    const source = readFileSync(path, "utf8");
    expect(source).not.toMatch(/\bAny\b/u);
    expect(source).not.toMatch(/\braw\b/u);
  }

  const ast = checkedAst(core);
  expect(ast.namespace).toBe("wake.core");

  expect(exportedForm(ast, "Derived")).toEqual({
    node: "defunion",
    name: "Derived",
    "type-params": ["T"],
    members: ["WakeDerived"],
    "member-fields": {
      WakeDerived: [{ name: "value", ann: { kind: "var", name: "T" } }],
    },
  });
  expect(exportedForm(ast, "UntargetedRef").fields).toEqual([
    { name: "id", ann: type("String") },
  ]);
  expect(exportedForm(ast, "Opaque").fields).toEqual([
    { name: "value", ann: type("String") },
  ]);
  expect(exportedForm(ast, "QueryPage").fields).toEqual([
    { name: "default-limit", ann: type("Int") },
    { name: "max-limit", ann: type("Int") },
  ]);

  const result = exportedForm(ast, "QueryResult");
  expect(result.members).toEqual(["PageResult", "OptionalResult", "OneResult"]);
  expect(result["member-fields"].PageResult).toEqual([
    { name: "page", ann: type("QueryPage") },
  ]);
  for (const member of ["OptionalResult", "OneResult"]) {
    expect(result["member-fields"][member]).toEqual([{
      name: "unit",
      ann: type("Nil"),
    }]);
  }

  const query = exportedForm(ast, "QuerySpec");
  expect(query.fields.map((field) => field.name)).toEqual([
    "name",
    "params-record",
    "bindings-record",
    "capabilities",
    "predicates",
    "selection",
    "result",
  ]);
  expect(query.fields.at(-1).ann).toEqual(type("QueryResult"));

  const signatures = new Map([
    ["page-result", [type("Int"), type("Int")]],
    ["optional-result", []],
    ["one-result", []],
  ]);
  for (const [name, params] of signatures) {
    const helper = exportedForm(ast, name);
    expect(helper.node).toBe("defn");
    expect(helper.params.map((param) => param.ann)).toEqual(params);
    expect(helper.ret).toEqual(type("QueryResult"));
  }
});

test("consumer projection keeps exact query results and diagnostic markers", () => {
  const firstProjection = runBeagle(["ast", fixture]);
  expect(runBeagle(["ast", fixture])).toBe(firstProjection);
  const ast = JSON.parse(firstProjection);

  expect(ast.requires).toContainEqual({
    alias: "wake",
    ns: "wake.core",
    refer: false,
  });
  expect(recordForm(ast, "Release").fields.at(-1)).toEqual({
    name: "label",
    ann: {
      kind: "app",
      name: "wake/Derived",
      args: [type("String")],
    },
  });
  expect(recordForm(ast, "untargeted-ref-marker-params").fields).toEqual([
    { name: "owner", ann: type("wake/UntargetedRef") },
  ]);
  expect(recordForm(ast, "opaque-marker-params").fields).toEqual([
    { name: "opaque", ann: type("wake/Opaque") },
  ]);

  const expectedResults = new Map([
    ["release-page", { fn: "wake/page-result", values: [20, 64] }],
    ["release-optional", { fn: "wake/optional-result", values: [] }],
    ["release-one", { fn: "wake/one-result", values: [] }],
    ["untargeted-ref-marker", { fn: "wake/page-result", values: [10, 20] }],
    ["opaque-marker", { fn: "wake/page-result", values: [10, 20] }],
  ]);
  const queries = ast.forms.filter((form) =>
    form.node === "def" && form.ann?.name === "wake/QuerySpec");
  expect(queries.map((query) => query.name)).toEqual([...expectedResults.keys()]);

  for (const query of queries) {
    expect(query.value.fn.name).toBe("wake/->QuerySpec");
    expect(query.value.inferredType).toEqual(type("QuerySpec"));
    expect(query.value.args).toHaveLength(7);
    expect(query.provenance.macroExpansion.chain).toEqual([
      { depth: 0, name: "wake/defquery" },
    ]);

    const capability = query.value.args[3];
    expect(capability.node).toBe("vec");
    expect(capability.inferredType).toEqual({
      kind: "app",
      name: "Vec",
      args: [type("String")],
    });

    const expected = expectedResults.get(query.name);
    const result = query.value.args[6];
    expect(result.fn.name).toBe(expected.fn);
    expect(result.inferredType).toEqual(type("QueryResult"));
    expect(result.args.map((arg) => arg.value)).toEqual(expected.values);
  }

  expect(firstProjection).not.toContain('"node":"raw"');
  expect(createHash("sha256").update(firstProjection).digest("hex")).toBe(
    "e346217509e5488d2cc427c087a2af076bb7328330182dbc89b83667d47ed055",
  );
});

test("defquery rejects the retired keyword-and-limit result surface", () => {
  const output = failedBeagle(["check", "--agent", wrongResultFixture]);
  expect(output).toContain("expected QueryResult, got Keyword");
});
