import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const webRoot = `${import.meta.dir}/..`;
const repositoryRoot = join(webRoot, "..");
const coreSourceId = "web/wake/core.bjs";
const coreSource = readFileSync(join(repositoryRoot, coreSourceId), "utf8");
const entrySourceId = "web/tests/fixtures/structural-declarations.bjs";
const beagleRoot = process.env.BEAGLE_PROJECTION_ROOT
  ?? process.env.BEAGLE_ROOT
  ?? join(homedir(), "code", "beagle", "main");
const beagle = join(beagleRoot, "bin", "beagle");

const completeField = `[id "entity/item/id" "id" String
  (wake/->StringField nil)
  (wake/->SingleField nil)
  (wake/->IdentityWrite nil)
  "store/item/id"
  validator?]`;

const declarations = Object.freeze({
  values: `[[draft "state/lifecycle/draft" "draft" :draft]]`,
  transitions: "[[draft []]]",
  fields: `[${completeField}]`,
  derivedFields: `[[label "entity/item/label" "label"
    (wake/->StringDerivedExpr "label")
    []]]`,
  definitions: `[[alias (wake/->StringValueType nil nil nil)]]`,
  extensionFields: `[[extra "fields/extra" "extra"
    (wake/->StringField nil)
    (wake/->SingleField nil)
    (wake/->CreateWrite nil)
    "store/item/extra"
    validator?]]`,
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
    schemaVersion: 2,
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

test("complete declarations own every local metadata form", () => {
  const result = checkedBundle(source());
  expect(result.exitCode, diagnostics(result)).toBe(0);
}, 60_000);

test("declaration macros reject flattened, stray, under-, and over-arity forms", () => {
  const cases = [
    {
      name: "flattened field metadata",
      overrides: {
        fields: `[[id "entity/item/id" "id" String
          (wake/->StringField nil)
          (wake/->SingleField nil)
          (wake/->IdentityWrite nil)
          "store/item/id"]
         validator?]`,
      },
      expected: [
        "Invalid field declaration: validator?",
        "Each field must be one complete form:",
        "[name declaration-id public-name record-type value-type cardinality write-mode storage-id required]",
      ],
    },
    {
      name: "over-arity field",
      overrides: { fields: `[[${completeField.slice(1, -1)} validator?]]` },
      expected: ["Invalid field declaration:", "Each field must be one complete form:"],
    },
    {
      name: "over-arity state value",
      overrides: {
        values: `[[draft "state/lifecycle/draft" "draft" :draft validator?]]`,
      },
      expected: [
        "Invalid state value declaration:",
        "[name declaration-id public-name keyword]",
      ],
    },
    {
      name: "flattened state value metadata",
      overrides: {
        values: `[[draft "state/lifecycle/draft" "draft" :draft]
          validator?]`,
      },
      expected: ["Invalid state value declaration: validator?"],
    },
    {
      name: "under-arity state transition",
      overrides: { transitions: "[[draft]]" },
      expected: ["Invalid state transition declaration:", "[from [to ...]]"],
    },
    {
      name: "invalid state transition destinations",
      overrides: { transitions: "[[draft validator?]]" },
      expected: ["Invalid state transition declaration:", "[from [to ...]]"],
    },
    {
      name: "stray state transition",
      overrides: { transitions: "[validator?]" },
      expected: ["Invalid state transition declaration: validator?"],
    },
    {
      name: "under-arity derived field",
      overrides: {
        derivedFields: `[[label "entity/item/label" "label"
          (wake/->StringDerivedExpr "label")]]`,
      },
      expected: [
        "Invalid derived field declaration:",
        "[name declaration-id public-name expression dependencies]",
      ],
    },
    {
      name: "stray derived field",
      overrides: { derivedFields: "[validator?]" },
      expected: ["Invalid derived field declaration: validator?"],
    },
    {
      name: "invalid derived field dependencies",
      overrides: {
        derivedFields: `[[label "entity/item/label" "label"
          (wake/->StringDerivedExpr "label")
          validator?]]`,
      },
      expected: [
        "Invalid derived field declaration:",
        "[name declaration-id public-name expression dependencies]",
      ],
    },
    {
      name: "under-arity value type definition",
      overrides: { definitions: "[[alias]]" },
      expected: ["Invalid value type definition:", "[name value-type]"],
    },
    {
      name: "over-arity value type definition",
      overrides: {
        definitions: `[[alias
          (wake/->StringValueType nil nil nil)
          validator?]]`,
      },
      expected: ["Invalid value type definition:", "[name value-type]"],
    },
    {
      name: "flattened value type definition metadata",
      overrides: {
        definitions: `[[alias (wake/->StringValueType nil nil nil)]
          validator?]`,
      },
      expected: ["Invalid value type definition: validator?"],
    },
    {
      name: "flattened extension field metadata",
      overrides: {
        extensionFields: `[[extra "fields/extra" "extra"
          (wake/->StringField nil)
          (wake/->SingleField nil)
          (wake/->CreateWrite nil)
          "store/item/extra"]
         validator?]`,
      },
      expected: [
        "Invalid extension field declaration: validator?",
        "[name declaration-id public-name value-type cardinality write-mode storage-id required]",
      ],
    },
    {
      name: "over-arity extension field",
      overrides: {
        extensionFields: `[[extra "fields/extra" "extra"
          (wake/->StringField nil)
          (wake/->SingleField nil)
          (wake/->CreateWrite nil)
          "store/item/extra"
          validator?
          validator?]]`,
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
