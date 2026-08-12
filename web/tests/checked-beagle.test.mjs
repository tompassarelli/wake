import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { programFromCheckedAst } from "../compiler/checked-beagle.mjs";
import { canonicalJson, sha256Digest } from "../compiler/canonical.mjs";

const webRoot = `${import.meta.dir}/..`;
const compile = `${webRoot}/bin/wake-compile`;
const fixtures = `${webRoot}/tests/fixtures/checked-beagle`;
const repositoryRoot = resolve(webRoot, "..");
const checkedSourcePath = resolve(fixtures, "application.bjs");
const checkedSourceText = readFileSync(checkedSourcePath, "utf8");
const expectedSourceId = relative(repositoryRoot, checkedSourcePath);
const beagleRoot = process.env.BEAGLE_PROJECTION_ROOT
  ?? process.env.BEAGLE_ROOT
  ?? `${process.env.HOME}/code/beagle/main`;
const projectionResult = Bun.spawnSync(
  [`${beagleRoot}/bin/beagle`, "ast", checkedSourcePath],
  { cwd: repositoryRoot, stderr: "pipe", stdout: "pipe" },
);
if (projectionResult.exitCode !== 0) throw new Error(projectionResult.stderr.toString());
const checkedAst = JSON.parse(projectionResult.stdout.toString());

function compileDriver(arguments_, env = process.env) {
  return Bun.spawnSync(["bun", "--no-install", `${webRoot}/compiler/compile-driver.mjs`, ...arguments_], {
    cwd: webRoot,
    env,
    stderr: "pipe",
    stdout: "pipe",
  });
}

function form(ast, name) {
  const value = ast.forms.find((candidate) => candidate.name === name);
  if (value === undefined) throw new Error(`missing test form ${name}`);
  return value;
}

function project(ast = checkedAst, overrides = {}) {
  return programFromCheckedAst(ast, {
    compilerVersion: "0.1.0",
    expectedSourceId: overrides.expectedSourceId ?? expectedSourceId,
    sourcePath: overrides.sourcePath ?? checkedSourcePath,
    sourceText: overrides.sourceText ?? checkedSourceText,
  });
}

function reseal(ast) {
  const projection = { ...ast };
  delete projection.projectionSha256;
  ast.projectionSha256 = sha256Digest(canonicalJson(projection));
}

function rejected(label, mutate, message) {
  test(label, () => {
    const ast = structuredClone(checkedAst);
    mutate(ast);
    reseal(ast);
    expect(() => project(ast)).toThrow(message);
  });
}

function compileAll(source, output, env = process.env) {
  const result = Bun.spawnSync([compile, "--all", source, output], {
    cwd: webRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

function withoutFingerprint(value) {
  if (Array.isArray(value)) return value.map(withoutFingerprint);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "semanticFingerprint")
    .map(([key, child]) => [key, withoutFingerprint(child)]));
}

function normalizeCheckedFingerprint(text) {
  return text
    .replace(
      /^(\/\/ wake: checked-application )sha256:[0-9a-f]{64}$/mu,
      "$1sha256:<fingerprint>",
    )
    .replaceAll(
      /((?:semanticFingerprint|wakeApplicationFingerprint) = ")sha256:[0-9a-f]{64}(";)/gu,
      "$1sha256:<fingerprint>$2",
    );
}

function manifestSemantics(manifest) {
  return {
    ...manifest,
    artifacts: Object.fromEntries(Object.entries(manifest.artifacts).map(([name, artifact]) => [
      name,
      { path: artifact.path },
    ])),
    checkedApplication: {
      schemaVersion: manifest.checkedApplication.schemaVersion,
    },
  };
}

function deploymentSemantics(deployment) {
  return {
    applicationId: deployment.applicationId,
    schemaVersion: deployment.schemaVersion,
  };
}

test("checked Beagle input reaches Wake graph and codegen unchanged", () => {
  const temporary = mkdtempSync(join(tmpdir(), "wake-checked-beagle-"));
  const beagleOutput = join(temporary, "beagle");
  const legacyOutput = join(temporary, "legacy");
  try {
    compileAll(join(fixtures, "application.bjs"), beagleOutput, {
      ...process.env,
      BEAGLE_ROOT: process.env.BEAGLE_PROJECTION_ROOT ?? process.env.BEAGLE_ROOT,
    });
    compileAll(join(fixtures, "legacy.wake"), legacyOutput);

    const beaglePlan = JSON.parse(readFileSync(join(beagleOutput, "app.fram.json"), "utf8"));
    const legacyPlan = JSON.parse(readFileSync(join(legacyOutput, "app.fram.json"), "utf8"));
    expect(withoutFingerprint(beaglePlan)).toEqual(withoutFingerprint(legacyPlan));

    const beagleJavaScript = normalizeCheckedFingerprint(
      readFileSync(join(beagleOutput, "app.js"), "utf8"),
    );
    const legacyJavaScript = normalizeCheckedFingerprint(
      readFileSync(join(legacyOutput, "app.js"), "utf8"),
    );
    expect(beagleJavaScript).toBe(legacyJavaScript);

    const beagleClient = normalizeCheckedFingerprint(
      readFileSync(join(beagleOutput, "wake-client.js"), "utf8"),
    );
    const legacyClient = normalizeCheckedFingerprint(
      readFileSync(join(legacyOutput, "wake-client.js"), "utf8"),
    );
    expect(beagleClient).toBe(legacyClient);

    const beagleManifest = JSON.parse(
      readFileSync(join(beagleOutput, "app.wake.manifest.json"), "utf8"),
    );
    const legacyManifest = JSON.parse(
      readFileSync(join(legacyOutput, "app.wake.manifest.json"), "utf8"),
    );
    expect(manifestSemantics(beagleManifest)).toEqual(manifestSemantics(legacyManifest));
    expect(beagleManifest.digests).toEqual(legacyManifest.digests);

    const beagleDeployment = JSON.parse(
      readFileSync(join(beagleOutput, "app.wake.deployment.json"), "utf8"),
    );
    const legacyDeployment = JSON.parse(
      readFileSync(join(legacyOutput, "app.wake.deployment.json"), "utf8"),
    );
    expect(deploymentSemantics(beagleDeployment)).toEqual(
      deploymentSemantics(legacyDeployment),
    );
    for (const [receiptKey, artifactKey] of [
      ["browserClientDigest", "browserClient"],
      ["browserJavaScriptDigest", "browserJavaScript"],
      ["framPlanDigest", "framPlan"],
    ]) {
      expect(beagleDeployment[receiptKey]).toBe(
        beagleManifest.artifacts[artifactKey].sha256,
      );
      expect(legacyDeployment[receiptKey]).toBe(
        legacyManifest.artifacts[artifactKey].sha256,
      );
    }
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}, 60_000);

test("projects exact source spans, names, tokens, and Beagle types", () => {
  const program = project();
  const applicationOffset = checkedSourceText.indexOf("(wake/application");
  expect(program.application.span).toEqual({
    _tag: "SourceSpan",
    source_id: "application:application.bjs",
    start_offset: applicationOffset,
    end_offset: checkedSourceText.indexOf("\n", applicationOffset),
    start_line: 5,
    start_column: 1,
    end_line: 5,
    end_column: 61,
  });
  expect(program.declaration_provenance[0].name).toBe("wake-checked-beagle-fixture");
  expect(program.defstates[0]).toMatchObject({
    initial: ":draft",
    transitions: { ":draft": [":published"], ":published": [] },
  });
  expect(program.queries[0].predicates[0].right).toMatchObject({
    name: "Keyword",
    value: ":published",
  });

  const intAst = structuredClone(checkedAst);
  form(intAst, "Page").fields[1].ann = { kind: "prim", name: "Int" };
  reseal(intAst);
  expect(project(intAst).entities.find((entity) => entity.name === "page")
    .attrs.find((field) => field.name === "title").type).toBe("Int");
  expect(program.router).toMatchObject({
    default_route: "revisions",
    routes: [{ path: "home", view_name: "revisions" }],
  });
});

test("rejects stale checked AST for same-length source bytes", () => {
  expect(() => project(checkedAst, {
    sourceText: checkedSourceText.replace(
      "wake-checked-beagle-fixture",
      "zzzz-checked-beagle-fixture",
    ),
  })).toThrow("projection source digest does not match the checked input bytes");
});

test("rejects an AST payload changed after Beagle projection", () => {
  const ast = structuredClone(checkedAst);
  form(ast, "Page").fields[1].name = "renamed";
  form(ast, "page").value.args[3].pairs[0].key.value = "renamed";
  expect(() => project(ast)).toThrow(
    "projection digest does not match its canonical checked-program payload",
  );
});

test("compile driver exposes no caller-supplied checked AST route", () => {
  const result = compileDriver([
    "--ast", "/tmp/forged.json",
    "--dist", "/tmp/unreachable",
    "--mode", "fram",
    "--source", checkedSourcePath,
    "--output", "-",
  ]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("driver rejects unsupported option --ast");
});

test("projects each closed query result helper", () => {
  for (const [helper, resultKind] of [
    ["optional-result", "optional"],
    ["one-result", "one"],
  ]) {
    const ast = structuredClone(checkedAst);
    const result = form(ast, "published-revisions").value.args[6];
    result.fn.name = `wake/${helper}`;
    result.args = [];
    reseal(ast);
    expect(project(ast).queries[0]).toMatchObject({ page: null, result_kind: resultKind });
  }
});

test("rejects a source path outside the projected repository identity", () => {
  expect(() => project(checkedAst, {
    sourcePath: "/different/location/forged.bjs",
  })).toThrow("does not end in its repository-relative projection identity");
});

rejected("rejects shifted macro provenance spans", (ast) => {
  const application = form(ast, "application");
  const visit = (value) => {
    if (value === null || typeof value !== "object") return;
    if (value.provenance?.source !== undefined) value.provenance.source.span += 1;
    for (const child of Object.values(value)) visit(child);
  };
  visit(application);
}, "does not cover its exact source invocation");

rejected("rejects require alias collisions", (ast) => {
  ast.requires.push({ alias: "wake", ns: "evil.provider", refer: false });
}, "reuses require alias 'wake'");

rejected("rejects forged constructor extern types", (ast) => {
  ast.externs.find((entry) => entry.name === "wake/->ApplicationSpec").type = {
    kind: "prim",
    name: "Any",
  };
}, "does not match checked extern 'wake/->ApplicationSpec'");

rejected("rejects extra callee type claims", (ast) => {
  form(ast, "application").value.fn.inferredType = { kind: "prim", name: "Any" };
}, "callee has unsupported fields");

rejected("rejects extra literal type claims", (ast) => {
  form(ast, "application").value.args[0].inferredType = {
    kind: "prim",
    name: "Keyword",
  };
}, "argument 1 has unsupported fields");

rejected("rejects forged container inferred types", (ast) => {
  form(ast, "page").value.args[3].inferredType = { kind: "prim", name: "Any" };
}, "argument 4 type does not match checked extern 'wake/->EntitySpec'");

rejected("rejects unknown checked expression fields", (ast) => {
  form(ast, "application").value.unrecognized = true;
}, "value has unsupported fields");

rejected("rejects UI attributes outside the codegen surface", (ast) => {
  const attrs = form(ast, "revision-row").value.args[2].items[0].args[1].pairs;
  const extra = structuredClone(attrs[0]);
  extra.key.value = "on-click";
  attrs.push(extra);
}, "uses unsupported UI attribute ':on-click'");

rejected("rejects gen-class programs", (ast) => {
  ast["gen-class"] = true;
}, "must not enable gen-class");

rejected("rejects mismatched source identity", (ast) => {
  ast.sourceId = "different/application.bjs";
}, "does not match input identity");

rejected("rejects a wrong macro argument literal", (ast) => {
  const original = form(ast, "application").value.args[0];
  form(ast, "application").value.args[0] = {
    ...original,
    kind: "keyword",
    value: "not-a-string",
  };
}, "application ID must be a string literal");

rejected("rejects a forged local constructor", (ast) => {
  form(ast, "application").value.fn.name = "->ApplicationSpec";
}, "must use a checked wake/* binding");

rejected("rejects unrelated top-level definitions", (ast) => {
  ast.forms.push({
    ann: { kind: "prim", name: "String" },
    doc: false,
    dynamic: false,
    name: "unrelated",
    node: "def",
    provenance: structuredClone(form(ast, "application").provenance),
    value: {
      kind: "string",
      node: "literal",
      provenance: structuredClone(form(ast, "application").provenance),
      value: "ignored",
    },
  });
}, "unsupported top-level checked form def 'unrelated'");

rejected("rejects descriptor names that diverge from bindings", (ast) => {
  form(ast, "page").value.args[0].value = "renamed-page";
}, "does not match binding 'page'");

rejected("rejects a companion from another macro invocation", (ast) => {
  form(ast, "Page").provenance = structuredClone(
    form(ast, "published-revisions-bindings").provenance,
  );
}, "must come directly from wake/defentity");

rejected("rejects unknown entity write fields", (ast) => {
  const writes = form(ast, "page").value.args[3].pairs;
  const extra = structuredClone(writes[0]);
  extra.key.value = "ghost";
  writes.push(extra);
}, "write policy names unknown field 'ghost'");

rejected("rejects invalid entity write policies", (ast) => {
  form(ast, "page").value.args[3].pairs[0].val.value = "draft";
}, "write policy must be :create, :set, or :command");

rejected("rejects duplicate decoded map keys", (ast) => {
  const writes = form(ast, "page").value.args[3].pairs;
  writes.push(structuredClone(writes[0]));
}, "writes repeats 'title'");

rejected("rejects wrong helper inferred types", (ast) => {
  const route = form(ast, "application-routes").value.args[1].items[0];
  route.inferredType = { kind: "prim", name: "UiNode" };
}, "inferred type does not match checked extern 'wake/route'");

rejected("rejects helper calls without projection provenance", (ast) => {
  const route = form(ast, "application-routes").value.args[1].items[0];
  delete route.provenance;
}, "has unsupported fields");

rejected("rejects duplicate UI attributes", (ast) => {
  const component = form(ast, "revision-row");
  const attrs = component.value.args[2].items[0].args[1].pairs;
  attrs.push(structuredClone(attrs[0]));
}, "attribute repeats 'class'");

rejected("rejects bindings to unknown component props", (ast) => {
  const component = form(ast, "revision-row");
  const child = component.value.args[2].items[0].args[2].items[0];
  child.args[1].pairs[0].val.args[0].value = "ghost";
}, "binds unknown component prop 'ghost'");

rejected("rejects views with unknown entities", (ast) => {
  form(ast, "revisions").value.args[1].value = "ghost";
}, "names unknown entity 'ghost'");

rejected("rejects views with unknown components", (ast) => {
  form(ast, "revisions").value.args[2].value = "ghost";
}, "names unknown component 'ghost'");

rejected("rejects duplicate routes", (ast) => {
  const routes = form(ast, "application-routes").value.args[1].items;
  routes.push(structuredClone(routes[0]));
}, "route path repeats 'home'");

rejected("rejects unknown default routes", (ast) => {
  form(ast, "application-routes").value.args[0].value = "ghost";
}, "routes default names unknown view 'ghost'");

rejected("rejects unsafe page bounds with the legacy diagnostic", (ast) => {
  form(ast, "published-revisions").value.args[6].args[1].value = 300;
}, "page limits must be positive integers with default <= max <= 247");

rejected("rejects bare local Ref as a Wake IR sentinel collision", (ast) => {
  form(ast, "Page").fields[1].ann = { kind: "prim", name: "Ref" };
}, "uses reserved Wake IR type 'Ref' without wake/Ref");

rejected("rejects bare local Derived as a Wake IR sentinel collision", (ast) => {
  form(ast, "Page").fields[1].ann = { kind: "prim", name: "Derived" };
}, "uses reserved Wake IR type 'Derived' without wake/Derived");

rejected("rejects invalid query parameter identifiers", (ast) => {
  const paramsRecordName = form(ast, "published-revisions").value.args[1];
  paramsRecordName.value = "published-revisions-params";
  const paramsRecord = structuredClone(form(ast, "published-revisions-bindings"));
  paramsRecord.name = "published-revisions-params";
  paramsRecord.fields = [{ ann: { kind: "prim", name: "String" }, name: "bad.name" }];
  ast.forms.push(paramsRecord);
}, "parameter name must contain only letters, digits, '-' or '_'");

rejected("rejects invalid query binding identifiers", (ast) => {
  form(ast, "published-revisions-bindings").fields[0].name = "bad.name";
}, "binding name must contain only letters, digits, '-' or '_'");

rejected("rejects invalid query field references", (ast) => {
  const field = form(ast, "published-revisions").value.args[5].items[0].args[1];
  field.args[1].value = "bad.name";
}, "field must contain only letters, digits, '-' or '_'");

rejected("rejects invalid query output identifiers", (ast) => {
  form(ast, "published-revisions").value.args[5].items[0].args[0].value = "bad.name";
}, "name must contain only letters, digits, '-' or '_'");
