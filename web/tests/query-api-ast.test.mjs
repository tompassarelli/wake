import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  checkedDeclarationProgramFromBundle,
} from "../compiler/checked-declarations.mjs";
import { canonicalJson, sha256Digest } from "../compiler/canonical.mjs";

const webRoot = `${import.meta.dir}/..`;
const repositoryRoot = join(webRoot, "..");
const beagleRoot = process.env.BEAGLE_PROJECTION_ROOT
  ?? process.env.BEAGLE_ROOT
  ?? join(homedir(), "code", "beagle", "main");
const beagle = join(beagleRoot, "bin", "beagle");
const sourcePaths = Object.freeze({
  derivedString: join(
    webRoot,
    "tests",
    "fixtures",
    "query-api",
    "derived-string.bjs",
  ),
  results: join(webRoot, "tests", "fixtures", "query-api", "results.bjs"),
  wakeCore: join(webRoot, "wake", "core.bjs"),
  wakeIr: join(webRoot, "compiler", "ir.bjs"),
  wrongDerived: join(
    webRoot,
    "tests",
    "fixtures",
    "query-api",
    "wrong-derived-expression.bjs",
  ),
  wrongResult: join(
    webRoot,
    "tests",
    "fixtures",
    "query-api",
    "wrong-result-type.bjs",
  ),
});
const sourceIds = Object.freeze({
  derivedString: "web/tests/fixtures/query-api/derived-string.bjs",
  results: "web/tests/fixtures/query-api/results.bjs",
  wakeCore: "web/wake/core.bjs",
  wakeIr: "web/compiler/ir.bjs",
});
const sourceText = Object.freeze(Object.fromEntries(
  Object.entries(sourcePaths).map(([name, path]) => [name, readFileSync(path, "utf8")]),
));

function suppliedSource(sourceId, text, authority) {
  return {
    sourceId,
    bytesBase64: Buffer.from(text).toString("base64"),
    authority,
  };
}

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

function checkedBundle(entrySourceId, sources) {
  const result = Bun.spawnSync([beagle, "ast-bundle"], {
    cwd: repositoryRoot,
    stdin: Buffer.from(JSON.stringify({
      kind: "beagle.checked-bundle.request",
      schemaVersion: 4,
      entrySourceId,
      sources,
    })),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return JSON.parse(result.stdout.toString());
}

const wakeCoreModelBundle = checkedBundle(sourceIds.wakeCore, [
  suppliedSource(sourceIds.wakeCore, sourceText.wakeCore, "trusted"),
]);
const wakeIrModelBundle = checkedBundle(sourceIds.wakeIr, [
  suppliedSource(sourceIds.wakeIr, sourceText.wakeIr, "trusted"),
]);
const resultsBundle = checkedBundle(sourceIds.results, [
  suppliedSource(sourceIds.results, sourceText.results, "package"),
  suppliedSource(sourceIds.wakeCore, sourceText.wakeCore, "trusted"),
]);
const derivedStringBundle = checkedBundle(sourceIds.derivedString, [
  suppliedSource(sourceIds.derivedString, sourceText.derivedString, "package"),
  suppliedSource(sourceIds.wakeCore, sourceText.wakeCore, "trusted"),
]);

function sourcesFor(bundle) {
  const available = {
    [sourceIds.derivedString]: sourceText.derivedString,
    [sourceIds.results]: sourceText.results,
    [sourceIds.wakeCore]: sourceText.wakeCore,
    [sourceIds.wakeIr]: sourceText.wakeIr,
  };
  const ids = new Set([
    ...bundle.modules.map((module) => module.sourceId),
    ...wakeCoreModelBundle.modules.map((module) => module.sourceId),
    ...wakeIrModelBundle.modules.map((module) => module.sourceId),
  ]);
  return Object.fromEntries([...ids].map((sourceId) => [sourceId, available[sourceId]]));
}

function decode(bundle) {
  return checkedDeclarationProgramFromBundle(bundle, {
    compilerVersion: "0.1.0",
    sourceTexts: sourcesFor(bundle),
    wakeCoreModelBundle,
    wakeIrModelBundle,
  });
}

function reseal(bundle) {
  const projection = { ...bundle.entryProjection };
  delete projection.projectionSha256;
  bundle.entryProjection.projectionSha256 = sha256Digest(canonicalJson(projection));
  bundle.sourceClosureSha256 = sha256Digest(canonicalJson({
    entrySourceId: bundle.entrySourceId,
    modules: bundle.modules,
  }));
  const response = { ...bundle };
  delete response.checkedBundleSha256;
  bundle.checkedBundleSha256 = sha256Digest(canonicalJson(response));
  return bundle;
}

function definition(bundle, name) {
  const value = bundle.entryProjection.forms.find((candidate) =>
    candidate.node === "def" && candidate.name === name);
  expect(value, `missing definition ${name}`).toBeDefined();
  return value;
}

function mutate(bundle, change) {
  const changed = structuredClone(bundle);
  change(changed);
  return reseal(changed);
}

function declarationByName(declarations, name) {
  const declaration = declarations.find((candidate) => candidate.ref.name === name);
  expect(declaration, `missing declaration ${name}`).toBeDefined();
  return declaration;
}

test("query declarations decode through the sealed checked-bundle boundary", () => {
  for (const key of ["results", "derivedString"]) {
    expect(sourceText[key]).not.toMatch(/\bAny\b/u);
    expect(sourceText[key]).not.toMatch(/\braw\b/u);
  }

  const checked = decode(resultsBundle);
  expect(checked._tag).toBe("IrCheckedDeclarationProgram");
  expect(checked.program).toMatchObject({
    _tag: "IrDeclarationProgram",
    ns: "wake.fixtures.query-results",
    root: {
      _tag: "IrApplicationDeclarationRoot",
      application: {
        id: "wake-query-api-fixture",
        authority: {
          _tag: "IrLocalStorageAuthority",
          namespace: "wake-query-api-fixture",
        },
      },
    },
  });
  expect(checked.program.receipt_entity).toMatchObject({
    ref: { declaration_id: "wake.core/command-receipt" },
  });
  expect(checked.program.receipt_fields).toHaveLength(5);

  expect(checked.program.entities.map((entity) => entity.ref.name)).toEqual([
    "release",
    "release-note",
  ]);
  const release = declarationByName(checked.program.entities, "release");
  expect(release).toMatchObject({
    record_name: "Release",
    storage_id: "wake-query-api/entity/release",
  });
  expect(release.fields.map((field) => field.ref.name)).toEqual([
    "id",
    "title",
    "aliases",
  ]);
  expect(release.derived_fields).toHaveLength(1);
  expect(release.derived_fields[0]).toMatchObject({
    ref: { declaration_id: "entity/release/field/label", name: "label" },
    owner: { declaration_id: "entity/release", name: "release" },
    expression: {
      _tag: "IrConcatDerivedExpr",
      parts: [{
        _tag: "IrFieldDerivedExpr",
        field: { declaration_id: "entity/release/field/title", name: "title" },
      }],
    },
    dependencies: [{
      declaration_id: "entity/release/field/title",
      name: "title",
    }],
  });

  expect(checked.program.queries.map((query) => query.ref.name)).toEqual([
    "release-page",
    "release-optional",
    "release-one",
  ]);
  const page = declarationByName(checked.program.queries, "release-page");
  expect(page).toMatchObject({
    capabilities: [{ declaration_id: "capability/read-release" }],
    bindings: [{
      name: "release",
      entity: { declaration_id: "entity/release" },
    }],
    result: {
      _tag: "IrQueryPageResult",
      default_limit: { _tag: "IrLiteralBound", value: 20 },
      max_limit: { _tag: "IrLiteralBound", value: 64 },
    },
  });
  const optional = declarationByName(checked.program.queries, "release-optional");
  expect(optional.parameters).toMatchObject([{
    name: "release-id",
    value_type: { _tag: "IrStringValueType" },
  }]);
  expect(optional.result._tag).toBe("IrQueryOptionalResult");
  expect(declarationByName(checked.program.queries, "release-one").result._tag)
    .toBe("IrQueryOneResult");

  expect(checked.program.list_details).toHaveLength(1);
  const detail = checked.program.list_details[0];
  expect(detail).toMatchObject({
    ref: { declaration_id: "list-detail/release", name: "release-list" },
    entity: { declaration_id: "entity/release", name: "release" },
    title: "Releases",
  });
  expect(detail.columns.map((field) => field.name)).toEqual(["id", "title"]);
  expect(detail.search.map((field) => field.name)).toEqual(["title"]);
  expect(detail.detail_tabs).toMatchObject([
    {
      _tag: "IrFieldsDetailTab",
      label: "Overview",
      fields: [{ name: "id" }, { name: "title" }, { name: "label" }],
    },
    {
      _tag: "IrRelatedDetailTab",
      label: "Notes",
      entity: { declaration_id: "entity/release-note" },
      relation: { declaration_id: "entity/release-note/field/release" },
      display: [{ name: "id" }, { name: "summary" }],
    },
  ]);
  expect(checked.program.root.application.list_details).toMatchObject([
    { declaration_id: "list-detail/release", name: "release-list" },
  ]);
}, 60_000);

test("derived expressions preserve ordered nominal dependencies", () => {
  const checked = decode(derivedStringBundle);
  const contact = declarationByName(checked.program.entities, "contact");
  expect(contact.derived_fields).toHaveLength(1);
  const derived = contact.derived_fields[0];
  expect(derived.expression.parts.map((part) => part._tag)).toEqual([
    "IrFieldDerivedExpr",
    "IrStringDerivedExpr",
    "IrFieldDerivedExpr",
  ]);
  expect(derived.expression.parts.map((part) => part.field?.name ?? part.value)).toEqual([
    "name",
    " @ ",
    "company",
  ]);
  expect(derived.dependencies.map((field) => field.name)).toEqual(["name", "company"]);
}, 60_000);

test("checked declarations reject forged ownership, dependency, and root closure", () => {
  const foreignOwner = mutate(resultsBundle, (bundle) => {
    definition(bundle, "release-label-spec").value.args[1].name = "release-note-ref";
  });
  expect(() => decode(foreignOwner)).toThrow(
    "derived field 'label' has a foreign entity owner",
  );

  const missingDependency = mutate(resultsBundle, (bundle) => {
    definition(bundle, "release-label-spec").value.args[3].items = [];
  });
  expect(() => decode(missingDependency)).toThrow(
    "derived field 'label' dependencies do not exactly match its expression",
  );

  const missingListDetail = mutate(resultsBundle, (bundle) => {
    definition(bundle, "application").value.args[9].items = [];
  });
  expect(() => decode(missingListDetail)).toThrow(
    "application root must select every list-details declaration exactly once",
  );
}, 60_000);

test("query results and derived expressions remain closed typed unions", () => {
  const wrongResult = failedBeagle([
    "check",
    "--agent",
    sourcePaths.wakeCore,
    sourcePaths.wrongResult,
  ]);
  expect(wrongResult).toContain("expected QueryResultSpec, got Keyword");

  const wrongDerived = failedBeagle([
    "check",
    "--agent",
    sourcePaths.wakeCore,
    sourcePaths.wrongDerived,
  ]);
  expect(wrongDerived).toContain("expected DerivedExpr, got String");
}, 60_000);

test("query fixtures stay accepted by the candidate Beagle compiler", () => {
  runBeagle([
    "check",
    "--agent",
    sourcePaths.wakeCore,
    sourcePaths.results,
    sourcePaths.derivedString,
  ]);
}, 60_000);
