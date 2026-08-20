import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  CHECKED_DECLARATION_MODEL,
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
  application: join(webRoot, "tests", "fixtures", "macro-provenance", "application.bjs"),
  plugin: join(webRoot, "tests", "fixtures", "macro-provenance", "plugin.bjs"),
  wakeCore: join(webRoot, "wake", "core.bjs"),
  wakeIr: join(webRoot, "wake", "ir.bjs"),
});
const sourceIds = Object.freeze({
  application: "web/tests/fixtures/macro-provenance/application.bjs",
  plugin: "web/tests/fixtures/macro-provenance/plugin.bjs",
  wakeCore: "web/wake/core.bjs",
  wakeIr: "web/wake/ir.bjs",
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
const applicationBundle = checkedBundle(sourceIds.application, [
  suppliedSource(sourceIds.application, sourceText.application, "package"),
  suppliedSource(sourceIds.wakeCore, sourceText.wakeCore, "trusted"),
]);
const pluginBundle = checkedBundle(sourceIds.plugin, [
  suppliedSource(sourceIds.plugin, sourceText.plugin, "package"),
  suppliedSource(sourceIds.wakeCore, sourceText.wakeCore, "trusted"),
]);

function sourcesFor(bundle, irText = sourceText.wakeIr) {
  const available = {
    [sourceIds.application]: sourceText.application,
    [sourceIds.plugin]: sourceText.plugin,
    [sourceIds.wakeCore]: sourceText.wakeCore,
    [sourceIds.wakeIr]: irText,
  };
  const ids = new Set([
    ...bundle.modules.map((module) => module.sourceId),
    ...wakeCoreModelBundle.modules.map((module) => module.sourceId),
    ...wakeIrModelBundle.modules.map((module) => module.sourceId),
  ]);
  return Object.fromEntries([...ids].map((sourceId) => [sourceId, available[sourceId]]));
}

function decode(bundle, overrides = {}) {
  const irBundle = overrides.wakeIrModelBundle ?? wakeIrModelBundle;
  const irText = overrides.wakeIrText ?? sourceText.wakeIr;
  const sourceTexts = sourcesFor(bundle, irText);
  for (const module of irBundle.modules) sourceTexts[module.sourceId] = irText;
  return checkedDeclarationProgramFromBundle(bundle, {
    compilerVersion: "0.1.0",
    sourceTexts,
    wakeCoreModelBundle: overrides.wakeCoreModelBundle ?? wakeCoreModelBundle,
    wakeIrModelBundle: irBundle,
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
  const form = bundle.entryProjection.forms.find((candidate) =>
    candidate.node === "def" && candidate.name === name);
  if (form === undefined) throw new Error(`missing definition ${name}`);
  return form;
}

function mutate(bundle, change) {
  const changed = structuredClone(bundle);
  change(changed);
  return reseal(changed);
}

test("decodes exact plugin and application declaration graphs with source sidecars", () => {
  expect(CHECKED_DECLARATION_MODEL).toEqual({
    wakeCoreSourceSha256: sha256Digest(sourceText.wakeCore),
    wakeIrSourceSha256: sha256Digest(sourceText.wakeIr),
  });

  const plugin = decode(pluginBundle);
  expect(plugin).toMatchObject({
    _tag: "IrCheckedDeclarationProgram",
    program: {
      _tag: "IrDeclarationProgram",
      ns: "wake.fixtures.macro-provenance.plugin",
      root: {
        _tag: "IrPluginDeclarationRoot",
        plugin: {
          _tag: "IrPluginSpec",
          identity: {
            package_id: "dev.greywrought.wiki",
            provenance_token: "wake:macro:plugin:dev.greywrought.wiki@0.1.0",
            version: "0.1.0",
          },
        },
      },
    },
  });
  expect(plugin.program).toMatchObject({
    entities: [{ ref: { declaration_id: "entity/article" } }],
    states: [{ ref: { declaration_id: "state/revision-status" } }],
    value_types: [{ root: { declaration_id: "value-type/safe-document" } }],
    provider_ports: [{ ref: { declaration_id: "provider-port/content-parser" } }],
    renderers: [{ ref: { declaration_id: "renderer/safe-document" } }],
    capabilities: [{ ref: { declaration_id: "capability/browse-published" } }],
    queries: [{ ref: { declaration_id: "query/history-superseded" } }],
    commands: [{ ref: { declaration_id: "command/create-draft" } }],
    components: [{ ref: { declaration_id: "component/article-card" } }],
    views: [{ ref: { declaration_id: "view/history" } }],
    route_templates: [{ ref: { declaration_id: "route/history" } }],
    entity_fields_ports: [{ ref: { declaration_id: "entity-fields-port/revision-fields" } }],
    component_slots: [{ ref: { declaration_id: "component-slot/article-card" } }],
    route_slots: [{ ref: { declaration_id: "route-slot/history" } }],
  });
  expect(plugin.declaration_provenance).toHaveLength(30);
  expect(plugin.declaration_provenance[0]).toMatchObject({
    _tag: "IrDeclarationProvenance",
    kind: "command-receipt-core",
    name: "wake-command-receipt",
    provenance: {
      source: { source_id: sourceIds.plugin },
      span: { start_line: 5, start_column: 1 },
    },
  });

  const application = decode(applicationBundle);
  expect(application.program.root).toMatchObject({
    _tag: "IrApplicationDeclarationRoot",
    application: {
      _tag: "IrApplicationRootSpec",
      id: "greywrought-wiki",
      authority: { _tag: "IrStoreAuthority", service: "store" },
      plugins: [{
        use: {
          ref: {
            declaration_id: "plugin-use/wiki",
            provenance_token: "wake:macro:plugin-use:plugin-use/wiki",
          },
          package_id: "dev.greywrought.wiki",
          version: "0.1.0",
        },
      }],
    },
  });
  expect(application.declaration_provenance).toHaveLength(30);
});

test("requires the sealed compiler-owned provider, interface, and complete closure", () => {
  const forgedSource = structuredClone(applicationBundle);
  forgedSource.modules.find((module) => module.namespace === "wake.core")
    .sourceSha256 = `sha256:${"0".repeat(64)}`;
  reseal(forgedSource);
  expect(() => decode(forgedSource)).toThrow(
    "source digest does not match exact bytes for 'web/wake/core.bjs'",
  );

  const forgedInterface = structuredClone(applicationBundle);
  forgedInterface.modules.find((module) => module.namespace === "wake.core")
    .interfaceSha256 = `sha256:${"0".repeat(64)}`;
  reseal(forgedInterface);
  expect(() => decode(forgedInterface)).toThrow(
    "not closed over the compiler-owned trusted wake.core interface",
  );

  const missingProvider = structuredClone(applicationBundle);
  missingProvider.modules = missingProvider.modules.filter((module) =>
    module.namespace !== "wake.core");
  reseal(missingProvider);
  expect(() => decode(missingProvider)).toThrow(
    "not closed over the compiler-owned trusted wake.core interface",
  );
});

test("requires the sealed command receipt closure only for command-bearing programs", () => {
  const withoutReceipt = sourceText.plugin.replace(
    "(wake/command-receipt-core)\n\n",
    "",
  );
  const bundle = checkedBundle(sourceIds.plugin, [
    suppliedSource(sourceIds.plugin, withoutReceipt, "package"),
    suppliedSource(sourceIds.wakeCore, sourceText.wakeCore, "trusted"),
  ]);
  const sourceTexts = sourcesFor(bundle);
  sourceTexts[sourceIds.plugin] = withoutReceipt;
  expect(() => checkedDeclarationProgramFromBundle(bundle, {
    compilerVersion: "0.1.0",
    sourceTexts,
    wakeCoreModelBundle,
    wakeIrModelBundle,
  })).toThrow("declaration graph lacks its sealed command receipt closure");
}, 30_000);

test("rejects stale checked models and a valid-looking raw AST bypass", () => {
  const staleIrText = `${sourceText.wakeIr}\n; stale model bytes\n`;
  const staleIrBundle = checkedBundle(sourceIds.wakeIr, [
    suppliedSource(sourceIds.wakeIr, staleIrText, "trusted"),
  ]);
  expect(() => decode(applicationBundle, {
    wakeIrModelBundle: staleIrBundle,
    wakeIrText: staleIrText,
  })).toThrow("wake.ir model bundle is not the compiler-owned checked model");

  expect(() => checkedDeclarationProgramFromBundle(
    applicationBundle.entryProjection,
    {
      compilerVersion: "0.1.0",
      sourceTexts: sourcesFor(applicationBundle),
      wakeCoreModelBundle,
      wakeIrModelBundle,
    },
  )).toThrow("input bundle has unsupported fields");
});

test("rejects unsupported projections and missing, malformed, or non-null constraint slots", () => {
  const unsupportedBundle = structuredClone(applicationBundle);
  unsupportedBundle.schemaVersion = 0;
  reseal(unsupportedBundle);
  expect(() => decode(unsupportedBundle)).toThrow("input bundle is not a supported checked bundle");

  const unsupportedProjection = mutate(applicationBundle, (bundle) => {
    bundle.entryProjection.schemaVersion = 0;
  });
  expect(() => decode(unsupportedProjection)).toThrow(
    "input bundle entry projection is not a checked beagle/js projection",
  );

  const extraProjectionField = mutate(applicationBundle, (bundle) => {
    bundle.entryProjection.futureContract = null;
  });
  expect(() => decode(extraProjectionField)).toThrow(
    "input bundle entry projection has unsupported fields",
  );

  const malformedImport = mutate(applicationBundle, (bundle) => {
    bundle.entryProjection.imports = [null];
  });
  expect(() => decode(malformedImport)).toThrow(
    "input bundle entry projection import 1 must be a nonempty string",
  );

  const entityRecord = (bundle) => bundle.entryProjection.forms.find((form) =>
    form.node === "record" && form.name === "Principal");
  const missingConstraint = mutate(applicationBundle, (bundle) => {
    delete entityRecord(bundle).fields[0].constraint;
  });
  expect(() => decode(missingConstraint)).toThrow(
    "record 'Principal' field 1 has unsupported fields",
  );

  const constrainedRecord = mutate(applicationBundle, (bundle) => {
    entityRecord(bundle).fields[0].constraint = { node: "ref", name: "validator?" };
  });
  expect(() => decode(constrainedRecord)).toThrow(
    "record 'Principal' field 1 must have a null, nonsynchronous constraint in Wake's declaration model",
  );

  const missingSynchronization = mutate(applicationBundle, (bundle) => {
    delete entityRecord(bundle).fields[0].constraintSynchronous;
  });
  expect(() => decode(missingSynchronization)).toThrow(
    "record 'Principal' field 1 has unsupported fields",
  );

  for (const invalid of [true, "false"]) {
    const invalidSynchronization = mutate(applicationBundle, (bundle) => {
      entityRecord(bundle).fields[0].constraintSynchronous = invalid;
    });
    expect(() => decode(invalidSynchronization)).toThrow(
      "record 'Principal' field 1 must have a null, nonsynchronous constraint in Wake's declaration model",
    );
  }

  const constrainedCore = mutate(wakeCoreModelBundle, (bundle) => {
    const exportedRecord = bundle.entryProjection.forms.find((form) =>
      form.node === "js-export" && form.form.node === "record");
    exportedRecord.form.fields[0].constraint = { node: "ref", name: "validator?" };
  });
  expect(() => decode(applicationBundle, {
    wakeCoreModelBundle: constrainedCore,
  })).toThrow("public model");

  const missingUnionConstraint = mutate(wakeCoreModelBundle, (bundle) => {
    const exportedUnion = bundle.entryProjection.forms.find((form) =>
      form.node === "js-export" && form.form.node === "defunion");
    const firstFields = Object.values(exportedUnion.form["member-fields"])
      .find((fields) => fields.length > 0);
    delete firstFields[0].constraint;
  });
  expect(() => decode(applicationBundle, {
    wakeCoreModelBundle: missingUnionConstraint,
  })).toThrow("has unsupported fields");
});

test("rejects orphaned, duplicate, and mismatched plugin-use pairs", () => {
  const orphaned = mutate(applicationBundle, (bundle) => {
    const orphan = structuredClone(definition(bundle, "wiki-ref"));
    orphan.name = "orphan-ref";
    orphan.value.args[0].value = "plugin-use/orphan";
    orphan.value.args[1].value = "orphan";
    orphan.value.args[2].value = "wake:macro:plugin-use:plugin-use/orphan";
    bundle.entryProjection.forms.push(orphan);
  });
  expect(() => decode(orphaned)).toThrow(
    "plugin-use reference 'orphan-ref' must have exactly one matching use-plugin",
  );

  const duplicate = mutate(applicationBundle, (bundle) => {
    const use = structuredClone(definition(bundle, "wiki"));
    use.name = "wiki-copy";
    const composition = structuredClone(definition(bundle, "wiki-composition"));
    composition.name = "wiki-copy-composition";
    composition.value.args[0].name = "wiki-copy";
    bundle.entryProjection.forms.push(use, composition);
  });
  expect(() => decode(duplicate)).toThrow(
    "plugin-use reference 'wiki-ref' must have exactly one matching use-plugin",
  );

  const mismatched = mutate(applicationBundle, (bundle) => {
    const other = structuredClone(definition(bundle, "wiki-ref"));
    other.name = "other-ref";
    other.value.args[0].value = "plugin-use/other";
    other.value.args[1].value = "other";
    other.value.args[2].value = "wake:macro:plugin-use:plugin-use/other";
    definition(bundle, "wiki").value.args[0].name = "other-ref";
    bundle.entryProjection.forms.push(other);
  });
  expect(() => decode(mismatched)).toThrow(
    "plugin-use reference 'wiki-ref' must have exactly one matching use-plugin",
  );
});

test("rejects direct nominal construction and forged deterministic tokens", () => {
  const direct = mutate(applicationBundle, (bundle) => {
    delete definition(bundle, "wiki-ref").provenance.macroExpansion;
  });
  expect(() => decode(direct)).toThrow("directly constructs nominal PluginUseRef");

  const forgedToken = mutate(applicationBundle, (bundle) => {
    definition(bundle, "wiki-ref").value.args[2].value = "wake:macro:plugin-use:forged";
  });
  expect(() => decode(forgedToken)).toThrow("nondeterministic provenance token");
});
