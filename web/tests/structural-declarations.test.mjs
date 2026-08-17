import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const webRoot = `${import.meta.dir}/..`;
const repositoryRoot = join(webRoot, "..");
const coreSourceId = "web/wake/core.bjs";
const corePath = join(repositoryRoot, coreSourceId);
const coreSource = readFileSync(corePath, "utf8");
const entrySourceId = "web/tests/fixtures/structural-declarations.bjs";
const fixtureRoot = join(webRoot, "tests/fixtures");
const beagleRoot = process.env.BEAGLE_PROJECTION_ROOT
  ?? process.env.BEAGLE_ROOT
  ?? join(homedir(), "code", "beagle", "main");
const beagle = join(beagleRoot, "bin", "beagle");
const moduleRoot = ["--module-root", `web=${webRoot}`];

const completeField = `(id "entity/item/id" "id" String
  (wake/->StringField nil)
  (wake/->SingleField nil)
  (wake/->IdentityWrite nil)
  "store/item/id"
  validator?)`;

const declarations = Object.freeze({
  values: `[(draft "state/lifecycle/draft" "draft" :draft)]`,
  transitions: "[(draft [])]",
  fields: `[${completeField}]`,
  derivedFields: `[(label "entity/item/label" "label"
    (wake/->StringDerivedExpr "label")
    [])]`,
  definitions: `[(alias (wake/->StringValueType nil nil nil))]`,
  extensionFields: `[(extra "fields/extra" "extra"
    (wake/->StringField nil)
    (wake/->SingleField nil)
    (wake/->CreateWrite nil)
    "store/item/extra"
    validator?)]`,
});

function source(overrides = {}) {
  const forms = { ...declarations, ...overrides };
  return `#lang beagle/js
(ns wake.tests.structural-declarations
  (:require [wake.core :as wake]))

(def validator? Bool true)

(wake/defstate-model
  Lifecycle
  "state/lifecycle"
  "lifecycle"
  ${forms.values}
  draft
  ${forms.transitions})

(wake/defentity-ref item "entity/item" "item")

(wake/define-entity-model
  item
  Item
  "entity/item"
  ${forms.fields}
  ${forms.derivedFields}
  "store/item")

(wake/defvalue-type
  safe-text
  "value/safe-text"
  (wake/->StringValueType nil nil nil)
  ${forms.definitions}
  nil)

(wake/defplugin-use remote "plugin-use/remote")

(wake/extend-entity-fields
  extra-fields
  remote-ref
  "fields"
  "fields"
  ${forms.extensionFields})
`;
}

function checkedBundle(text) {
  const request = {
    kind: "beagle.checked-bundle.request",
    schemaVersion: 4,
    entrySourceId,
    sources: [
      {
        sourceId: entrySourceId,
        bytesBase64: Buffer.from(text).toString("base64"),
        authority: "package",
      },
      {
        sourceId: coreSourceId,
        bytesBase64: Buffer.from(coreSource).toString("base64"),
        authority: "trusted",
      },
    ],
  };
  return Bun.spawnSync([beagle, "ast-bundle"], {
    cwd: repositoryRoot,
    stdin: Buffer.from(JSON.stringify(request)),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 55_000,
  });
}

function diagnostics(result) {
  return `${result.stdout.toString()}\n${result.stderr.toString()}`;
}

function sourceDiagnostics(paths) {
  return Bun.spawnSync([beagle, "check", ...moduleRoot, corePath, ...paths], {
    cwd: webRoot,
    env: { ...process.env, BEAGLE_ERROR_FORMAT: "json" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 55_000,
  });
}

function parseJsonDiagnostics(result) {
  return diagnostics(result)
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
}

test("complete declarations own every local metadata form", () => {
  const result = checkedBundle(source());
  expect(result.exitCode, diagnostics(result)).toBe(0);
}, 60_000);

test("declaration collections require outer vectors", () => {
  const cases = [
    {
      name: "state values",
      overrides: { values: "((draft \"state/lifecycle/draft\" \"draft\" :draft))" },
      expected: "State value declarations must be a vector of complete forms:",
    },
    {
      name: "state transitions",
      overrides: { transitions: "((draft []))" },
      expected: "State transition declarations must be a vector of complete forms:",
    },
    {
      name: "fields",
      overrides: { fields: `(${completeField})` },
      expected: "Field declarations must be a vector of complete forms.",
    },
    {
      name: "derived fields",
      overrides: {
        derivedFields: `(${declarations.derivedFields.slice(1, -1)})`,
      },
      expected: "Derived field declarations must be a vector of complete forms.",
    },
    {
      name: "value type definitions",
      overrides: { definitions: "((alias (wake/->StringValueType nil nil nil)))" },
      expected: "Value type definitions must be a vector of complete forms:",
    },
    {
      name: "extension fields",
      overrides: {
        extensionFields: `(${declarations.extensionFields.slice(1, -1)})`,
      },
      expected: "Extension field declarations must be a vector of complete forms.",
    },
  ];
  for (const testCase of cases) {
    const result = checkedBundle(source(testCase.overrides));
    const output = diagnostics(result);
    expect(result.exitCode, `${testCase.name}\n${output}`).not.toBe(0);
    expect(output, testCase.name).toContain(testCase.expected);
  }
}, 60_000);

test("list declarations compile while flat and vector forms retain source spans", () => {
  const parenthesized = join(
    fixtureRoot,
    "structural-declarations-parenthesized.bjs",
  );
  const cases = [
    {
      file: "structural-declarations-flat-state.bjs",
      macro: "wake/defstate-model",
      stray: "stray-state-value?",
      line: 12,
      col: 3,
      span: 18,
    },
    {
      file: "structural-declarations-flat-entity.bjs",
      macro: "wake/define-entity-model",
      stray: "stray-field-validator?",
      line: 22,
      col: 3,
      span: 22,
    },
    {
      file: "structural-declarations-flat-value-type.bjs",
      macro: "wake/defvalue-type",
      stray: "stray-value-type-validator?",
      line: 12,
      col: 3,
      span: 27,
    },
    {
      file: "structural-declarations-flat-extension.bjs",
      macro: "wake/extend-entity-fields",
      stray: "stray-extension-validator?",
      line: 22,
      col: 3,
      span: 26,
    },
    {
      file: "structural-declarations-vector-state.bjs",
      macro: "wake/defstate-model",
      stray: "[draft state/lifecycle/draft draft :draft]",
      line: 9,
      col: 3,
      span: 46,
    },
    {
      file: "structural-declarations-vector-transition.bjs",
      macro: "wake/defstate-model",
      stray: "[draft []]",
      line: 11,
      col: 3,
      span: 10,
    },
    {
      file: "structural-declarations-vector-entity.bjs",
      macro: "wake/define-entity-model",
      stray: "[id entity/item/id id String (wake/->StringField nil) (wake/->SingleField nil) (wake/->IdentityWrite nil) store/item/id true]",
      line: 11,
      col: 3,
      span: 163,
    },
    {
      file: "structural-declarations-vector-derived.bjs",
      macro: "wake/define-entity-model",
      stray: "[label entity/item/label label (wake/->StringDerivedExpr label) []]",
      line: 20,
      col: 3,
      span: 89,
    },
    {
      file: "structural-declarations-vector-value-type.bjs",
      macro: "wake/defvalue-type",
      stray: "[alias (wake/->StringValueType nil nil nil)]",
      line: 9,
      col: 3,
      span: 44,
    },
    {
      file: "structural-declarations-vector-extension.bjs",
      macro: "wake/extend-entity-fields",
      stray: "[extra fields/extra extra (wake/->StringField nil) (wake/->SingleField nil) (wake/->CreateWrite nil) store/item/extra true]",
      line: 12,
      col: 3,
      span: 157,
    },
  ];
  const parenthesizedResult = sourceDiagnostics([parenthesized]);
  expect(
    parenthesizedResult.exitCode,
    diagnostics(parenthesizedResult),
  ).toBe(0);

  for (const expected of cases) {
    const result = sourceDiagnostics([join(fixtureRoot, expected.file)]);
    const output = diagnostics(result);
    expect(result.exitCode, output).toBe(1);

    const found = parseJsonDiagnostics(result);
    expect(found, output).toHaveLength(1);
    const [diagnostic] = found;
    expect(
      typeof diagnostic.file === "string"
        && diagnostic.file.endsWith(expected.file),
      expected.file,
    ).toBe(true);
    expect(diagnostic.kind).toBe("macro-expansion-parse-error");
    expect(diagnostic["original-kind"]).toBe("macro-source-error");
    expect(diagnostic["macro-name"]).toBe(expected.macro);
    expect(diagnostic["stray-form"]).toBe(expected.stray);
    expect(diagnostic.line).toBe(expected.line);
    expect(diagnostic.col).toBe(expected.col);
    expect(diagnostic["error-span"]).toBe(expected.span);
  }
}, 60_000);

test("declaration macros reject flattened, stray, under-, and over-arity forms", () => {
  const cases = [
    {
      name: "flattened field metadata",
      overrides: {
        fields: `[(id "entity/item/id" "id" String
          (wake/->StringField nil)
          (wake/->SingleField nil)
          (wake/->IdentityWrite nil)
          "store/item/id"
          true)
         validator?]`,
      },
      expected: [
        "Invalid field declaration: validator?",
        "Each field must be one complete form:",
        "(name declaration-id public-name record-type value-type cardinality write-mode storage-id required)",
      ],
    },
    {
      name: "under-arity field",
      overrides: {
        fields: `[(id "entity/item/id" "id" String
          (wake/->StringField nil)
          (wake/->SingleField nil)
          (wake/->IdentityWrite nil)
          "store/item/id")]`,
      },
      expected: ["Invalid field declaration:", "Each field must be one complete form:"],
    },
    {
      name: "over-arity field",
      overrides: { fields: `[(${completeField.slice(1, -1)} validator?)]` },
      expected: ["Invalid field declaration:", "Each field must be one complete form:"],
    },
    {
      name: "under-arity state value",
      overrides: {
        values: `[(draft "state/lifecycle/draft" "draft")]`,
      },
      expected: ["Invalid state value declaration:", "(name declaration-id public-name keyword)"],
    },
    {
      name: "over-arity state value",
      overrides: {
        values: `[(draft "state/lifecycle/draft" "draft" :draft validator?)]`,
      },
      expected: [
        "Invalid state value declaration:",
        "(name declaration-id public-name keyword)",
      ],
    },
    {
      name: "flattened state value metadata",
      overrides: {
        values: `[(draft "state/lifecycle/draft" "draft" :draft)
          validator?]`,
      },
      expected: ["Invalid state value declaration: validator?"],
    },
    {
      name: "under-arity state transition",
      overrides: { transitions: "[(draft)]" },
      expected: ["Invalid state transition declaration:", "(from [to ...])"],
    },
    {
      name: "over-arity state transition",
      overrides: { transitions: "[(draft [] validator?)]" },
      expected: ["Invalid state transition declaration:", "(from [to ...])"],
    },
    {
      name: "invalid state transition destinations",
      overrides: { transitions: "[(draft validator?)]" },
      expected: ["Invalid state transition declaration:", "(from [to ...])"],
    },
    {
      name: "stray state transition",
      overrides: { transitions: "[validator?]" },
      expected: ["Invalid state transition declaration: validator?"],
    },
    {
      name: "under-arity derived field",
      overrides: {
        derivedFields: `[(label "entity/item/label" "label"
          (wake/->StringDerivedExpr "label"))]`,
      },
      expected: [
        "Invalid derived field declaration:",
        "(name declaration-id public-name expression dependencies)",
      ],
    },
    {
      name: "over-arity derived field",
      overrides: {
        derivedFields: `[(label "entity/item/label" "label"
          (wake/->StringDerivedExpr "label")
          []
          validator?)]`,
      },
      expected: ["Invalid derived field declaration:", "Each derived field must be one complete form:"],
    },
    {
      name: "stray derived field",
      overrides: { derivedFields: "[validator?]" },
      expected: ["Invalid derived field declaration: validator?"],
    },
    {
      name: "invalid derived field dependencies",
      overrides: {
        derivedFields: `[(label "entity/item/label" "label"
          (wake/->StringDerivedExpr "label")
          validator?)]`,
      },
      expected: [
        "Invalid derived field declaration:",
        "(name declaration-id public-name expression dependencies)",
      ],
    },
    {
      name: "under-arity value type definition",
      overrides: { definitions: "[(alias)]" },
      expected: ["Invalid value type definition:", "(name value-type)"],
    },
    {
      name: "over-arity value type definition",
      overrides: {
        definitions: `[(alias
          (wake/->StringValueType nil nil nil)
          validator?)]`,
      },
      expected: ["Invalid value type definition:", "(name value-type)"],
    },
    {
      name: "flattened value type definition metadata",
      overrides: {
        definitions: `[(alias (wake/->StringValueType nil nil nil))
          validator?]`,
      },
      expected: ["Invalid value type definition: validator?"],
    },
    {
      name: "flattened extension field metadata",
      overrides: {
        extensionFields: `[(extra "fields/extra" "extra"
          (wake/->StringField nil)
          (wake/->SingleField nil)
          (wake/->CreateWrite nil)
          "store/item/extra"
          true)
         validator?]`,
      },
      expected: [
        "Invalid extension field declaration: validator?",
        "(name declaration-id public-name value-type cardinality write-mode storage-id required)",
      ],
    },
    {
      name: "under-arity extension field",
      overrides: {
        extensionFields: `[(extra "fields/extra" "extra"
          (wake/->StringField nil)
          (wake/->SingleField nil)
          (wake/->CreateWrite nil)
          "store/item/extra")]`,
      },
      expected: ["Invalid extension field declaration:"],
    },
    {
      name: "over-arity extension field",
      overrides: {
        extensionFields: `[(extra "fields/extra" "extra"
          (wake/->StringField nil)
          (wake/->SingleField nil)
          (wake/->CreateWrite nil)
          "store/item/extra"
          validator?
          validator?)]`,
      },
      expected: ["Invalid extension field declaration:"],
    },
  ];

  for (const testCase of cases) {
    const result = checkedBundle(source(testCase.overrides));
    const output = diagnostics(result);
    expect(result.exitCode, `${testCase.name}\n${output}`).not.toBe(0);
    for (const expected of testCase.expected) {
      expect(output, testCase.name).toContain(expected);
    }
  }
}, 60_000);
