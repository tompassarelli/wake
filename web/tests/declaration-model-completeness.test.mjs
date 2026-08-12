import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

const webRoot = `${import.meta.dir}/..`;
const core = join(webRoot, "wake", "core.bjs");
const ir = join(webRoot, "compiler", "ir.bjs");
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
  const form = program.forms.find((candidate) => candidate.name === name);
  expect(form, `missing internal model ${name}`).toBeDefined();
  return form;
}

function prim(name) {
  return { kind: "prim", name };
}

function vec(name) {
  return { kind: "app", name: "Vec", args: [prim(name)] };
}

function optional(name) {
  return { kind: "union", members: [prim(name), prim("Nil")] };
}

function fields(form) {
  return form.fields.map((field) => [field.name, field.ann]);
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
  ).toEqual([{ name: "target", ann: prim("EntityReferenceTarget") }]);
  expect(publicForm(program, "FieldWriteMode").members).toEqual([
    "IdentityWrite",
    "CreateWrite",
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
    { name: "state", ann: prim("StateRef") },
  ]);
  expect(valueTypes["member-fields"].EnumValueType).toEqual([
    { name: "allowed", ann: vec("ValueLiteral") },
  ]);
  expect(valueTypes["member-fields"].ListValueType).toEqual([
    { name: "item", ann: prim("ValueTypeSpec") },
    { name: "minimum-items", ann: optional("BoundInt") },
    { name: "maximum-items", ann: optional("BoundInt") },
    { name: "normalization", ann: optional("ListNormalization") },
  ]);
  expect(valueTypes["member-fields"].ExtensionValueType).toEqual([
    { name: "port", ann: prim("EntityFieldsPortRef") },
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
    ["target", prim("EntityRef")],
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
  ]);
  expect(JSON.stringify(declarationProgram)).not.toContain('"Any"');

  const mirrors = [
    "ConfigProjection",
    "EntityReferenceTarget",
    "ListNormalization",
    "ValueEnvelopeSpec",
    "EntityFieldsPortPolicy",
    "DefaultRouteTarget",
  ];
  const publicProgram = ast(core);
  for (const name of mirrors) {
    expect(publicForm(publicProgram, name).node).toBe(
      internalForm(program, `Ir${name}`).node,
    );
  }
});
