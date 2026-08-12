import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const webRoot = `${import.meta.dir}/..`;
const core = join(webRoot, "wake", "core.bjs");
const plugin = join(
  webRoot,
  "tests",
  "fixtures",
  "macro-provenance",
  "plugin.bjs",
);
const application = join(
  webRoot,
  "tests",
  "fixtures",
  "macro-provenance",
  "application.bjs",
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

function checkedAst(path) {
  return JSON.parse(runBeagle(["ast", path]));
}

function definition(ast, name) {
  const form = ast.forms.find((candidate) =>
    candidate.node === "def" && candidate.name === name);
  expect(form, `missing definition ${name}`).toBeDefined();
  return form;
}

function record(ast, name) {
  const form = ast.forms.find((candidate) =>
    candidate.node === "record" && candidate.name === name);
  expect(form, `missing record ${name}`).toBeDefined();
  return form;
}

function expectMacroGroup(ast, sourceText, macroName, expected) {
  const forms = expected.map(([name]) =>
    name === "Page" ? record(ast, name) : definition(ast, name));
  const source = forms[0].provenance.source;

  for (const [index, [name, type]] of expected.entries()) {
    const form = forms[index];
    expect(form.provenance.macroExpansion.chain, name).toEqual([
      { depth: 0, name: `wake/${macroName}` },
    ]);
    expect(form.provenance.source, name).toEqual(source);
    if (form.node === "def") {
      expect(form.value.inferredType, name).toEqual({ kind: "prim", name: type });
    }
  }

  expect(source).toMatchObject({ canonical: true, origin: "synthetic" });
  expect(Number.isSafeInteger(source.pos)).toBeTrue();
  expect(Number.isSafeInteger(source.span)).toBeTrue();
  const invocation = sourceText.slice(source.pos - 1, source.pos - 1 + source.span);
  expect(invocation.startsWith(`(wake/${macroName}`)).toBeTrue();
  expect(invocation.endsWith(")")).toBeTrue();
}

function literalArguments(form) {
  return form.value.args
    .filter((argument) => argument.node === "literal")
    .map((argument) => argument.value);
}

test("plugin declarations are typed products of exact Wake macro invocations", () => {
  runBeagle(["check", "--agent", core, plugin]);

  const source = readFileSync(plugin, "utf8");
  expect(source).not.toMatch(/\bprovenance-token\b|\(def provenance/u);
  expect(source).not.toContain("wake:macro:");
  const ast = checkedAst(plugin);

  expectMacroGroup(ast, source, "defcapability", [
    ["publish-ref", "CapabilityRef"],
    ["publish", "CapabilitySpec"],
  ]);
  expectMacroGroup(ast, source, "defstate-model", [
    ["revision-status-ref", "StateRef"],
    ["revision-status-draft-ref", "StateValueRef"],
    ["revision-status-draft", "StateValueSpec"],
    ["revision-status-published-ref", "StateValueRef"],
    ["revision-status-published", "StateValueSpec"],
    ["revision-status", "StateDeclarationSpec"],
  ]);
  expectMacroGroup(ast, source, "defentity-model", [
    ["Page", null],
    ["page-ref", "EntityRef"],
    ["page-id-ref", "FieldRef"],
    ["page-id", "FieldSpec"],
    ["page-title-ref", "FieldRef"],
    ["page-title", "FieldSpec"],
    ["page-status-ref", "FieldRef"],
    ["page-status", "FieldSpec"],
    ["page", "EntityDeclarationSpec"],
  ]);
  expectMacroGroup(ast, source, "defquery-model", [
    ["page-by-id-ref", "QueryRef"],
    ["page-by-id", "QueryDeclarationSpec"],
  ]);
  expectMacroGroup(ast, source, "defplugin", [
    ["wiki-plugin-identity", "PluginIdentity"],
    ["wiki-plugin", "PluginSpec"],
  ]);

  expect(literalArguments(definition(ast, "publish-ref"))).toEqual([
    "capability/publish",
    "publish",
    "wake:macro:capability:capability/publish",
  ]);
  expect(literalArguments(definition(ast, "revision-status-draft-ref"))).toEqual([
    "state/revision-status/value/draft",
    "draft",
    "wake:macro:state-value:state/revision-status/value/draft",
  ]);
  expect(literalArguments(definition(ast, "page-id-ref"))).toEqual([
    "entity/page/field/id",
    "id",
    "wake:macro:field:entity/page/field/id",
  ]);
  expect(literalArguments(definition(ast, "page-by-id-ref"))).toEqual([
    "query/page-by-id",
    "page-by-id",
    "wake:macro:query:query/page-by-id",
  ]);
  expect(literalArguments(definition(ast, "wiki-plugin-identity"))).toEqual([
    "dev.greywrought.wiki",
    "0.1.0",
    "0.1.x",
    1,
    1,
    "wake:macro:plugin:dev.greywrought.wiki@0.1.0",
  ]);
});

test("host declarations produce a typed plugin use and application root", () => {
  runBeagle(["check", "--agent", core, application]);

  const source = readFileSync(application, "utf8");
  expect(source).not.toMatch(/\bprovenance-token\b|\(def provenance/u);
  expect(source).not.toContain("wake:macro:");
  const ast = checkedAst(application);

  expectMacroGroup(ast, source, "use-plugin", [
    ["wiki-ref", "PluginUseRef"],
    ["wiki", "PluginUseSpec"],
    ["wiki-composition", "PluginComposition"],
  ]);
  expectMacroGroup(ast, source, "application-root", [
    ["application", "ApplicationRootSpec"],
  ]);
  expect(literalArguments(definition(ast, "wiki-ref"))).toEqual([
    "plugin-use/wiki",
    "wiki",
    "wake:macro:plugin-use:plugin-use/wiki",
  ]);
});
