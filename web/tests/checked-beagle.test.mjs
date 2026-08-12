import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { programFromCheckedAst } from "../compiler/checked-beagle.mjs";

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

function form(ast, name) {
  const value = ast.forms.find((candidate) => candidate.name === name);
  if (value === undefined) throw new Error(`missing test form ${name}`);
  return value;
}

function project(ast = checkedAst) {
  return programFromCheckedAst(ast, {
    compilerVersion: "0.1.0",
    expectedSourceId,
    sourcePath: checkedSourcePath,
    sourceText: checkedSourceText,
  });
}

function rejected(label, mutate, message) {
  test(label, () => {
    const ast = structuredClone(checkedAst);
    mutate(ast);
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
}, 30_000);

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
  expect(project(intAst).entities.find((entity) => entity.name === "page")
    .attrs.find((field) => field.name === "title").type).toBe("Int");
});

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
    value: { kind: "string", node: "literal", value: "ignored" },
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
}, "must infer exact RouteSpec");

rejected("rejects helper calls without projection provenance", (ast) => {
  const route = form(ast, "application-routes").value.args[1].items[0];
  delete route.provenance;
}, "lacks exact canonical macro invocation provenance");

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
}, "route path repeats 'revisions'");

rejected("rejects unknown default routes", (ast) => {
  form(ast, "application-routes").value.args[0].value = "ghost";
}, "routes default names unknown route 'ghost'");

rejected("rejects unsafe page bounds with the legacy diagnostic", (ast) => {
  form(ast, "published-revisions").value.args[8].value = 300;
}, "page limits must be positive integers with default <= max <= 247");
