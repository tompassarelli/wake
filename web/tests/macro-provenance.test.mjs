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

function executeGeneratedFixture(path, namespacePath) {
  runBeagle(["build", "--target", "js", path]);
  const generated = join(beagleRoot, ".beagle-out", ...namespacePath) + ".js";
  const result = Bun.spawnSync([process.execPath, generated], {
    cwd: webRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

function definition(ast, name) {
  const form = ast.forms.find((candidate) =>
    candidate.node === "def" && candidate.name === name);
  expect(form, `missing definition ${name}`).toBeDefined();
  return form;
}

function descriptor(form) {
  return [
    form.node,
    form.name,
    form.node === "def" ? form.value.inferredType.name : null,
  ];
}

function macroInventory(ast, source) {
  const groups = [];
  for (const form of ast.forms) {
    const chain = form.provenance?.macroExpansion?.chain;
    if (chain === undefined) continue;
    expect(chain).toHaveLength(1);
    const sourceRange = form.provenance.source;
    const previous = groups.at(-1);
    if (previous?.source.pos === sourceRange.pos) {
      expect(sourceRange).toEqual(previous.source);
      expect(chain).toEqual(previous.chain);
      previous.outputs.push(descriptor(form));
      continue;
    }
    const invocation = source.slice(
      sourceRange.pos - 1,
      sourceRange.pos - 1 + sourceRange.span,
    );
    expect(sourceRange).toMatchObject({ canonical: true, origin: "synthetic" });
    expect(invocation.startsWith(`(${chain[0].name}`)).toBeTrue();
    expect(invocation.endsWith(")")).toBeTrue();
    groups.push({
      chain,
      source: sourceRange,
      macro: chain[0].name.replace("wake/", ""),
      outputs: [descriptor(form)],
    });
  }
  return groups.map(({ macro, outputs }) => [macro, outputs]);
}

function def(name, type) {
  return ["def", name, type];
}

function record(name) {
  return ["record", name, null];
}

const pluginInventory = [
  ["defcapability", [
    def("browse-published-ref", "CapabilityRef"),
    def("browse-published", "CapabilitySpec"),
  ]],
  ["defstate-model", [
    def("revision-status-ref", "StateRef"),
    def("revision-status-draft-ref", "StateValueRef"),
    def("revision-status-draft", "StateValueSpec"),
    def("revision-status-published-ref", "StateValueRef"),
    def("revision-status-published", "StateValueSpec"),
    def("revision-status-superseded-ref", "StateValueRef"),
    def("revision-status-superseded", "StateValueSpec"),
    def("revision-status", "StateDeclarationSpec"),
  ]],
  ["defexternal-entity-role", [
    def("actor-entity-ref", "ExternalEntityRoleRef"),
    def("actor-entity", "ExternalEntityRoleSpec"),
  ]],
  ["defentity-model", [
    record("Article"),
    def("article-ref", "EntityRef"),
    ...[
      "id",
      "title",
      "links-to",
      "author",
      "published-at",
      "digest",
      "status",
    ].flatMap((name) => [
      def(`article-${name}-ref`, "FieldRef"),
      def(`article-${name}-spec`, "FieldSpec"),
    ]),
    def("article", "EntityDeclarationSpec"),
  ]],
  ["defvalue-role", [
    def("safe-document-limits-ref", "ValueRoleRef"),
    def("safe-document-limits", "ValueRoleSpec"),
  ]],
  ["defvalue-type", [
    def("safe-document-ref", "ValueTypeRef"),
    def("safe-document-block-ref", "ValueTypeRef"),
    def("safe-document-definition", "ValueTypeDefinition"),
    def("safe-document-block-definition", "ValueTypeDefinition"),
    def("safe-document", "ValueTypeDeclarationSpec"),
  ]],
  ["defprovider-port", [
    def("content-parser-ref", "ProviderPortRef"),
    def("content-parser", "ProviderPortSpec"),
  ]],
  ["defentity-fields-port", [
    def("revision-fields-ref", "EntityFieldsPortRef"),
    def("revision-fields", "EntityFieldsPortSpec"),
  ]],
  ["defcommand", [
    def("create-draft-ref", "CommandRef"),
    def("create-draft", "CommandSpec"),
  ]],
  ["defquery-model", [
    def("history-superseded-ref", "QueryRef"),
    def("history-superseded", "QueryDeclarationSpec"),
  ]],
  ["defcomponent-model", [
    def("article-card-ref", "ComponentRef"),
    def("article-card", "ComponentDeclarationSpec"),
  ]],
  ["defrenderer", [
    def("safe-document-renderer-ref", "RendererRef"),
    def("safe-document-renderer", "RendererSpec"),
  ]],
  ["defview-model", [
    def("history-view-ref", "ViewRef"),
    def("history-view", "ViewDeclarationSpec"),
  ]],
  ["defroute-template", [
    def("history-route-ref", "RouteTemplateRef"),
    def("history-route", "RouteTemplateSpec"),
  ]],
  ["defcomponent-slot", [
    def("article-card-slot-ref", "ComponentSlotRef"),
    def("article-card-slot", "ComponentSlotSpec"),
  ]],
  ["defroute-slot", [
    def("history-slot-ref", "RouteSlotRef"),
    def("history-slot", "RouteSlotSpec"),
  ]],
  ...[
    ["defint-role", "page-limit", "IntRoleRef", "IntRoleSpec"],
    ["defstring-role", "site-title", "StringRoleRef", "StringRoleSpec"],
    ["defbool-role", "show-history", "BoolRoleRef", "BoolRoleSpec"],
    ["defkeyword-role", "draft-label", "KeywordRoleRef", "KeywordRoleSpec"],
    [
      "defentity-name-role",
      "resource-entity",
      "EntityNameRoleRef",
      "EntityNameRoleSpec",
    ],
    ["deffield-name-role", "title-field", "FieldNameRoleRef", "FieldNameRoleSpec"],
    ["defstate-name-role", "lifecycle", "StateNameRoleRef", "StateNameRoleSpec"],
    [
      "defstate-value-name-role",
      "published-state",
      "StateValueNameRoleRef",
      "StateValueNameRoleSpec",
    ],
    ["defvalue-role", "content-limits", "ValueRoleRef", "ValueRoleSpec"],
  ].map(([macro, name, refType, specType]) => [macro, [
    def(`${name}-ref`, refType),
    def(name, specType),
  ]]),
  ["defplugin-configuration", [
    def("plugin-configuration", "PluginConfigurationSchema"),
  ]],
  ["defplugin-exports", [def("plugin-exports", "PluginExports")]],
  ["defplugin", [
    def("wiki-plugin-identity", "PluginIdentity"),
    def("wiki-plugin", "PluginSpec"),
  ]],
];

const applicationInventory = [
  ["defstate-model", [
    def("publication-state-ref", "StateRef"),
    def("publication-state-working-ref", "StateValueRef"),
    def("publication-state-working", "StateValueSpec"),
    def("publication-state-released-ref", "StateValueRef"),
    def("publication-state-released", "StateValueSpec"),
    def("publication-state", "StateDeclarationSpec"),
  ]],
  ["defentity-model", [
    record("Principal"),
    def("principal-ref", "EntityRef"),
    def("principal-id-ref", "FieldRef"),
    def("principal-id-spec", "FieldSpec"),
    def("principal-display-name-ref", "FieldRef"),
    def("principal-display-name-spec", "FieldSpec"),
    def("principal", "EntityDeclarationSpec"),
  ]],
  ["defentity-model", [
    record("Article"),
    def("article-ref", "EntityRef"),
    ...["id", "title", "kind", "status"].flatMap((name) => [
      def(`article-${name}-ref`, "FieldRef"),
      def(`article-${name}-spec`, "FieldSpec"),
    ]),
    def("article", "EntityDeclarationSpec"),
  ]],
  ["defcomponent-model", [
    def("greywrought-card-ref", "ComponentRef"),
    def("greywrought-card", "ComponentDeclarationSpec"),
  ]],
  ["defplugin-use", [def("wiki-ref", "PluginUseRef")]],
  ...[
    ["imported-int-binding", "wiki-page-limit", "ImportedIntRoleRef", "IntBinding"],
    [
      "imported-string-binding",
      "wiki-site-title",
      "ImportedStringRoleRef",
      "StringBinding",
    ],
    ["imported-bool-binding", "wiki-show-history", "ImportedBoolRoleRef", "BoolBinding"],
    [
      "imported-keyword-binding",
      "wiki-draft-label",
      "ImportedKeywordRoleRef",
      "KeywordBinding",
    ],
    [
      "imported-entity-name-binding",
      "wiki-resource-entity",
      "ImportedEntityNameRoleRef",
      "EntityNameBinding",
    ],
    [
      "imported-field-name-binding",
      "wiki-title-field",
      "ImportedFieldNameRoleRef",
      "FieldNameBinding",
    ],
    [
      "imported-state-name-binding",
      "wiki-lifecycle",
      "ImportedStateNameRoleRef",
      "StateNameBinding",
    ],
    [
      "imported-state-value-name-binding",
      "wiki-published-state",
      "ImportedStateValueNameRoleRef",
      "StateValueNameBinding",
    ],
    [
      "imported-external-entity-binding",
      "wiki-actor-entity",
      "ImportedExternalEntityRoleRef",
      "ExternalEntityBinding",
    ],
    [
      "imported-value-binding",
      "wiki-safe-document-limits",
      "ImportedValueRoleRef",
      "ValueBinding",
    ],
    [
      "imported-value-binding",
      "wiki-content-limits",
      "ImportedValueRoleRef",
      "ValueBinding",
    ],
  ].map(([macro, name, refType, bindingType]) => [macro, [
    def(`${name}-ref`, refType),
    def(name, bindingType),
  ]]),
  ["defplugin-bindings", [def("plugin-bindings", "PluginBindings")]],
  ["bind-provider", [
    def("content-provider-ref", "ImportedProviderPortRef"),
    def("content-provider", "ProviderBindingSpec"),
  ]],
  ["extend-entity-fields", [
    def("article-fields-extension-ref", "ImportedEntityFieldsPortRef"),
    def("article-fields-extension", "ExtendSpec"),
  ]],
  ["fill-component-slot", [
    def("article-card-fill-ref", "ImportedComponentSlotRef"),
    def("article-card-fill", "FillSpec"),
  ]],
  ["mount-route-slot", [
    def("history-mount-ref", "ImportedRouteSlotRef"),
    def("history-mount", "MountSpec"),
  ]],
  ["use-plugin", [
    def("wiki", "PluginUseSpec"),
    def("wiki-composition", "PluginComposition"),
  ]],
  ["application-root", [def("application", "ApplicationRootSpec")]],
];

const tokenPrefixes = new Map([
  ["CapabilityRef", "capability"],
  ["StateRef", "state"],
  ["StateValueRef", "state-value"],
  ["EntityRef", "entity"],
  ["FieldRef", "field"],
  ["ValueTypeRef", "value-type"],
  ["ProviderPortRef", "provider-port"],
  ["RendererRef", "renderer"],
  ["QueryRef", "query"],
  ["CommandRef", "command"],
  ["ComponentRef", "component"],
  ["ViewRef", "view"],
  ["RouteTemplateRef", "route-template"],
  ["EntityFieldsPortRef", "entity-fields-port"],
  ["ComponentSlotRef", "component-slot"],
  ["RouteSlotRef", "route-slot"],
  ["PluginUseRef", "plugin-use"],
  ["IntRoleRef", "int-role"],
  ["StringRoleRef", "string-role"],
  ["BoolRoleRef", "bool-role"],
  ["KeywordRoleRef", "keyword-role"],
  ["EntityNameRoleRef", "entity-name-role"],
  ["FieldNameRoleRef", "field-name-role"],
  ["StateNameRoleRef", "state-name-role"],
  ["StateValueNameRoleRef", "state-value-name-role"],
  ["ExternalEntityRoleRef", "external-entity-role"],
  ["ValueRoleRef", "value-role"],
  ["ImportedIntRoleRef", "imported-int"],
  ["ImportedStringRoleRef", "imported-string"],
  ["ImportedBoolRoleRef", "imported-bool"],
  ["ImportedKeywordRoleRef", "imported-keyword"],
  ["ImportedEntityNameRoleRef", "imported-entity-name"],
  ["ImportedFieldNameRoleRef", "imported-field-name"],
  ["ImportedStateNameRoleRef", "imported-state-name"],
  ["ImportedStateValueNameRoleRef", "imported-state-value-name"],
  ["ImportedExternalEntityRoleRef", "imported-external-entity"],
  ["ImportedValueRoleRef", "imported-value"],
  ["ImportedProviderPortRef", "imported-provider"],
  ["ImportedEntityFieldsPortRef", "imported-entity-fields"],
  ["ImportedComponentSlotRef", "imported-component-slot"],
  ["ImportedRouteSlotRef", "imported-route-slot"],
]);

function literalArguments(form) {
  return form.value.args
    .filter((argument) => argument.node === "literal")
    .map((argument) => argument.value);
}

function expectDeterministicTokens(ast) {
  for (const form of ast.forms) {
    if (form.node !== "def") continue;
    const type = form.value.inferredType?.name;
    const prefix = tokenPrefixes.get(type);
    if (prefix === undefined) continue;
    const literals = literalArguments(form);
    expect(literals.at(-1), form.name).toBe(
      `wake:macro:${prefix}:${literals[0]}`,
    );
  }

  const identity = ast.forms.find((form) =>
    form.node === "def" && form.value.inferredType?.name === "PluginIdentity");
  if (identity !== undefined) {
    const literals = literalArguments(identity);
    expect(literals.at(-1)).toBe(
      `wake:macro:plugin:${literals[0]}@${literals[1]}`,
    );
  }
}

function walk(value, visitor) {
  if (value === null || typeof value !== "object") return;
  visitor(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visitor);
    return;
  }
  for (const nested of Object.values(value)) walk(nested, visitor);
}

function typedCalls(ast) {
  const names = new Set();
  walk(ast.forms, (node) => {
    if (node.node === "call" && typeof node.inferredType?.name === "string") {
      names.add(node.inferredType.name.replace(/^wake\//u, ""));
    }
  });
  return names;
}

function expectNoForgedNominalRefs(source) {
  const nominal = [...tokenPrefixes.keys()].join("|");
  expect(source).not.toMatch(new RegExp(`wake/->(?:${nominal})\\b`, "u"));
  expect(source).not.toMatch(
    /wake\/->(?:PluginConfigurationSchema|PluginExports|PluginBindings)\b/u,
  );
  expect(source).not.toContain("wake:macro:");
  expect(source).not.toMatch(/\bprovenance-token\b|\(def provenance/u);
}

test("wiki-shaped plugin declarations have an exact macro-owned inventory", () => {
  runBeagle(["check", "--agent", core, plugin]);
  const source = readFileSync(plugin, "utf8");
  const ast = checkedAst(plugin);

  expectNoForgedNominalRefs(source);
  expect(macroInventory(ast, source)).toEqual(pluginInventory);
  expectDeterministicTokens(ast);

  const represented = typedCalls(ast);
  for (const type of [
    "ValueEnvelopeSpec",
    "ConfiguredProjectionBound",
    "CommandConfiguredExpr",
    "ExternalEntityTarget",
    "DigestValueType",
    "InstantValueType",
    "StateValueType",
    "CommandStateValueExpr",
    "QueryStateValue",
    "SortUniqueList",
    "ExtensionValueType",
    "OpenManyEntityFields",
    "QueryNonNullPredicate",
    "EnumValueType",
  ]) {
    expect(represented.has(type), `missing ${type}`).toBeTrue();
  }

  expect(definition(ast, "wiki-plugin").value.args.at(-1)).toMatchObject({
    node: "ref",
    name: "history-route-ref",
  });
  expect(definition(ast, "history-superseded").value.args[4].items[1])
    .toMatchObject({ inferredType: { kind: "prim", name: "QueryNonNullPredicate" } });
  executeGeneratedFixture(
    plugin,
    ["wake", "fixtures", "macro-provenance", "plugin"],
  );
});

test("wiki-shaped host owns all imported bindings and nonempty composition", () => {
  runBeagle(["check", "--agent", core, application]);
  const source = readFileSync(application, "utf8");
  const ast = checkedAst(application);

  expectNoForgedNominalRefs(source);
  expect(macroInventory(ast, source)).toEqual(applicationInventory);
  expectDeterministicTokens(ast);

  const composition = definition(ast, "wiki-composition").value;
  expect(composition.args.slice(1).map((argument) =>
    argument.items.map((item) => item.name))).toEqual([
    ["content-provider"],
    ["article-fields-extension"],
    ["article-card-fill"],
    ["history-mount"],
  ]);
  expect(definition(ast, "application").value.args.at(-1)).toMatchObject({
    inferredType: { kind: "prim", name: "MountedDefaultRoute" },
  });
  executeGeneratedFixture(
    application,
    ["wake", "fixtures", "macro-provenance", "application"],
  );
});
