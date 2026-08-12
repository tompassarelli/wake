import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { programFromCheckedAst } from "../compiler/checked-beagle.mjs";
import { canonicalJson, sha256Digest } from "../compiler/canonical.mjs";

const webRoot = `${import.meta.dir}/..`;
const wakeCompile = join(webRoot, "bin", "wake-compile");
const core = join(webRoot, "wake", "core.bjs");
const fixture = join(webRoot, "tests", "fixtures", "query-api", "results.bjs");
const derivedStringFixture = join(
  webRoot,
  "tests",
  "fixtures",
  "query-api",
  "derived-string.bjs",
);
const wrongResultFixture = join(
  webRoot,
  "tests",
  "fixtures",
  "query-api",
  "wrong-result-type.bjs",
);
const wrongDerivedFixture = join(
  webRoot,
  "tests",
  "fixtures",
  "query-api",
  "wrong-derived-expression.bjs",
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

function reseal(ast) {
  const projection = { ...ast };
  delete projection.projectionSha256;
  ast.projectionSha256 = sha256Digest(canonicalJson(projection));
}

function decodeFixture(ast) {
  return programFromCheckedAst(ast, {
    compilerVersion: "0.1.0",
    expectedSourceId: ast.sourceId,
    sourcePath: fixture,
    sourceText: readFileSync(fixture, "utf8"),
  });
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

function definition(ast, name) {
  const value = ast.forms.find((candidate) =>
    candidate.node === "def" && candidate.name === name);
  expect(value, `missing definition ${name}`).toBeDefined();
  return value;
}

function type(name) {
  return { kind: "prim", name };
}

function appType(name, ...args) {
  return { kind: "app", name, args };
}

function values(vector) {
  expect(vector.node).toBe("vec");
  return vector.items.map((item) => item.value);
}

test("wake.core exposes closed query, derived, and list-detail descriptors", () => {
  runBeagle(["check", "--agent", core, fixture, derivedStringFixture]);

  for (const path of [core, fixture, derivedStringFixture]) {
    const source = readFileSync(path, "utf8");
    expect(source).not.toMatch(/\bAny\b/u);
    expect(source).not.toMatch(/\braw\b/u);
  }

  const ast = checkedAst(core);
  expect(ast.namespace).toBe("wake.core");

  const removedExports = [
    "Derived",
    "UntargetedRef",
    "Opaque",
    "RelatedQuery",
    "RelatedQueryTerm",
  ];
  expect(ast.forms.some((candidate) =>
    candidate.node === "js-export"
      && removedExports.includes(candidate.form?.name))).toBeFalse();
  expect(ast.forms.some((candidate) =>
    candidate.node === "js-export"
      && candidate.form?.name?.startsWith("related-query"))).toBeFalse();

  expect(exportedForm(ast, "DerivedExpr")).toEqual({
    node: "defunion",
    name: "DerivedExpr",
    "type-params": [],
    members: ["FieldExpr", "StringExpr", "ConcatExpr"],
    "member-fields": {
      FieldExpr: [{ name: "name", ann: type("Keyword") }],
      StringExpr: [{ name: "value", ann: type("String") }],
      ConcatExpr: [{
        name: "parts",
        ann: appType("Vec", type("DerivedExpr")),
      }],
    },
  });
  expect(exportedForm(ast, "DerivedFieldSpec").fields).toEqual([
    { name: "name", ann: type("Keyword") },
    { name: "expression", ann: type("DerivedExpr") },
  ]);

  const entity = exportedForm(ast, "EntitySpec");
  expect(entity.fields.map((field) => field.name)).toEqual([
    "name",
    "record-name",
    "identity",
    "writes",
    "storage-id",
    "derived-fields",
  ]);
  expect(entity.fields.at(-1).ann).toEqual(
    appType("Vec", type("DerivedFieldSpec")),
  );

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

  expect(exportedForm(ast, "RelatedRelation")).toEqual({
    node: "defunion",
    name: "RelatedRelation",
    "type-params": [],
    members: ["InferRelated", "RelatedBy"],
    "member-fields": {
      InferRelated: [{ name: "unit", ann: type("Nil") }],
      RelatedBy: [{ name: "field", ann: type("Keyword") }],
    },
  });
  const content = exportedForm(ast, "DetailContent");
  expect(content.members).toEqual(["DetailFields", "DetailRelated"]);
  expect(content["member-fields"].DetailRelated).toEqual([
    { name: "entity", ann: type("Keyword") },
    { name: "relation", ann: type("RelatedRelation") },
    { name: "display", ann: appType("Vec", type("Keyword")) },
  ]);
  expect(exportedForm(ast, "ListDetailSpec").fields).toEqual([
    { name: "entity", ann: type("Keyword") },
    { name: "title", ann: type("String") },
    { name: "columns", ann: appType("Vec", type("Keyword")) },
    { name: "search", ann: appType("Vec", type("Keyword")) },
    { name: "detail-tabs", ann: appType("Vec", type("DetailTab")) },
  ]);

  const signatures = new Map([
    ["derived-ref", [[type("Keyword")], type("DerivedExpr")]],
    ["derived-string", [[type("String")], type("DerivedExpr")]],
    ["concat-derived", [[appType("Vec", type("DerivedExpr"))], type("DerivedExpr")]],
    ["derived-field", [[type("Keyword"), type("DerivedExpr")], type("DerivedFieldSpec")]],
    ["page-result", [[type("Int"), type("Int")], type("QueryResult")]],
    ["optional-result", [[], type("QueryResult")]],
    ["one-result", [[], type("QueryResult")]],
    ["detail-fields", [[appType("Vec", type("Keyword"))], type("DetailContent")]],
    ["infer-related", [[], type("RelatedRelation")]],
    ["related-by", [[type("Keyword")], type("RelatedRelation")]],
    ["detail-related", [[
      type("Keyword"),
      type("RelatedRelation"),
      appType("Vec", type("Keyword")),
    ], type("DetailContent")]],
    ["detail-tab", [[type("String"), type("DetailContent")], type("DetailTab")]],
  ]);
  for (const [name, [params, returnType]] of signatures) {
    const helper = exportedForm(ast, name);
    expect(helper.node).toBe("defn");
    expect(helper.params.map((param) => param.ann)).toEqual(params);
    expect(helper.ret).toEqual(returnType);
  }
}, 30_000);

test("consumer projection keeps exact derived, query, and list-detail values", () => {
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
    ann: type("String"),
  });
  expect(recordForm(ast, "ReleaseNote").fields[1]).toEqual({
    name: "release",
    ann: appType("wake/Ref", type("Release")),
  });

  const release = definition(ast, "release");
  expect(release.ann).toEqual(type("wake/EntitySpec"));
  expect(release.value.fn.name).toBe("wake/->EntitySpec");
  expect(release.value.inferredType).toEqual(type("EntitySpec"));
  expect(release.value.args).toHaveLength(6);
  expect(release.value.args.slice(0, 3).map((arg) => arg.value)).toEqual([
    "release",
    "Release",
    "id",
  ]);
  expect(release.value.args[3].pairs.map((pair) => pair.key.value)).toEqual([
    "title",
    "aliases",
  ]);
  const derivedFields = release.value.args[5];
  expect(derivedFields.inferredType).toEqual(
    appType("Vec", type("DerivedFieldSpec")),
  );
  expect(derivedFields.items).toHaveLength(1);
  const derivedField = derivedFields.items[0];
  expect(derivedField.fn.name).toBe("wake/derived-field");
  expect(derivedField.inferredType).toEqual(type("DerivedFieldSpec"));
  expect(derivedField.provenance.macroExpansion.chain).toEqual([
    { depth: 0, name: "wake/defentity" },
  ]);
  expect(derivedField.args[0].value).toBe("label");
  const expression = derivedField.args[1];
  expect(expression.fn.name).toBe("wake/concat-derived");
  expect(expression.inferredType).toEqual(type("DerivedExpr"));
  expect(expression.provenance.macroExpansion.chain).toEqual([
    { depth: 0, name: "wake/defentity" },
  ]);
  expect(expression.args[0].inferredType).toEqual(
    appType("Vec", type("DerivedExpr")),
  );
  expect(expression.args[0].items).toHaveLength(1);
  expect(expression.args[0].items[0].fn.name).toBe("wake/derived-ref");
  expect(expression.args[0].items[0].args[0].value).toBe("title");
  expect(expression.args[0].items[0].provenance.macroExpansion.chain).toEqual([
    { depth: 0, name: "wake/defentity" },
  ]);

  const expectedResults = new Map([
    ["release-page", { fn: "wake/page-result", values: [20, 64] }],
    ["release-optional", { fn: "wake/optional-result", values: [] }],
    ["release-one", { fn: "wake/one-result", values: [] }],
  ]);
  const queries = ast.forms.filter((form) =>
    form.node === "def" && form.ann?.name === "wake/QuerySpec");
  expect(queries.map((queryValue) => queryValue.name)).toEqual([
    ...expectedResults.keys(),
  ]);
  for (const queryValue of queries) {
    expect(queryValue.value.fn.name).toBe("wake/->QuerySpec");
    expect(queryValue.value.inferredType).toEqual(type("QuerySpec"));
    expect(queryValue.value.args).toHaveLength(7);
    expect(queryValue.provenance.macroExpansion.chain).toEqual([
      { depth: 0, name: "wake/defquery" },
    ]);
    const capability = queryValue.value.args[3];
    expect(capability.node).toBe("vec");
    expect(capability.inferredType).toEqual(appType("Vec", type("String")));
    const expected = expectedResults.get(queryValue.name);
    const queryResult = queryValue.value.args[6];
    expect(queryResult.fn.name).toBe(expected.fn);
    expect(queryResult.inferredType).toEqual(type("QueryResult"));
    expect(queryResult.args.map((arg) => arg.value)).toEqual(expected.values);
  }

  const listDetail = definition(ast, "release-list");
  expect(listDetail.ann).toEqual(type("wake/ListDetailSpec"));
  expect(listDetail.value.fn.name).toBe("wake/->ListDetailSpec");
  expect(listDetail.value.inferredType).toEqual(type("ListDetailSpec"));
  expect(listDetail.value.args).toHaveLength(5);
  expect(listDetail.provenance.macroExpansion.chain).toEqual([
    { depth: 0, name: "wake/list-detail" },
  ]);
  expect(listDetail.value.args.slice(0, 2).map((arg) => arg.value)).toEqual([
    "release",
    "Releases",
  ]);
  expect(values(listDetail.value.args[2])).toEqual(["id", "title"]);
  expect(values(listDetail.value.args[3])).toEqual(["title"]);
  const tabs = listDetail.value.args[4].items;
  expect(tabs).toHaveLength(2);
  expect(tabs.map((tab) => tab.fn.name)).toEqual([
    "wake/detail-tab",
    "wake/detail-tab",
  ]);
  expect(tabs.map((tab) => tab.args[0].value)).toEqual(["Overview", "Notes"]);
  expect(tabs[0].args[1].fn.name).toBe("wake/detail-fields");
  expect(values(tabs[0].args[1].args[0])).toEqual(["id", "title", "label"]);
  const related = tabs[1].args[1];
  expect(related.fn.name).toBe("wake/detail-related");
  expect(related.inferredType).toEqual(type("DetailContent"));
  expect(related.args[0].value).toBe("release-note");
  expect(related.args[1].fn.name).toBe("wake/related-by");
  expect(related.args[1].inferredType).toEqual(type("RelatedRelation"));
  expect(related.args[1].provenance.macroExpansion.chain).toEqual([
    { depth: 0, name: "wake/list-detail" },
  ]);
  expect(related.args[1].args[0].value).toBe("release");
  expect(values(related.args[2])).toEqual(["id", "summary"]);

  expect(firstProjection).not.toContain('"node":"raw"');
  expect(createHash("sha256").update(firstProjection).digest("hex")).toBe(
    "dca39fff45478bb056a27066829894472c2ad69138fdd0f664910fe05de492da",
  );
}, 30_000);

test("checked decoder lowers derived fields and list details to closed IR", () => {
  const ast = checkedAst(fixture);
  const program = decodeFixture(ast);
  expect(program.entities[0].attrs.at(-1)).toMatchObject({
    name: "label",
    type: "Derived",
    opts: {
      deps: ["title"],
      expr: {
        _tag: "IrDerivedExpr",
        kind: "concat",
        parts: [{ kind: "field", field: "title" }],
      },
    },
  });
  expect(program.list_details).toEqual([{
    _tag: "IrListDetail",
    entity_name: "release",
    title: "Releases",
    columns: ["id", "title"],
    search_cols: ["title"],
    detail_tabs: [
      {
        _tag: "IrDetailTab",
        label: "Overview",
        content_type: "fields",
        fields: ["id", "title", "label"],
        entity_name: null,
        relation_field: null,
        infer_relation: false,
        display_fields: [],
      },
      {
        _tag: "IrDetailTab",
        label: "Notes",
        content_type: "related",
        fields: [],
        entity_name: "release-note",
        relation_field: "release",
        infer_relation: false,
        display_fields: ["id", "summary"],
      },
    ],
  }]);
}, 30_000);

test("checked decoder rejects invalid derived declarations", () => {
  const cases = [
    ["unknown target", (ast) => {
      definition(ast, "release").value.args[5].items[0].args[0].value = "ghost";
    }, "derived field names unknown field 'ghost'"],
    ["identity target", (ast) => {
      definition(ast, "release").value.args[5].items[0].args[0].value = "id";
    }, "derived field 'release.id' cannot be the entity identity"],
    ["non-String target", (ast) => {
      definition(ast, "release").value.args[5].items[0].args[0].value = "aliases";
    }, "derived field 'release.aliases' must target a concrete String field"],
    ["writable target", (ast) => {
      const release = definition(ast, "release").value;
      const pair = structuredClone(release.args[3].pairs[0]);
      pair.key.value = "label";
      release.args[3].pairs.push(pair);
    }, "derived field 'release.label' cannot declare a write policy"],
    ["missing dependency", (ast) => {
      definition(ast, "release").value.args[5].items[0]
        .args[1].args[0].items[0].args[0].value = "ghost";
    }, "references unknown field 'ghost'"],
    ["derived dependency", (ast) => {
      definition(ast, "release").value.args[5].items[0]
        .args[1].args[0].items[0].args[0].value = "label";
    }, "cannot reference derived field 'label'"],
    ["duplicate spec", (ast) => {
      const specs = definition(ast, "release").value.args[5].items;
      specs.push(structuredClone(specs[0]));
    }, "derived field repeats 'label'"],
    ["empty concatenation", (ast) => {
      definition(ast, "release").value.args[5].items[0]
        .args[1].args[0].items = [];
    }, "must concatenate at least one part"],
  ];
  for (const [label, mutate, message] of cases) {
    const ast = checkedAst(fixture);
    mutate(ast);
    reseal(ast);
    expect(() => decodeFixture(ast), label).toThrow(message);
  }
}, 30_000);

test("checked decoder rejects forged list-detail helpers and provenance", () => {
  const cases = [
    ["local helper", (ast) => {
      definition(ast, "release-list").value.args[4].items[0].fn.name = "detail-tab";
    }, "must use a checked wake/* binding"],
    ["wrong descriptor constructor", (ast) => {
      definition(ast, "release-list").value.fn.name = "wake/->ApplicationSpec";
    }, "does not match checked extern 'wake/->ApplicationSpec'"],
    ["wrong macro provenance", (ast) => {
      definition(ast, "release-list").value.args[4].items[0]
        .provenance.macroExpansion.chain[0].name = "wake/defentity";
    }, "must come directly from wake/list-detail"],
  ];
  for (const [label, mutate, message] of cases) {
    const ast = checkedAst(fixture);
    mutate(ast);
    reseal(ast);
    expect(() => decodeFixture(ast), label).toThrow(message);
  }
}, 30_000);

test("checked derived detail fields produce bundleable browser JavaScript", async () => {
  const output = mkdtempSync(join(tmpdir(), "wake-query-api-bundle-"));
  try {
    const compiled = Bun.spawnSync(
      [wakeCompile, "--all", fixture, output],
      {
        cwd: webRoot,
        env: { ...process.env, BEAGLE_ROOT: beagleRoot },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    expect(compiled.exitCode, compiled.stderr.toString()).toBe(0);
    const browser = await Bun.build({
      entrypoints: [join(output, "app.js")],
      outdir: join(output, "bundle"),
      target: "browser",
    });
    expect(browser.success, browser.logs.join("\n")).toBeTrue();
  } finally {
    rmSync(output, { force: true, recursive: true });
  }
}, 30_000);

test("derived expressions preserve ordered string concatenation", () => {
  const ast = checkedAst(derivedStringFixture);
  const contact = definition(ast, "contact");
  const expression = contact.value.args[5].items[0].args[1];
  expect(expression.fn.name).toBe("wake/concat-derived");
  expect(expression.inferredType).toEqual(type("DerivedExpr"));

  const parts = expression.args[0];
  expect(parts.inferredType).toEqual(appType("Vec", type("DerivedExpr")));
  expect(parts.items.map((part) => part.fn.name)).toEqual([
    "wake/derived-ref",
    "wake/derived-string",
    "wake/derived-ref",
  ]);
  expect(parts.items.map((part) => part.args[0].value)).toEqual([
    "name",
    " @ ",
    "company",
  ]);
  for (const part of parts.items) {
    expect(part.inferredType).toEqual(type("DerivedExpr"));
    expect(part.provenance.macroExpansion.chain).toEqual([
      { depth: 0, name: "wake/defentity" },
    ]);
  }
}, 30_000);

test("defquery rejects the retired keyword result surface", () => {
  const output = failedBeagle(["check", "--agent", wrongResultFixture]);
  expect(output).toContain("expected QueryResult, got Keyword");
}, 30_000);

test("derived-field rejects expressions outside the closed union", () => {
  const output = failedBeagle(["check", "--agent", wrongDerivedFixture]);
  expect(output).toContain("expected DerivedExpr, got String");
}, 30_000);
