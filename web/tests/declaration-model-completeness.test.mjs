import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

const webRoot = `${import.meta.dir}/..`;
const core = join(webRoot, "wake", "core.bjs");
const ir = join(webRoot, "wake", "ir.bjs");
const beagleRoot = process.env.BEAGLE_PROJECTION_ROOT
  ?? process.env.BEAGLE_ROOT
  ?? join(homedir(), "code", "beagle", "main");
const beagle = join(beagleRoot, "bin", "beagle");
const moduleRoot = ["--module-root", `web=${webRoot}`];

function runBeagle(args) {
  const result = Bun.spawnSync([beagle, args[0], ...moduleRoot, ...args.slice(1)], {
    cwd: webRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString();
}

function ast(path) {
  return JSON.parse(runBeagle(["ast", path]));
}

function publicForm(program, name) {
  const wrapper = program.forms.find((candidate) =>
    candidate.node === "js-export" && candidate.form?.name === name);
  expect(wrapper, `missing public model ${name}`).toBeDefined();
  return wrapper.form;
}

function internalForm(program, name) {
  const form = program.forms.find((candidate) =>
    (candidate.node === "js-export" ? candidate.form?.name : candidate.name) === name);
  expect(form, `missing internal model ${name}`).toBeDefined();
  return form.node === "js-export" ? form.form : form;
}

function prim(name) {
  return { kind: "prim", name };
}

function vec(name) {
  return { kind: "app", name: "Vec", args: [prim(name)] };
}

function map(key, value) {
  return { kind: "app", name: "Map", args: [prim(key), prim(value)] };
}

function optional(name) {
  return { kind: "union", members: [prim(name), prim("Nil")] };
}

function declarationField(name, ann) {
  return { name, ann, constraint: null, constraintSynchronous: false };
}

function fields(form) {
  return form.fields.map((field) => [field.name.replaceAll("_", "-"), field.ann]);
}

function normalizedType(type) {
  if (type.kind === "prim") {
    const lowered = type.name === "Keyword" ? "String" : type.name;
    return { ...type, name: lowered.replace(/^Ir/u, "") };
  }
  if (type.kind === "app") {
    return { ...type, args: type.args.map(normalizedType) };
  }
  if (type.kind === "union") {
    return { ...type, members: type.members.map(normalizedType) };
  }
  throw new Error(`unsupported type annotation ${JSON.stringify(type)}`);
}

function normalizedForm(form) {
  if (form.node === "record") {
    return {
      node: form.node,
      name: form.name.replace(/^Ir/u, ""),
      fields: form.fields.map((field) => ({
        ...field,
        name: field.name.replaceAll("_", "-"),
        ann: normalizedType(field.ann),
      })),
    };
  }
  if (form.node === "defunion") {
    return {
      node: form.node,
      name: form.name.replace(/^Ir/u, ""),
      "type-params": form["type-params"],
      members: form.members.map((member) => member.replace(/^Ir/u, "")),
      "member-fields": Object.fromEntries(
        Object.entries(form["member-fields"]).map(([member, memberFields]) => [
          member.replace(/^Ir/u, ""),
          memberFields.map((field) => ({
            ...field,
            name: field.name.replaceAll("_", "-"),
            ann: normalizedType(field.ann),
          })),
        ]),
      ),
    };
  }
  throw new Error(`unsupported model form ${form.node}`);
}

function reachableTypes(program, rootName) {
  const definitions = new Map(program.forms.map((candidate) =>
    candidate.node === "js-export" ? candidate.form : candidate)
    .filter((form) => typeof form?.name === "string")
    .map((form) => [form.name, form]));
  const reached = new Set();
  const encountered = new Set();

  function visitType(type) {
    if (type.kind === "prim") {
      encountered.add(type.name);
      visitDefinition(type.name);
      return;
    }
    if (type.kind === "app") {
      encountered.add(type.name);
      for (const argument of type.args) visitType(argument);
      return;
    }
    if (type.kind === "union") {
      for (const member of type.members) visitType(member);
      return;
    }
    throw new Error(`unsupported reachable type ${JSON.stringify(type)}`);
  }

  function visitDefinition(name) {
    if (reached.has(name) || !definitions.has(name)) return;
    reached.add(name);
    const form = definitions.get(name);
    for (const field of form.fields ?? []) visitType(field.ann);
    for (const memberFields of Object.values(form["member-fields"] ?? {})) {
      for (const field of memberFields) visitType(field.ann);
    }
  }

  visitDefinition(rootName);
  return { encountered, reached };
}

test("public declarations represent every wiki value and composition invariant", () => {
  runBeagle(["check", "--agent", core]);
  const program = ast(core);

  expect(fields(publicForm(program, "ConfigProjection"))).toEqual([
    ["role", prim("ValueRoleRef")],
    ["path", vec("String")],
  ]);
  expect(publicForm(program, "BoundInt")["member-fields"]).toMatchObject({
    ConfiguredBound: [{ name: "role", ann: prim("IntRoleRef") }],
    ConfiguredProjectionBound: [{
      name: "projection",
      ann: prim("ConfigProjection"),
    }],
  });

  expect(publicForm(program, "EntityReferenceTarget")).toMatchObject({
    members: ["DeclaredEntityTarget", "ExternalEntityTarget"],
    "member-fields": {
      DeclaredEntityTarget: [{ name: "entity", ann: prim("EntityRef") }],
      ExternalEntityTarget: [{
        name: "role",
        ann: prim("ExternalEntityRoleRef"),
      }],
    },
  });
  expect(
    publicForm(program, "FieldValueType")["member-fields"].RefField,
  ).toEqual([declarationField("target", prim("EntityReferenceTarget"))]);
  expect(publicForm(program, "FieldWriteMode").members).toEqual([
    "IdentityWrite",
    "CreateWrite",
    "SetWrite",
    "CommandFieldWrite",
    "ServerWrite",
  ]);

  const valueTypes = publicForm(program, "ValueTypeSpec");
  expect(valueTypes.members).toEqual([
    "StringValueType",
    "IntegerValueType",
    "BooleanValueType",
    "DigestValueType",
    "InstantValueType",
    "KeywordValueType",
    "EnumValueType",
    "EntityReferenceValueType",
    "StateValueType",
    "RecordValueType",
    "TaggedValueType",
    "ListValueType",
    "ExtensionValueType",
    "NullableValueType",
    "NamedValueType",
    "LiteralValueType",
  ]);
  expect(valueTypes["member-fields"].StateValueType).toEqual([
    declarationField("state", prim("StateRef")),
  ]);
  expect(valueTypes["member-fields"].EnumValueType).toEqual([
    declarationField("allowed", vec("ValueLiteral")),
  ]);
  expect(valueTypes["member-fields"].ListValueType).toEqual([
    declarationField("item", prim("ValueTypeSpec")),
    declarationField("minimum-items", optional("BoundInt")),
    declarationField("maximum-items", optional("BoundInt")),
    declarationField("normalization", optional("ListNormalization")),
  ]);
  expect(valueTypes["member-fields"].ExtensionValueType).toEqual([
    declarationField("port", prim("EntityFieldsPortRef")),
  ]);

  expect(fields(publicForm(program, "ValueEnvelopeSpec"))).toEqual([
    ["maximum-bytes", prim("BoundInt")],
    ["maximum-depth", prim("BoundInt")],
    ["maximum-nodes", prim("BoundInt")],
  ]);
  expect(fields(publicForm(program, "ValueTypeDeclarationSpec"))).toEqual([
    ["root", prim("ValueTypeRef")],
    ["definitions", vec("ValueTypeDefinition")],
    ["envelope", optional("ValueEnvelopeSpec")],
  ]);

  expect(publicForm(program, "CommandExpr").members).toContain(
    "CommandConfiguredExpr",
  );
  expect(publicForm(program, "CommandExpr")["member-fields"]).toMatchObject({
    CommandConfiguredExpr: [{
      name: "projection",
      ann: prim("ConfigProjection"),
    }],
    CommandStateValueExpr: [{ name: "value", ann: prim("StateValueRef") }],
  });
  expect(publicForm(program, "ListNormalization")).toMatchObject({
    members: ["SortUniqueList"],
  });
  expect(fields(publicForm(program, "CommandInputField"))).toEqual([
    ["name", prim("Keyword")],
    ["value-type", prim("ValueTypeSpec")],
  ]);

  expect(publicForm(program, "QueryValueExpr")["member-fields"]).toMatchObject({
    QueryConfiguredValue: [{
      name: "projection",
      ann: prim("ConfigProjection"),
    }],
    QueryStateValue: [{ name: "value", ann: prim("StateValueRef") }],
  });
  expect(publicForm(program, "QueryPredicateSpec")["member-fields"])
    .toMatchObject({
      QueryNonNullPredicate: [{
        name: "value",
        ann: prim("QueryValueExpr"),
      }],
    });

  expect(publicForm(program, "EntityFieldsPortPolicy")).toMatchObject({
    members: ["ClosedEntityFieldsPort", "OpenManyEntityFields"],
    "member-fields": {
      OpenManyEntityFields: [
        { name: "write", ann: prim("FieldWriteMode") },
        { name: "require-storage-id", ann: prim("Bool") },
      ],
    },
  });
  expect(fields(publicForm(program, "EntityFieldsPortSpec"))).toEqual([
    ["ref", prim("EntityFieldsPortRef")],
    ["target", prim("EntityFieldsTarget")],
    ["requirements", vec("FieldRequirement")],
    ["policy", prim("EntityFieldsPortPolicy")],
  ]);

  expect(publicForm(program, "DefaultRouteTarget")).toMatchObject({
    members: ["LocalDefaultRoute", "MountedDefaultRoute"],
  });
  expect(fields(publicForm(program, "ApplicationRootSpec"))).toEqual([
    ["id", prim("String")],
    ["authority", prim("AuthoritySpec")],
    ["storage", vec("StorageSpec")],
    ["identities", vec("IdentitySpec")],
    ["plugins", vec("PluginComposition")],
    ["default-route", optional("DefaultRouteTarget")],
    ["theme", optional("ThemeSpec")],
    ["publications", vec("PublicationRef")],
    ["forms", vec("FormRef")],
    ["list-details", vec("ListDetailRef")],
  ]);
  expect(fields(publicForm(program, "PluginSpec"))).toEqual([
    ["identity", prim("PluginIdentity")],
    ["contributions", vec("ContributionKind")],
    ["configuration", prim("PluginConfigurationSchema")],
    ["exports", prim("PluginExports")],
    ["required-providers", vec("ProviderPortRef")],
    ["migrations", vec("MigrationSpec")],
    ["default-route", optional("RouteTemplateRef")],
  ]);
});

test("internal declaration program is closed and mirrors the public model", () => {
  runBeagle(["check", "--agent", ir]);
  const program = ast(ir);

  const declarationRoot = internalForm(program, "IrDeclarationRoot");
  expect(declarationRoot).toMatchObject({
    members: ["IrPluginDeclarationRoot", "IrApplicationDeclarationRoot"],
    "member-fields": {
      IrPluginDeclarationRoot: [{
        name: "plugin",
        ann: prim("IrPluginSpec"),
      }],
      IrApplicationDeclarationRoot: [{
        name: "application",
        ann: prim("IrApplicationRootSpec"),
      }],
    },
  });

  const declarationProgram = internalForm(program, "IrDeclarationProgram");
  expect(fields(declarationProgram)).toEqual([
    ["source-unit", prim("IrSourceUnit")],
    ["ns", prim("String")],
    ["root", prim("IrDeclarationRoot")],
    ["entities", vec("IrEntityDeclarationSpec")],
    ["states", vec("IrStateDeclarationSpec")],
    ["publications", vec("IrPublicationDeclarationSpec")],
    ["forms", vec("IrFormDeclarationSpec")],
    ["list-details", vec("IrListDetailDeclarationSpec")],
    ["value-types", vec("IrValueTypeDeclarationSpec")],
    ["provider-ports", vec("IrProviderPortSpec")],
    ["renderers", vec("IrRendererSpec")],
    ["capabilities", vec("IrCapabilitySpec")],
    ["queries", vec("IrQueryDeclarationSpec")],
    ["commands", vec("IrCommandSpec")],
    ["components", vec("IrComponentDeclarationSpec")],
    ["views", vec("IrViewDeclarationSpec")],
    ["route-templates", vec("IrRouteTemplateSpec")],
    ["entity-fields-ports", vec("IrEntityFieldsPortSpec")],
    ["component-slots", vec("IrComponentSlotSpec")],
    ["route-slots", vec("IrRouteSlotSpec")],
    ["receipt-entity", optional("IrReceiptEntitySpec")],
    ["receipt-fields", vec("IrReceiptFieldDeclarationSpec")],
  ]);
  const graph = reachableTypes(program, "IrDeclarationProgram");
  expect(graph.reached.size).toBe(167);
  expect(graph.encountered.has("Any")).toBeFalse();

  expect(fields(internalForm(program, "IrCheckedDeclarationProgram"))).toEqual([
    ["program", prim("IrDeclarationProgram")],
    ["declaration-provenance", vec("IrDeclarationProvenance")],
  ]);

  const mirrors = [
    "EntityReferenceTarget",
    "FieldValueType",
    "FieldWriteMode",
    "ConfigProjection",
    "CommandExpr",
    "CommandInputField",
    "ValueExpr",
    "ListNormalization",
    "ValueTypeSpec",
    "ValueEnvelopeSpec",
    "ValueTypeDeclarationSpec",
    "QueryValueExpr",
    "QueryPredicateSpec",
    "EntityFieldsPortPolicy",
    "EntityFieldsPortSpec",
    "BoundInt",
    "PluginSpec",
    "DefaultRouteTarget",
    "ApplicationRootSpec",
  ];
  const publicProgram = ast(core);
  for (const name of mirrors) {
    expect(normalizedForm(internalForm(program, `Ir${name}`)), name).toEqual(
      normalizedForm(publicForm(publicProgram, name)),
    );
  }
}, 30_000);

test("internal declaration extension atoms preserve their exact ownership domains", () => {
  const program = ast(ir);
  const nominalFields = [
    ["declaration-id", prim("String")],
    ["name", prim("String")],
    ["provenance-token", prim("String")],
  ];
  for (const name of [
    "IrPublicationRef",
    "IrFormRef",
    "IrListDetailRef",
    "IrReceiptEntityRef",
    "IrReceiptFieldRef",
    "IrExtensionFieldRef",
  ]) {
    expect(fields(internalForm(program, name)), name).toEqual(nominalFields);
  }

  for (const name of [
    "IrEntityDeclarationName",
    "IrFieldDeclarationName",
    "IrStateDeclarationName",
    "IrStateValueDeclarationName",
  ]) {
    expect(fields(internalForm(program, name)), name).toEqual([
      ["value", prim("String")],
    ]);
  }

  expect(fields(internalForm(program, "IrReceiptEntitySpec"))).toEqual([
    ["ref", prim("IrReceiptEntityRef")],
    ["storage-id", prim("String")],
  ]);
  expect(fields(internalForm(program, "IrReceiptFieldDeclarationSpec"))).toEqual([
    ["ref", prim("IrReceiptFieldRef")],
    ["owner", prim("IrReceiptEntityRef")],
    ["value-type", prim("IrValueTypeSpec")],
    ["target", optional("IrEntityRef")],
    ["storage-id", prim("String")],
  ]);
  expect(fields(internalForm(program, "IrExtensionFieldSpec"))).toEqual([
    ["ref", prim("IrExtensionFieldRef")],
    ["value-type", prim("IrFieldValueType")],
    ["cardinality", prim("IrFieldCardinality")],
    ["write", prim("IrFieldWriteMode")],
    ["storage-id", prim("String")],
    ["required", prim("Bool")],
  ]);
  expect(fields(internalForm(program, "IrThemeSpec"))).toEqual([
    ["colors", map("String", "String")],
  ]);

  expect(fields(internalForm(program, "IrPublicationDeclarationSpec"))).toEqual([
    ["ref", prim("IrPublicationRef")],
    ["owner", prim("IrEntityRef")],
    ["pointer", prim("IrFieldRef")],
    ["revision", prim("IrEntityRef")],
    ["owner-field", prim("IrFieldRef")],
    ["state-field", prim("IrFieldRef")],
    ["draft", prim("IrStateValueRef")],
    ["published", prim("IrStateValueRef")],
    ["retired", prim("IrStateValueRef")],
  ]);
  expect(internalForm(program, "IrFormSuccessAction")).toMatchObject({
    members: ["IrClearFormSuccess"],
  });
  expect(fields(internalForm(program, "IrFormDeclarationSpec"))).toEqual([
    ["ref", prim("IrFormRef")],
    ["entity", prim("IrEntityRef")],
    ["fields", vec("IrFieldRef")],
    ["required", vec("IrFieldRef")],
    ["submit-label", prim("String")],
    ["on-success", prim("IrFormSuccessAction")],
  ]);
  expect(internalForm(program, "IrListDetailTabSpec")).toMatchObject({
    members: ["IrFieldsDetailTab", "IrRelatedDetailTab"],
    "member-fields": {
      IrFieldsDetailTab: [
        { name: "label", ann: prim("String") },
        { name: "fields", ann: vec("IrFieldRef") },
      ],
      IrRelatedDetailTab: [
        { name: "label", ann: prim("String") },
        { name: "entity", ann: prim("IrEntityRef") },
        { name: "relation", ann: prim("IrFieldRef") },
        { name: "display", ann: vec("IrFieldRef") },
      ],
    },
  });
  expect(fields(internalForm(program, "IrListDetailDeclarationSpec"))).toEqual([
    ["ref", prim("IrListDetailRef")],
    ["entity", prim("IrEntityRef")],
    ["title", prim("String")],
    ["columns", vec("IrFieldRef")],
    ["search", vec("IrFieldRef")],
    ["detail-tabs", vec("IrListDetailTabSpec")],
  ]);
  expect(internalForm(program, "IrUiAction")).toMatchObject({
    members: ["IrSetFieldAction"],
    "member-fields": {
      IrSetFieldAction: [
        { name: "field", ann: prim("IrFieldRef") },
        { name: "value", ann: prim("IrValueExpr") },
      ],
    },
  });
});
