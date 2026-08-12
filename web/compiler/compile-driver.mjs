import {
  canonicalDocument,
  parseCanonicalDocument,
  sha256Digest,
} from "./canonical.mjs";
import {
  pluginContractVersions,
  readPluginArtifactFile,
  validateWakeLock,
} from "./plugin-package.mjs";
import {
  checkPluginConfiguration,
  configurationDeclarationIndex,
} from "./plugin-configuration.mjs";
import { checkCommandGraph } from "./command-contract.mjs";
import { generateDeploymentReceipt } from "./deployment-receipt.mjs";
import { programFromCheckedAst } from "./checked-beagle.mjs";

const DRIVER_SCHEMA_VERSION = 1;
const FRAM_PLAN_SCHEMA_VERSION = 2;
const HTTP_OPERATION_PROTOCOL_VERSION = 2;
const COMPILER_NAME = "wake";
const COMMAND_RECEIPT_ENTITY = "wake.core/command-receipt";
const COMMAND_RECEIPT_STORAGE_ID = "wake/core/entity/command-receipt";
const COMMAND_RECEIPT_FIELDS = Object.freeze({
  actor: "wake/core/field/command-receipt/actor",
  command: "wake/core/field/command-receipt/command",
  "created-at": "wake/core/field/command-receipt/created-at",
  id: "wake/core/field/command-receipt/id",
  "input-digest": "wake/core/field/command-receipt/input-digest",
});

function fail(message) {
  throw new TypeError(`wake-compile: ${message}`);
}

function dirname(path) {
  const end = path.lastIndexOf("/");
  return end <= 0 ? "/" : path.slice(0, end);
}

function basename(path) {
  const end = path.lastIndexOf("/");
  return path.slice(end + 1);
}

function join(root, relative) {
  return `${root.replace(/\/+$/u, "")}/${relative}`;
}

function sourceIdentity(path) {
  const repository = Bun.spawnSync(["git", "-C", dirname(path), "rev-parse", "--show-toplevel"], {
    stderr: "pipe",
    stdout: "pipe",
  });
  if (repository.exitCode !== 0) return path;
  const root = repository.stdout.toString().trim().replace(/\/+$/u, "");
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function projectCheckedBeagle(source, sourceText, compilerVersion) {
  const beagleRoot = process.env.BEAGLE_ROOT ?? `${process.env.HOME}/code/beagle/main`;
  const beagle = process.env.BEAGLE ?? join(beagleRoot, "bin/beagle");
  const projected = Bun.spawnSync([beagle, "ast", source], {
    stderr: "pipe",
    stdout: "pipe",
  });
  if (projected.exitCode !== 0) {
    const diagnostic = projected.stderr.toString().trim();
    fail(`Beagle checked projection failed${diagnostic.length === 0 ? "" : `: ${diagnostic}`}`);
  }
  let ast;
  try {
    ast = JSON.parse(projected.stdout.toString());
  } catch (error) {
    throw new TypeError("wake-compile: Beagle produced invalid checked-program JSON", {
      cause: error,
    });
  }
  return programFromCheckedAst(ast, {
    compilerVersion,
    expectedSourceId: sourceIdentity(source),
    sourcePath: source,
    sourceText,
  });
}

function nonempty(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a nonempty string`);
  }
  return value;
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!["--dist", "--mode", "--source", "--output"].includes(option) || value === undefined) {
      fail(`driver rejects unsupported option ${option ?? "<missing>"}`);
    }
    if (values.has(option)) fail(`driver repeats ${option}`);
    values.set(option, value);
  }
  for (const option of ["--dist", "--mode", "--source", "--output"]) {
    if (!values.has(option)) fail(`driver requires ${option}`);
  }
  const mode = values.get("--mode");
  if (!["all", "fram", "js"].includes(mode)) fail(`unknown driver mode ${mode}`);
  const source = nonempty(values.get("--source"), "source path");
  if (!source.startsWith("/")) fail("source path must be absolute");
  return {
    dist: nonempty(values.get("--dist"), "compiler distribution"),
    mode,
    output: nonempty(values.get("--output"), "output path"),
    source,
  };
}

function semanticValue(value, active = new Set()) {
  if (value === null || ["boolean", "number", "string"].includes(typeof value)) {
    return value;
  }
  if (value === undefined) return null;
  if (typeof value !== "object") fail(`cannot fingerprint ${typeof value}`);
  if (active.has(value)) fail("cannot fingerprint a cyclic compiler value");
  active.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => semanticValue(item, active));
    }
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (key === "_tag" || key === "semantic_fingerprint") continue;
      result[key] = semanticValue(value[key], active);
    }
    if (typeof value._tag === "string") result.tag = value._tag;
    return result;
  } finally {
    active.delete(value);
  }
}

function checkedConfiguration(use, manifest) {
  return checkPluginConfiguration(
    use.config ?? [],
    manifest.configuration,
    `use '${use.package_id}'`,
    fail,
  );
}

function checkedAllow(use, manifest) {
  const available = new Set(manifest.contributions);
  for (const contribution of use.allow ?? []) {
    if (!available.has(contribution)) {
      fail(`use '${use.package_id}' allows undeclared contribution '${contribution}'`);
    }
  }
  return [...use.allow];
}

function qualify(alias, name) {
  return `${alias}.${name}`;
}

function qualifyCommandType(type, qualifyExtensionPort, qualifyValueType) {
  if (type?.kind === "extension") {
    return qualifyExtensionPort(type.port, "command input extension");
  }
  if (type?.kind === "named") {
    return { ...type, name: qualifyValueType(type.name) };
  }
  if (type?.kind === "nullable") {
    return { ...type, value: qualifyCommandType(type.value, qualifyExtensionPort, qualifyValueType) };
  }
  if (type?.kind === "list") {
    return { ...type, items: qualifyCommandType(type.items, qualifyExtensionPort, qualifyValueType) };
  }
  if (type?.kind === "record") {
    return {
      ...type,
      fields: type.fields.map(field => ({
        ...field,
        type: qualifyCommandType(field.type, qualifyExtensionPort, qualifyValueType),
      })),
    };
  }
  return type;
}

function qualifyProviderPortType(type, valueTypeNames, alias) {
  if (type?.kind === "ref") {
    if (!valueTypeNames.has(type.name)) {
      fail(`provider port type names unknown value type '${type.name}'`);
    }
    return { kind: "named", name: qualify(alias, type.name) };
  }
  if (type?.kind === "nullable") {
    return { ...type, value: qualifyProviderPortType(type.value, valueTypeNames, alias) };
  }
  if (type?.kind === "list") {
    return { ...type, items: qualifyProviderPortType(type.items, valueTypeNames, alias) };
  }
  if (type?.kind === "record") {
    return {
      ...type,
      fields: type.fields.map(field => ({
        ...field,
        value: qualifyProviderPortType(field.value, valueTypeNames, alias),
      })),
    };
  }
  if (type?.kind === "tagged") {
    return {
      ...type,
      variants: type.variants.map(variant => ({
        ...variant,
        fields: variant.fields.map(field => ({
          ...field,
          value: qualifyProviderPortType(field.value, valueTypeNames, alias),
        })),
      })),
    };
  }
  return type;
}

function qualifyPluginCommand(command, {
  alias,
  declarations,
  entityNames,
  manifest,
  valueTypeNames,
}) {
  const localName = command.name;
  if (!manifest.exports.commands.includes(localName)) {
    fail(`plugin '${manifest.packageId}' declares unexported command '${localName}'`);
  }
  const qualifyEntityName = name => entityNames.has(name) ? qualify(alias, name) : name;
  const qualifyValueTypeName = name => {
    if (!valueTypeNames.has(name)) {
      fail(`plugin '${manifest.packageId}' command '${localName}' names unknown value type '${name}'`);
    }
    return qualify(alias, name);
  };
  const extensionPort = (name, label, expectedTarget = null) => {
    const port = manifest.extensionPorts.find(candidate => candidate.name === name);
    if (port === undefined) {
      fail(`plugin '${manifest.packageId}' command '${localName}' ${label} names unknown extension port '${name}'`);
    }
    if (port.kind !== "entity-fields") {
      fail(`plugin '${manifest.packageId}' command '${localName}' ${label} targets ${port.kind}, not entity-fields`);
    }
    const targetEntity = port.target.includes("/")
      ? port.target
      : qualifyEntityName(declarations.alias("entity", port.target));
    if (expectedTarget !== null && targetEntity !== expectedTarget) {
      fail(`plugin '${manifest.packageId}' command '${localName}' ${label} targets '${targetEntity}', not '${expectedTarget}'`);
    }
    return { kind: "extension", port: qualify(alias, name), targetEntity };
  };
  const qualifyStep = step => {
    if (step.op === "assert" || step.op === "assert-not-contains") return step;
    const entity = qualifyEntityName(step.entity);
    if (step.op !== "create") return { ...step, entity };
    return {
      ...step,
      entity,
      fields: step.fields.map(field => {
        if (field.extensionPort === undefined) return field;
        const extension = extensionPort(
          field.extensionPort,
          `extension-fields '${field.extensionPort}'`,
          entity,
        );
        return {
          extensionPort: extension.port,
          extensionTarget: extension.targetEntity,
          value: field.value,
        };
      }),
    };
  };
  const capabilities = command.capabilities.map(choice => {
    if (!manifest.exports.capabilities.includes(choice.capability)) {
      fail(`plugin '${manifest.packageId}' command '${localName}' names unexported capability '${choice.capability}'`);
    }
    return {
      ...choice,
      capability: `${manifest.packageId}/cap/${choice.capability}`,
      guards: (choice.guards ?? []).map(qualifyStep),
    };
  });
  const receiptResultFields = command.receipt.resultFields.map(field => {
    const declarationId = declarations.declarationId("field", field.field);
    const storageId = field.storageId ?? manifest.storageIds.fields[declarationId];
    if (typeof storageId !== "string" || storageId.length === 0) {
      fail(`plugin '${manifest.packageId}' command '${localName}' receipt field '${field.field}' has no fixed storage ID`);
    }
    return {
      ...field,
      storageId,
      ...(field.targetEntity === undefined
        ? {}
        : { targetEntity: qualifyEntityName(field.targetEntity) }),
      type: qualifyCommandType(
        field.type,
        name => extensionPort(name, "receipt result type"),
        qualifyValueTypeName,
      ),
    };
  });
  return {
    ...command,
    name: qualify(alias, localName),
    capabilities,
    input: command.input.map(field => ({
      ...field,
      type: qualifyCommandType(field.type, name => extensionPort(name, "input"), qualifyValueTypeName),
    })),
    injections: command.injections.map(injection => ({
      ...injection,
      type: qualifyCommandType(
        injection.type,
        name => extensionPort(name, "injection type"),
        qualifyValueTypeName,
      ),
    })),
    steps: command.steps.map(qualifyStep),
    result: command.result.map(field => ({
      ...field,
      type: qualifyCommandType(field.type, name => extensionPort(name, "result type"), qualifyValueTypeName),
    })),
    receipt: {
      ...command.receipt,
      entity: qualifyEntityName(command.receipt.entity),
      extensions: (command.receipt.extensions ?? []).map(name => {
        const extension = extensionPort(name, `receipt extension '${name}'`, COMMAND_RECEIPT_ENTITY);
        return extension.port;
      }),
      resultFields: receiptResultFields,
    },
  };
}

function splitQualified(value, label) {
  if (typeof value !== "string") fail(`${label} must be ALIAS.PORT`);
  const first = value.indexOf(".");
  if (first <= 0 || first !== value.lastIndexOf(".") || first === value.length - 1) {
    fail(`${label} must be ALIAS.PORT`);
  }
  return { alias: value.slice(0, first), name: value.slice(first + 1) };
}

function declaredCompositionTarget(direct, reference, kind, label) {
  const target = splitQualified(reference, label);
  const resolved = direct.find(candidate => candidate.use.alias === target.alias);
  if (resolved === undefined) fail(`${label} names unknown plugin alias '${target.alias}'`);
  const allowed = new Set(resolved.use.allow);
  const requiredContribution = kind === "provider"
    ? "capability"
    : kind === "mount"
      ? "route"
      : kind === "extend"
        ? "schema"
        : "ui";
  if (!allowed.has(requiredContribution)) {
    fail(`${label} requires allowed contribution '${requiredContribution}'`);
  }
  const manifest = resolved.artifact.manifest;
  if (kind === "provider") {
    if (!manifest.exports.providerPorts.includes(target.name)) {
      fail(`${label} names unexported provider port '${target.name}'`);
    }
    return { manifest, resolved, target };
  }
  const port = manifest.extensionPorts.find(candidate => candidate.name === target.name);
  if (port === undefined) fail(`${label} names unknown extension port '${target.name}'`);
  const expectedKind = kind === "mount" ? "route-slot" : kind === "fill" ? "component-slot" : "entity-fields";
  if (port.kind !== expectedKind) {
    fail(`${label} targets ${port.kind}, not ${expectedKind}`);
  }
  return { manifest, port, resolved, target };
}

function checkedRoutePattern(path, parameters, label) {
  const segments = path === "/" ? [] : path.slice(1).split("/");
  const derived = segments
    .filter(segment => segment.startsWith(":"))
    .map(segment => segment.slice(1));
  if (derived.length !== parameters.length
      || derived.some((parameter, index) => parameter !== parameters[index])) {
    fail(`${label} route parameters do not match its checked path`);
  }
  return segments.map(segment => segment.startsWith(":") ? ":" : segment).join("/");
}

function commandTypeFromStorage(type, stateNames, label) {
  switch (type) {
    case "String": return { kind: "string" };
    case "Digest": return { kind: "digest" };
    case "Int":
    case "Integer": return { kind: "integer" };
    case "Float":
    case "Double":
    case "Number": return { kind: "number" };
    case "Bool":
    case "Boolean": return { kind: "boolean" };
    case "Instant": return { kind: "instant" };
    case "Keyword": return { kind: "keyword" };
    default:
      if (stateNames.has(type)) return { kind: "keyword" };
      fail(`${label} has unsupported command storage type '${type}'`);
  }
}

function storageTypeFromCommand(type, label) {
  switch (type?.kind) {
    case "string": return "String";
    case "digest": return "Digest";
    case "integer": return "Int";
    case "number": return "Number";
    case "boolean": return "Bool";
    case "instant": return "Instant";
    case "keyword": return "Keyword";
    default: fail(`${label} has unsupported receipt storage type '${type?.kind ?? "unknown"}'`);
  }
}

function commandTypeForExtensionField(field, entities, stateNames, label) {
  let type;
  if (field.type === "Ref") {
    const targetName = field.opts?.["target-entity"];
    const target = entities.find(entity => entity.name === targetName);
    const identity = target?.attrs?.find(attr => attr.opts?.identity === true);
    if (identity === undefined) {
      fail(`${label} targets entity '${targetName}' without an identity`);
    }
    type = commandTypeFromStorage(identity.type, stateNames, label);
  } else {
    type = commandTypeFromStorage(field.type, stateNames, label);
  }
  if (field.opts?.many === true) {
    fail(`${label} cannot be multi-cardinality without an explicit command bound`);
  }
  return type;
}

function receiptCoreEntity(commands) {
  const attrs = [
    {
      _tag: "IrAttr",
      name: "id",
      opts: { identity: true },
      storage_id: COMMAND_RECEIPT_FIELDS.id,
      type: "Digest",
    },
    ...[
      ["actor", "String"],
      ["command", "String"],
      ["input-digest", "Digest"],
      ["created-at", "Instant"],
    ].map(([name, type]) => ({
      _tag: "IrAttr",
      name,
      opts: { write: "command" },
      storage_id: COMMAND_RECEIPT_FIELDS[name],
      type,
    })),
  ];
  const fields = new Map(attrs.map(field => [field.name, field]));
  for (const command of commands) {
    if (command.receipt?.entity !== COMMAND_RECEIPT_ENTITY) continue;
    for (const result of command.receipt.resultFields ?? []) {
      const storageId = result.storageId;
      if (typeof storageId !== "string" || storageId.length === 0) {
        fail(`command '${command.name}' receipt result '${result.name}' requires fixed storage provenance`);
      }
      const field = result.targetEntity === undefined
        ? {
            _tag: "IrAttr",
            name: result.field,
            opts: { write: "command" },
            storage_id: storageId,
            type: storageTypeFromCommand(
              result.type,
              `command '${command.name}' receipt result '${result.name}'`,
            ),
          }
        : {
            _tag: "IrAttr",
            name: result.field,
            opts: { "target-entity": result.targetEntity, write: "command" },
            storage_id: storageId,
            type: "Ref",
          };
      const prior = fields.get(field.name);
      if (prior !== undefined) {
        if (canonicalDocument(semanticValue(prior)) !== canonicalDocument(semanticValue(field))) {
          fail(`command receipt field '${field.name}' has conflicting declarations`);
        }
      } else {
        fields.set(field.name, field);
        attrs.push(field);
      }
    }
  }
  return {
    _tag: "IrEntity",
    attrs,
    name: COMMAND_RECEIPT_ENTITY,
    storage_id: COMMAND_RECEIPT_STORAGE_ID,
  };
}

function ensureCommandReceiptCore(linked) {
  const commands = linked.commands ?? [];
  if (commands.length === 0) return linked;
  if (linked.entities.some(entity => entity.name === COMMAND_RECEIPT_ENTITY)) {
    fail(`entity '${COMMAND_RECEIPT_ENTITY}' is reserved by Wake`);
  }
  for (const command of commands) {
    for (const step of [
      ...command.steps,
      ...command.capabilities.flatMap(choice => choice.guards ?? []),
    ]) {
      if (step.entity === COMMAND_RECEIPT_ENTITY) {
        fail(`command '${command.name}' cannot target Wake's reserved receipt entity`);
      }
    }
  }
  return {
    ...linked,
    entities: [...linked.entities, receiptCoreEntity(commands)],
  };
}

function stripReceiptLinkMetadata(field) {
  const { storageId: _storageId, targetEntity: _targetEntity, ...wire } = field;
  return wire;
}

function expandCommandComposition(commands, extensions, entities, defstates) {
  const byPort = new Map(extensions.map(extension => [extension.port, extension]));
  const stateNames = new Set(defstates.map(state => state.name));
  const fieldType = (field, label) => (
    commandTypeForExtensionField(field, entities, stateNames, label)
  );
  const expandType = (type, label) => {
    if (type?.kind === "extension") {
      const extension = byPort.get(type.port);
      const fields = extension?.fields ?? [];
      return {
        fields: fields.map(field => ({
          name: field.name,
          required: field.opts?.required === true,
          type: fieldType(field, `${label} extension field '${field.name}'`),
        })),
        kind: "record",
      };
    }
    if (type?.kind === "nullable") {
      return { ...type, value: expandType(type.value, label) };
    }
    if (type?.kind === "list") {
      return { ...type, items: expandType(type.items, label) };
    }
    if (type?.kind === "record") {
      return {
        ...type,
        fields: type.fields.map(field => ({
          ...field,
          type: expandType(field.type, `${label}.${field.name}`),
        })),
      };
    }
    return type;
  };
  return commands.map(command => {
    const input = command.input.map(field => ({
      ...field,
      type: expandType(field.type, `command '${command.name}' input '${field.name}'`),
    }));
    const injections = command.injections.map(injection => ({
      ...injection,
      type: expandType(injection.type, `command '${command.name}' injection '${injection.name}'`),
    }));
    const result = command.result.map(field => ({
      ...field,
      type: expandType(field.type, `command '${command.name}' result '${field.name}'`),
    }));
    const steps = command.steps.map(step => {
      if (step.op !== "create") return step;
      const seen = new Set();
      return {
        ...step,
        fields: step.fields.flatMap(field => {
          if (field.extensionPort === undefined) return [field];
          if (seen.has(field.extensionPort)) {
            fail(`command '${command.name}' repeats extension-fields '${field.extensionPort}'`);
          }
          seen.add(field.extensionPort);
          const extension = byPort.get(field.extensionPort);
          const target = extension?.target ?? field.extensionTarget;
          if (target !== step.entity) {
            fail(`command '${command.name}' extension-fields '${field.extensionPort}' targets '${target}', not '${step.entity}'`);
          }
          const fields = extension?.fields ?? [];
          for (const source of fields) {
            if (source.opts?.required !== true || source.opts?.server === true) {
              fail(`command '${command.name}' extension-fields '${field.extensionPort}' requires caller-required immutable fields`);
            }
          }
          return fields.map(source => ({
            field: source.name,
            omitIfNull: false,
            value: { field: source.name, kind: "get", value: field.value },
          }));
        }),
      };
    });
    const receipt = {
      ...command.receipt,
      resultFields: command.receipt.resultFields.map(stripReceiptLinkMetadata),
    };
    for (const port of command.receipt.extensions ?? []) {
      const extension = byPort.get(port);
      for (const field of extension?.fields ?? []) {
        if (extension.target !== COMMAND_RECEIPT_ENTITY
            || field.opts?.server !== true
            || field.opts?.required === true
            || field.opts?.many === true) {
          fail(`command '${command.name}' receipt extension '${port}' accepts only single server-injected receipt fields`);
        }
        const type = fieldType(field, `command '${command.name}' receipt extension '${port}.${field.name}'`);
        const injectionName = `wake.server:${field.storage_id}`;
        injections.push({
          kind: "server-value",
          name: injectionName,
          storageId: field.storage_id,
          type,
        });
        result.push({
          name: field.name,
          type,
          value: { kind: "injected", name: injectionName },
        });
        receipt.resultFields.push({
          field: field.name,
          name: field.name,
          type,
        });
      }
    }
    delete receipt.extensions;
    return {
      ...command,
      injections,
      input,
      receipt,
      result,
      steps,
    };
  });
}

function resolvedExternalType(type, valueTypes, label, active = new Set()) {
  if (type?.kind === "named" || type?.kind === "ref") {
    const declaration = valueTypes.get(type.name);
    if (declaration === undefined) fail(`${label} names unknown value type '${type.name}'`);
    if (active.has(type.name)) fail(`${label} reaches cyclic external value type '${type.name}'`);
    const next = new Set(active);
    next.add(type.name);
    return resolvedExternalType(declaration.descriptor, valueTypes, label, next);
  }
  if (type?.kind === "bounded") return structuredClone(type);
  if (type?.kind === "nullable") {
    return { ...type, value: resolvedExternalType(type.value, valueTypes, label, active) };
  }
  if (type?.kind === "list") {
    return { ...type, items: resolvedExternalType(type.items, valueTypes, label, active) };
  }
  if (type?.kind === "record") {
    return {
      ...type,
      fields: type.fields.map(field => ({
        ...field,
        [Object.hasOwn(field, "type") ? "type" : "value"]: resolvedExternalType(
          field.type ?? field.value,
          valueTypes,
          `${label}.${field.name}`,
          active,
        ),
      })),
    };
  }
  if (type?.kind === "tagged") {
    return {
      ...type,
      variants: type.variants.map(variant => ({
        ...variant,
        fields: variant.fields.map(field => ({
          ...field,
          value: resolvedExternalType(
            field.value,
            valueTypes,
            `${label}.${field.name}`,
            active,
          ),
        })),
      })),
    };
  }
  return type;
}

function resolveLinkedProviderTypes(linked) {
  const declarations = linked.value_types ?? [];
  const valueTypes = new Map();
  for (const declaration of declarations) {
    if (valueTypes.has(declaration.name)) fail(`value type '${declaration.name}' is declared twice`);
    valueTypes.set(declaration.name, declaration);
  }
  const resolveCommand = command => ({
    ...command,
    input: command.input.map(field => ({
      ...field,
      type: resolvedExternalType(field.type, valueTypes, `command '${command.name}' input '${field.name}'`),
    })),
    injections: command.injections.map(injection => ({
      ...injection,
      type: resolvedExternalType(
        injection.type,
        valueTypes,
        `command '${command.name}' injection '${injection.name}'`,
      ),
    })),
    result: command.result.map(field => ({
      ...field,
      type: resolvedExternalType(field.type, valueTypes, `command '${command.name}' result '${field.name}'`),
    })),
    receipt: {
      ...command.receipt,
      resultFields: command.receipt.resultFields.map(field => ({
        ...field,
        type: resolvedExternalType(
          field.type,
          valueTypes,
          `command '${command.name}' receipt '${field.name}'`,
        ),
      })),
    },
  });
  return {
    ...linked,
    commands: (linked.commands ?? []).map(resolveCommand),
    provider_ports: (linked.provider_ports ?? []).map(port => ({
      ...port,
      input: resolvedExternalType(port.input, valueTypes, `provider port '${port.name}' input`),
      output: resolvedExternalType(port.output, valueTypes, `provider port '${port.name}' output`),
    })),
    providers: (linked.providers ?? []).map(provider => ({
      ...provider,
      input_type: resolvedExternalType(
        provider.input_type,
        valueTypes,
        `provider '${provider.name}' input`,
      ),
      output_type: resolvedExternalType(
        provider.output_type,
        valueTypes,
        `provider '${provider.name}' output`,
      ),
    })),
  };
}

function applyApplicationComposition(linked, direct) {
  const providers = (linked.providers ?? []).map(provider => {
    const target = declaredCompositionTarget(
      direct,
      provider.port,
      "provider",
      `provider '${provider.name}'`,
    );
    const portName = qualify(
      target.target.alias,
      target.resolved.configurationDeclarations.alias("provider-port", target.target.name),
    );
    const contract = (linked.provider_ports ?? []).find(candidate => candidate.name === portName);
    if (contract === undefined) {
      fail(`provider '${provider.name}' targets missing checked port '${portName}'`);
    }
    return {
      input_type: contract.input,
      name: provider.name,
      output_type: contract.output,
      port: provider.port,
      package_id: target.manifest.packageId,
      port_name: target.target.name,
    };
  });
  const providerNames = new Set();
  const providerPorts = new Set();
  for (const provider of providers) {
    if (providerNames.has(provider.name)) fail(`provider '${provider.name}' is declared twice`);
    if (providerPorts.has(provider.port)) fail(`provider port '${provider.port}' is bound twice`);
    providerNames.add(provider.name);
    providerPorts.add(provider.port);
  }
  for (const { artifact, use } of direct) {
    for (const port of artifact.manifest.exports.providerPorts) {
      const required = artifact.manifest.requiredHostCapabilities.includes(port)
        || artifact.manifest.requiredHostCapabilities.includes(`provider:${port}`);
      if (required && !providerPorts.has(qualify(use.alias, port))) {
        fail(`plugin '${artifact.manifest.packageId}' requires provider port '${use.alias}.${port}'`);
      }
    }
  }

  const extensions = (linked.extends ?? []).map(extension => {
    const target = declaredCompositionTarget(
      direct,
      extension.port,
      "extend",
      `extend '${extension.port}'`,
    );
    const allowed = new Set(target.port.accepts);
    const fieldNames = new Set();
    for (const field of extension.fields) {
      if (fieldNames.has(field.name)) fail(`extend '${extension.port}' repeats field '${field.name}'`);
      fieldNames.add(field.name);
      if (typeof field.storage_id !== "string" || field.storage_id.length === 0) {
        fail(`extend '${extension.port}' field '${field.name}' requires an explicit storage ID`);
      }
      if (!allowed.has("explicit-storage-id")) {
        fail(`extend '${extension.port}' does not accept explicit storage fields`);
      }
      if (field.opts?.required === true && !allowed.has("immutable")) {
        fail(`extend '${extension.port}' does not accept caller-required immutable fields`);
      }
      if (field.opts?.server === true && !allowed.has("server-injected")) {
        fail(`extend '${extension.port}' does not accept server-injected fields`);
      }
    }
    return {
      fields: extension.fields,
      kind: target.port.kind,
      package_id: target.manifest.packageId,
      port: extension.port,
      target: target.port.target.includes("/")
        ? target.port.target
        : qualify(
            target.target.alias,
            target.resolved.configurationDeclarations.alias(
              "entity",
              target.port.target,
            ),
          ),
    };
  });
  const extensionPorts = new Set();
  const extensionStorageIds = new Set();
  for (const extension of extensions) {
    if (extensionPorts.has(extension.port)) fail(`extension port '${extension.port}' is supplied twice`);
    extensionPorts.add(extension.port);
    for (const field of extension.fields) {
      if (extensionStorageIds.has(field.storage_id)) fail(`application extensions repeat storage ID '${field.storage_id}'`);
      extensionStorageIds.add(field.storage_id);
    }
  }

  let entities = linked.entities;
  const existingStorageIds = new Set();
  for (const entity of entities) {
    if (typeof entity.storage_id === "string") existingStorageIds.add(entity.storage_id);
    for (const field of entity.attrs) {
      if (typeof field.storage_id === "string") existingStorageIds.add(field.storage_id);
    }
  }
  for (const extension of extensions) {
    const targetEntityName = extension.target;
    const targetEntity = entities.find(entity => entity.name === targetEntityName);
    if (targetEntity === undefined) {
      fail(`extend '${extension.port}' targets missing entity '${extension.target}'`);
    }
    const fieldNames = new Set(targetEntity.attrs.map(field => field.name));
    const additions = extension.fields.map(field => {
      if (fieldNames.has(field.name)) {
        fail(`extend '${extension.port}' collides with field '${targetEntityName}.${field.name}'`);
      }
      if (existingStorageIds.has(field.storage_id)) {
        fail(`extend '${extension.port}' repeats storage ID '${field.storage_id}'`);
      }
      fieldNames.add(field.name);
      existingStorageIds.add(field.storage_id);
      const opts = { ...field.opts };
      if (opts.server === true) opts.write = "command";
      else opts.write = "create";
      delete opts.required;
      delete opts.server;
      return { ...field, opts };
    });
    entities = entities.map(entity => entity.name === targetEntityName
      ? { ...entity, attrs: [...entity.attrs, ...additions] }
      : entity);
  }

  const queries = (linked.queries ?? []).map(query => ({
    ...query,
    selection: query.selection.flatMap(selection => {
      if (selection?._tag !== "IrQueryFieldSplice") return [selection];
      const extension = extensions.find(candidate => candidate.port === selection.port);
      if (extension === undefined) return [];
      return extension.fields.map(field => ({
        _tag: "IrQuerySelect",
        binding: selection.binding,
        field: field.name,
        name: field.name,
      }));
    }),
  }));

  const componentNames = new Set(linked.components.map(component => component.name));
  const fills = (linked.fills ?? []).map(fill => {
    const target = declaredCompositionTarget(direct, fill.port, "fill", `fill '${fill.port}'`);
    if (!componentNames.has(fill.component)) {
      fail(`fill '${fill.port}' names unknown application component '${fill.component}'`);
    }
    const targetName = qualify(target.target.alias, target.port.target);
    const targetComponent = linked.components.find(component => component.name === targetName);
    const replacement = linked.components.find(component => component.name === fill.component);
    if (targetComponent === undefined) {
      fail(`fill '${fill.port}' targets missing plugin component '${target.port.target}'`);
    }
    const missing = targetComponent.props.filter(prop => !replacement.props.includes(prop));
    if (missing.length > 0) {
      fail(`fill '${fill.port}' component '${fill.component}' lacks required props: ${missing.join(", ")}`);
    }
    return {
      component: fill.component,
      package_id: target.manifest.packageId,
      port: fill.port,
      target_component: targetName,
    };
  });

  const mounts = (linked.mounts ?? []).map(mount => {
    const target = declaredCompositionTarget(direct, mount.port, "mount", `mount '${mount.port}'`);
    const targetRoute = qualify(target.target.alias, target.port.target);
    const template = (linked.route_templates ?? []).find(route => route.path === targetRoute);
    if (template === undefined) {
      fail(`mount '${mount.port}' targets missing plugin route template '${target.port.target}'`);
    }
    const parameterContracts = target.port.accepts.filter(value => value !== "route-path");
    const templateParameters = template.parameters ?? [];
    if (parameterContracts.length !== templateParameters.length) {
      fail(`mount '${mount.port}' manifest and route template disagree on parameter arity`);
    }
    if (parameterContracts.some((parameter, index) => parameter !== templateParameters[index])) {
      fail(`mount '${mount.port}' manifest and route template disagree on parameter names`);
    }
    if (mount.parameters.length !== templateParameters.length) {
      fail(`mount '${mount.port}' requires exactly ${templateParameters.length} route parameters`);
    }
    const pattern = checkedRoutePattern(mount.path, mount.parameters, `mount '${mount.port}'`);
    const view = linked.views.find(candidate => candidate.name === template.view_name);
    if (view === undefined) {
      fail(`mount '${mount.port}' targets missing plugin route view '${template.view_name}'`);
    }
    const component = linked.components.find(candidate => candidate.name === view.component);
    if (component === undefined) {
      fail(`mount '${mount.port}' route view names missing component '${view.component}'`);
    }
    return {
      input_parameters: templateParameters,
      package_id: target.manifest.packageId,
      parameters: mount.parameters,
      path: mount.path,
      pattern,
      port: mount.port,
      queries: template.queries ?? [],
      required_props: component.props,
      target_route: targetRoute,
      view_name: template.view_name,
    };
  });
  const mountPorts = new Set();
  const mountPaths = new Set();
  const mountPatterns = new Set();
  for (const mount of mounts) {
    if (mountPorts.has(mount.port)) fail(`route slot '${mount.port}' is mounted twice`);
    if (mountPaths.has(mount.path)) fail(`route path '${mount.path}' is mounted twice`);
    if (mountPatterns.has(mount.pattern)) fail(`route pattern '${mount.pattern}' is mounted twice`);
    mountPorts.add(mount.port);
    mountPaths.add(mount.path);
    mountPatterns.add(mount.pattern);
  }

  const existingRoutes = new Set((linked.router?.routes ?? []).map(route => route.path));
  for (const mount of mounts) {
    if (existingRoutes.has(mount.path)) fail(`route path '${mount.path}' collides with an application route`);
  }
  const mountedRoutes = mounts.map(mount => ({
    input_parameters: mount.input_parameters,
    parameters: mount.parameters,
    path: mount.path,
    queries: mount.queries,
    required_props: mount.required_props,
    view_name: mount.view_name,
  }));
  const router = mountedRoutes.length === 0
    ? linked.router
    : linked.router == null
      ? { default_route: mountedRoutes[0].view_name, routes: mountedRoutes }
      : { ...linked.router, routes: [...linked.router.routes, ...mountedRoutes] };

  const filledComponents = linked.components.map(component => {
    const fill = fills.find(candidate => candidate.target_component === component.name);
    if (fill === undefined) return component;
    return linked.components.find(candidate => candidate.name === fill.component);
  }).filter((component, index, all) => all.findIndex(candidate => candidate.name === component.name) === index);
  const filledViews = linked.views.map(view => {
    const componentFill = fills.find(candidate => candidate.target_component === view.component);
    const selectFill = fills.find(candidate => candidate.target_component === view.select_component);
    return {
      ...view,
      component: componentFill?.component ?? view.component,
      select_component: selectFill?.component ?? view.select_component,
    };
  });
  const commands = expandCommandComposition(
    linked.commands ?? [],
    extensions,
    entities,
    linked.defstates ?? [],
  );

  return resolveLinkedProviderTypes({
    ...linked,
    commands,
    components: filledComponents,
    entities,
    extends: extensions,
    fills,
    mounts,
    providers,
    queries,
    router,
    views: filledViews,
  });
}

function qualifyEntity(
  entity,
  alias,
  manifest,
  entityNames,
  stateNames,
  declarations,
) {
  const localName = entity.name;
  const declarationId = declarations.declarationId("entity", localName);
  const entityStorageId = manifest.storageIds.entities[declarationId];
  if (typeof entityStorageId !== "string") {
    fail(`plugin '${manifest.packageId}' entity '${declarationId}' has no fixed storage ID`);
  }
  const attrs = entity.attrs.map((attr) => {
    const key = declarations.declarationId(
      "field",
      attr.name,
      { ownerId: declarationId },
    );
    const storageId = manifest.storageIds.fields[key];
    if (typeof storageId !== "string") {
      fail(`plugin '${manifest.packageId}' field '${key}' has no fixed storage ID`);
    }
    const opts = { ...(attr.opts ?? {}) };
    if (entityNames.has(opts["target-entity"])) {
      opts["target-entity"] = qualify(alias, opts["target-entity"]);
    }
    const type = stateNames.has(attr.type) ? qualify(alias, attr.type) : attr.type;
    return { ...attr, opts, storage_id: storageId, type };
  });
  return {
    ...entity,
    attrs,
    name: qualify(alias, localName),
    storage_id: entityStorageId,
  };
}

function qualifyPluginProgram(program, use, manifest, declarations) {
  if (program.application != null) fail(`plugin '${manifest.packageId}' must not declare application`);
  if (program.backend != null) fail(`plugin '${manifest.packageId}' must not select a backend`);
  if (program.persist != null) fail(`plugin '${manifest.packageId}' must not declare persistence`);
  if ((program.uses ?? []).length > 0) {
    fail(`plugin '${manifest.packageId}' entry cannot contain nested use in plugin ABI 1`);
  }

  const alias = use.alias;
  const allow = new Set(checkedAllow(use, manifest));
  const entityNames = new Set(program.entities.map((entity) => entity.name));
  const stateNames = new Set(program.defstates.map((state) => state.name));
  const componentNames = new Set(program.components.map((component) => component.name));
  const viewNames = new Set(program.views.map((view) => view.name));
  const queryNames = new Set((program.queries ?? []).map((query) => query.name));
  const commandNames = new Set((program.commands ?? []).map((command) => command.name));
  const valueTypeNames = new Set((program.value_types ?? []).map((valueType) => valueType.name));
  const providerPortNames = new Set((program.provider_ports ?? []).map((port) => port.name));
  const routeNames = new Set((program.router?.routes ?? []).map((route) => route.path));

  if (allow.has("schema")) {
    for (const exported of manifest.exports.entities) {
      const localName = declarations.alias("entity", exported);
      if (!entityNames.has(localName)) {
        fail(`plugin '${manifest.packageId}' exports missing entity '${exported}'`);
      }
    }
    for (const exported of manifest.exports.valueTypes ?? []) {
      const localName = declarations.alias("value-type", exported);
      if (!valueTypeNames.has(localName)) {
        fail(`plugin '${manifest.packageId}' exports missing value type '${exported}'`);
      }
    }
    for (const declared of valueTypeNames) {
      const declarationId = declarations.declarationId("value-type", declared);
      if (!(manifest.exports.valueTypes ?? []).includes(declarationId)) {
        fail(`plugin '${manifest.packageId}' declares unexported value type '${declared}'`);
      }
    }
  }
  if (allow.has("capability")) {
    for (const exported of manifest.exports.providerPorts) {
      const localName = declarations.alias("provider-port", exported);
      if (!providerPortNames.has(localName)) {
        fail(`plugin '${manifest.packageId}' exports missing provider port '${exported}'`);
      }
    }
    for (const declared of providerPortNames) {
      const declarationId = declarations.declarationId("provider-port", declared);
      if (!manifest.exports.providerPorts.includes(declarationId)) {
        fail(`plugin '${manifest.packageId}' declares unexported provider port '${declared}'`);
      }
    }
  }
  if (allow.has("query")) {
    for (const exported of manifest.exports.queries) {
      const localName = declarations.alias("query", exported);
      if (!queryNames.has(localName)) {
        fail(`plugin '${manifest.packageId}' exports missing query '${exported}'`);
      }
    }
    for (const declared of queryNames) {
      const declarationId = declarations.declarationId("query", declared);
      if (!manifest.exports.queries.includes(declarationId)) {
        fail(`plugin '${manifest.packageId}' declares unexported query '${declared}'`);
      }
    }
  }
  if (allow.has("command")) {
    for (const exported of manifest.exports.commands) {
      const localName = declarations.alias("command", exported);
      if (!commandNames.has(localName)) {
        fail(`plugin '${manifest.packageId}' exports missing command '${exported}'`);
      }
    }
    for (const declared of commandNames) {
      const declarationId = declarations.declarationId("command", declared);
      if (!manifest.exports.commands.includes(declarationId)) {
        fail(`plugin '${manifest.packageId}' declares unexported command '${declared}'`);
      }
    }
  }
  if (allow.has("route")) {
    for (const exported of manifest.exports.routes) {
      const localName = declarations.alias("route", exported);
      if (!routeNames.has(localName)) {
        fail(`plugin '${manifest.packageId}' exports missing route template '${exported}'`);
      }
    }
    for (const declared of routeNames) {
      const declarationId = declarations.declarationId("route", declared);
      if (!manifest.exports.routes.includes(declarationId)) {
        fail(`plugin '${manifest.packageId}' declares unexported route template '${declared}'`);
      }
    }
  }

  const entities = allow.has("schema")
    ? program.entities.map((entity) => qualifyEntity(
        entity,
        alias,
        manifest,
        entityNames,
        stateNames,
        declarations,
      ))
    : [];
  const defstates = allow.has("schema")
    ? program.defstates.map((state) => ({ ...state, name: qualify(alias, state.name) }))
    : [];
  const publications = allow.has("schema")
    ? program.publications.map((publication) => ({
        ...publication,
        name: qualify(alias, publication.name),
        owner_entity: entityNames.has(publication.owner_entity)
          ? qualify(alias, publication.owner_entity)
          : publication.owner_entity,
        revision_entity: entityNames.has(publication.revision_entity)
          ? qualify(alias, publication.revision_entity)
          : publication.revision_entity,
      }))
    : [];
  const queries = allow.has("query")
    ? (program.queries ?? []).map((query) => {
        const capabilities = query.capabilities.map(capability => {
          if (!manifest.exports.capabilities.includes(capability)) {
            fail(`plugin '${manifest.packageId}' query '${query.name}' names unexported capability '${capability}'`);
          }
          return `${manifest.packageId}/cap/${capability}`;
        });
        const seenSplices = new Set();
        const selection = query.selection.map(item => {
          if (item?._tag !== "IrQueryFieldSplice") return item;
          const port = manifest.extensionPorts.find(candidate => candidate.name === item.port);
          if (port === undefined) {
            fail(`plugin '${manifest.packageId}' query '${query.name}' names unknown extension port '${item.port}'`);
          }
          if (port.kind !== "entity-fields") {
            fail(`plugin '${manifest.packageId}' query '${query.name}' extension-fields '${item.port}' targets ${port.kind}, not entity-fields`);
          }
          if (seenSplices.has(item.port)) {
            fail(`plugin '${manifest.packageId}' query '${query.name}' repeats extension-fields '${item.port}'`);
          }
          seenSplices.add(item.port);
          const binding = query.bindings.find(candidate => candidate.name === item.binding);
          if (binding === undefined) {
            fail(`plugin '${manifest.packageId}' query '${query.name}' extension-fields '${item.port}' names unknown binding '${item.binding}'`);
          }
          const targetEntity = port.target.includes("/")
            ? port.target
            : declarations.alias("entity", port.target);
          if (binding.entity_name !== targetEntity) {
            fail(`plugin '${manifest.packageId}' query '${query.name}' extension-fields '${item.port}' targets '${targetEntity}', not binding '${item.binding}' entity '${binding.entity_name}'`);
          }
          return { ...item, port: qualify(alias, item.port) };
        });
        return {
          ...query,
          capabilities,
          name: qualify(alias, query.name),
          params: query.params.map((parameter) => ({
            ...parameter,
            type: stateNames.has(parameter.type)
              ? qualify(alias, parameter.type)
              : parameter.type,
          })),
          bindings: query.bindings.map((binding) => ({
            ...binding,
            entity_name: entityNames.has(binding.entity_name)
              ? qualify(alias, binding.entity_name)
              : binding.entity_name,
          })),
          selection,
        };
      })
    : [];
  const commands = allow.has("command")
    ? (program.commands ?? []).map(command => qualifyPluginCommand(command, {
        alias,
        declarations,
        entityNames,
        manifest,
        valueTypeNames,
      }))
    : [];
  const valueTypes = allow.has("schema")
    ? (program.value_types ?? []).map(valueType => ({
        ...valueType,
        name: qualify(alias, valueType.name),
      }))
    : [];
  const providerPorts = allow.has("capability")
    ? (program.provider_ports ?? []).map(port => ({
        ...port,
        name: qualify(alias, port.name),
        input: qualifyProviderPortType(port.input, valueTypeNames, alias),
        output: qualifyProviderPortType(port.output, valueTypeNames, alias),
      }))
    : [];
  const components = allow.has("ui")
    ? program.components.map((component) => ({
        ...component,
        name: qualify(alias, component.name),
      }))
    : [];
  const views = allow.has("ui")
    ? program.views.map((view) => ({
        ...view,
        component: componentNames.has(view.component) ? qualify(alias, view.component) : view.component,
        entity_name: entityNames.has(view.entity_name) ? qualify(alias, view.entity_name) : view.entity_name,
        name: qualify(alias, view.name),
        select_component: componentNames.has(view.select_component)
          ? qualify(alias, view.select_component)
          : view.select_component,
        tabs: (view.tabs ?? []).map((tab) => ({
          ...tab,
          entity_name: entityNames.has(tab.entity_name) ? qualify(alias, tab.entity_name) : tab.entity_name,
        })),
      }))
    : [];
  const listDetails = allow.has("ui")
    ? program.list_details.map((detail) => ({
        ...detail,
        entity_name: entityNames.has(detail.entity_name)
          ? qualify(alias, detail.entity_name)
          : detail.entity_name,
      }))
    : [];
  const forms = allow.has("ui")
    ? program.forms.map((form) => ({
        ...form,
        entity_name: entityNames.has(form.entity_name) ? qualify(alias, form.entity_name) : form.entity_name,
        name: qualify(alias, form.name),
      }))
    : [];
  const routeTemplates = allow.has("route") && program.router != null
    ? program.router.routes.map((route) => ({
        ...route,
        path: qualify(alias, route.path),
        queries: (route.queries ?? []).map((query) => ({
          ...query,
          name: queryNames.has(query.name) ? qualify(alias, query.name) : query.name,
        })),
        view_name: viewNames.has(route.view_name) ? qualify(alias, route.view_name) : route.view_name,
      }))
    : [];

  const renamed = new Map();
  for (const kind of [
    "entity",
    "defstate",
    "publication",
    "value-type",
    "provider-port",
    "query",
    "command",
    "component",
    "view",
    "form",
  ]) {
    renamed.set(kind, true);
  }
  const declarationProvenance = program.declaration_provenance
    .filter((entry) => !["ns", "backend", "persist", "application", "use"].includes(entry.kind))
    .map((entry) => ({
      ...entry,
      name: renamed.has(entry.kind) ? qualify(alias, entry.name) : entry.name,
    }));

  return {
    commands,
    components,
    declarationProvenance,
    defstates,
    entities,
    forms,
    layout: allow.has("ui") ? (program.layout ?? null) : null,
    listDetails,
    publications,
    providerPorts,
    queries,
    routeTemplates,
    sourceUnit: program.source_unit,
    theme: allow.has("ui") ? (program.theme ?? null) : null,
    valueTypes,
    views,
  };
}

function appendUnique(existing, additions, label, name = (value) => value.name) {
  const seen = new Set(existing.map(name));
  for (const value of additions) {
    const key = name(value);
    if (seen.has(key)) fail(`linked application repeats ${label} '${key}'`);
    seen.add(key);
  }
  return [...existing, ...additions];
}

function mergeRouter(current, incoming, packageId) {
  if (incoming === null) return current;
  if (current === null) return incoming;
  return {
    ...current,
    routes: appendUnique(current.routes, incoming.routes, "route path", (route) => route.path),
    default_route: current.default_route || incoming.default_route,
  };
}

async function readCanonicalLock(lockPath) {
  const file = Bun.file(lockPath);
  if (!(await file.exists())) fail(`plugin imports require adjacent ${lockPath}`);
  return validateWakeLock(parseCanonicalDocument(await file.text(), lockPath));
}

async function loadPlugin(lockDir, entry) {
  const artifactPath = join(lockDir, entry.artifact);
  const file = Bun.file(artifactPath);
  if (!(await file.exists())) fail(`locked artifact does not exist: ${entry.artifact}`);
  const artifact = await readPluginArtifactFile(
    artifactPath,
    entry.digest,
    entry.artifact,
  );
  if (artifact.manifest.packageId !== entry.packageId || artifact.manifest.version !== entry.version) {
    fail(`locked artifact identity does not match ${entry.packageId}@${entry.version}`);
  }
  return { artifact, entry };
}

function maximumMigrationOrdinal(manifest) {
  return manifest.migrations.reduce((maximum, migration) => {
    const ordinal = Number.isSafeInteger(migration.ordinal) ? migration.ordinal : 0;
    return Math.max(maximum, ordinal);
  }, 0);
}

async function linkProgram(
  root,
  sourcePath,
  compilerVersion,
  parseProgramConfiguredAt,
) {
  const uses = root.uses ?? [];
  if (uses.length === 0) {
    const linked = ensureCommandReceiptCore({
      ...root,
      plugin_closure: [],
      semantic_fingerprint: null,
      source_units: [root.source_unit],
    });
    return {
      linked: applyApplicationComposition(linked, []),
      resolved: [],
    };
  }

  const lockPath = join(dirname(sourcePath), "wake.lock");
  const lockDir = dirname(lockPath);
  const lock = await readCanonicalLock(lockPath);
  const locks = new Map(lock.plugins.map((entry) => [entry.packageId, entry]));
  const loaded = new Map();
  const load = async (packageId, version) => {
    const entry = locks.get(packageId);
    if (entry === undefined || entry.version !== version) {
      fail(`wake.lock does not pin exact ${packageId}@${version}`);
    }
    if (!loaded.has(packageId)) loaded.set(packageId, await loadPlugin(lockDir, entry));
    return loaded.get(packageId);
  };

  const direct = [];
  for (const use of uses) {
    const resolved = await load(use.package_id, use.version);
    const manifest = resolved.artifact.manifest;
    if (manifest.compatibleWake !== compilerVersion) {
      fail(`${manifest.packageId}@${manifest.version} requires Wake ${manifest.compatibleWake}, not ${compilerVersion}`);
    }
    for (const dependency of manifest.dependencies) await load(dependency.packageId, dependency.version);
    direct.push({ ...resolved, use });
  }

  for (const { artifact, use } of direct) {
    const checked = checkedConfiguration(use, artifact.manifest);
    const declarations = configurationDeclarationIndex(
      checked.declarations,
      `plugin '${artifact.manifest.packageId}' configuration declarations`,
    );
    const entryFile = artifact.files.find((file) => file.path === artifact.manifest.entry);
    if (entryFile === undefined) fail(`plugin '${artifact.manifest.packageId}' entry is absent`);
    const program = parseProgramConfiguredAt(
      entryFile.content,
      artifact.manifest.entry,
      artifact.manifest.packageId,
      artifact.manifest.version,
      checked.references,
    );
    const contribution = qualifyPluginProgram(
      program,
      use,
      artifact.manifest,
      declarations,
    );
    const target = direct.find((candidate) => candidate.use === use);
    target.configuration = checked.canonical;
    target.configurationDeclarations = declarations;
    target.contribution = contribution;
  }

  let linked = { ...root };
  let router = root.router;
  let routeTemplates = [];
  let theme = root.theme;
  let layout = root.layout;
  const sourceUnits = [root.source_unit];
  const declarationProvenance = [...root.declaration_provenance];
  for (const { artifact, contribution } of direct) {
    linked.entities = appendUnique(linked.entities, contribution.entities, "entity");
    linked.defstates = appendUnique(linked.defstates, contribution.defstates, "defstate");
    linked.publications = appendUnique(linked.publications, contribution.publications, "publication");
    linked.value_types = appendUnique(
      linked.value_types ?? [],
      contribution.valueTypes,
      "value type",
    );
    linked.provider_ports = appendUnique(
      linked.provider_ports ?? [],
      contribution.providerPorts,
      "provider port",
    );
    linked.queries = appendUnique(linked.queries ?? [], contribution.queries, "query");
    linked.commands = appendUnique(linked.commands ?? [], contribution.commands, "command");
    linked.components = appendUnique(linked.components, contribution.components, "component");
    linked.views = appendUnique(linked.views, contribution.views, "view");
    linked.forms = appendUnique(linked.forms, contribution.forms, "form");
    linked.list_details = appendUnique(
      linked.list_details,
      contribution.listDetails,
      "list detail",
      (detail) => detail.entity_name,
    );
    routeTemplates = appendUnique(
      routeTemplates,
      contribution.routeTemplates,
      "route template",
      (route) => route.path,
    );
    if (contribution.theme !== null) {
      if (theme !== null) fail(`plugin '${artifact.manifest.packageId}' conflicts with application theme`);
      theme = contribution.theme;
    }
    if (contribution.layout !== null) {
      if (layout !== null) fail(`plugin '${artifact.manifest.packageId}' conflicts with application layout`);
      layout = contribution.layout;
    }
    sourceUnits.push(contribution.sourceUnit);
    declarationProvenance.push(...contribution.declarationProvenance);
  }

  const closure = direct.map(({ artifact, configuration, entry, use }) => ({
    alias: use.alias,
    allowedContributions: [...use.allow],
    artifactDigest: entry.digest,
    configuration,
    configurationDigest: sha256Digest(canonicalDocument(configuration)),
    durableSchemaVersion: artifact.manifest.durableSchemaVersion,
    migrationOrdinal: maximumMigrationOrdinal(artifact.manifest),
    packageId: artifact.manifest.packageId,
    source: { ...entry.source },
    version: artifact.manifest.version,
  }));
  linked = ensureCommandReceiptCore({
    ...linked,
    declaration_provenance: declarationProvenance,
    layout,
    plugin_closure: closure,
    route_templates: routeTemplates,
    router,
    semantic_fingerprint: null,
    source_units: sourceUnits,
    theme,
  });
  linked = applyApplicationComposition(linked, direct);
  return { linked, resolved: direct };
}

function storageProjection(checked) {
  return {
    applicationId: checked.application_id,
    entities: checked.entities.map((entity) => ({
      fields: entity.fields.map((field) => ({ name: field.name, storageId: field.storage_id })),
      name: entity.name,
      storageId: entity.storage_id,
    })),
  };
}

function stateSchema(checked) {
  return {
    entities: checked.entities.map((entity) => ({
      fields: entity.fields.map((field) => ({
        cardinality: field.cardinality,
        derived: field.derived,
        identity: field.identity,
        name: field.name,
        storageId: field.storage_id,
        targetEntity: field.target_entity,
        type: field.type,
        write: field.write_policy,
      })),
      name: entity.name,
      storageId: entity.storage_id,
    })),
    publications: semanticValue(checked.publications),
    stateMachines: semanticValue(checked.state_machines),
  };
}

function operationSurface(resolved) {
  return resolved.map(({ artifact, use }) => {
    const allowed = new Set(use.allow);
    const exports = {};
    const categoryContribution = {
      capabilities: "capability",
      commands: "command",
      components: "ui",
      entities: "schema",
      providerPorts: "capability",
      queries: "query",
      routes: "route",
      states: "schema",
      valueTypes: "schema",
    };
    for (const [category, contribution] of Object.entries(categoryContribution)) {
      if (allowed.has(contribution) && category in artifact.manifest.exports) {
        exports[category] = artifact.manifest.exports[category];
      }
    }
    return { exports, packageId: artifact.manifest.packageId, version: artifact.manifest.version };
  });
}

function checkedOperationSurface(checked, resolved) {
  return {
    composition: {
      extensions: semanticValue(checked.extensions ?? []),
      fills: semanticValue(checked.fills ?? []),
      mounts: semanticValue(checked.mounts ?? []),
      providers: semanticValue(checked.providers ?? []),
    },
    commands: semanticValue(checked.commands ?? []),
    exports: operationSurface(resolved),
    queries: semanticValue(checked.queries ?? []),
  };
}

function compilerSourceCommit(webRoot) {
  const result = Bun.spawnSync(["git", "-C", webRoot, "rev-parse", "HEAD"], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const commit = result.stdout.toString().trim();
  if (result.exitCode !== 0 || !/^[0-9a-f]{40}$/u.test(commit)) {
    fail("could not determine the Wake source commit");
  }
  return commit;
}

function applicationManifest({
  browserClient,
  checked,
  compilerCommit,
  compilerVersion,
  fingerprint,
  framPlan,
  generatedJavaScript,
  resolved,
}) {
  const plugins = checked.plugin_closure.map((plugin) => ({
    alias: plugin.alias,
    allowedContributions: plugin.allowedContributions,
    artifactDigest: plugin.artifactDigest,
    configuration: plugin.configuration,
    configurationDigest: plugin.configurationDigest,
    durableSchemaVersion: plugin.durableSchemaVersion,
    migrationOrdinal: plugin.migrationOrdinal,
    packageId: plugin.packageId,
    source: plugin.source,
    version: plugin.version,
  }));
  const hostCapabilities = [...new Set(
    resolved.flatMap(({ artifact }) => artifact.manifest.requiredHostCapabilities),
  )].sort();
  return {
    applicationId: checked.application_id,
    artifacts: {
      browserClient: { path: "wake-client.js", sha256: sha256Digest(browserClient) },
      browserJavaScript: { path: "app.js", sha256: sha256Digest(generatedJavaScript) },
      framPlan: { path: "app.fram.json", sha256: sha256Digest(framPlan) },
    },
    checkedApplication: { fingerprint, schemaVersion: checked.schema_version },
    compiler: { name: COMPILER_NAME, sourceCommit: compilerCommit, version: compilerVersion },
    digests: {
      operationSurface: sha256Digest(canonicalDocument(checkedOperationSurface(checked, resolved))),
      stateSchema: sha256Digest(canonicalDocument(stateSchema(checked))),
      storageProjection: sha256Digest(canonicalDocument(storageProjection(checked))),
    },
    hostCapabilities,
    plugins,
    protocols: {
      framPlanSchemaVersion: FRAM_PLAN_SCHEMA_VERSION,
      httpOperationProtocolVersion: HTTP_OPERATION_PROTOCOL_VERSION,
      pluginAbiVersion: pluginContractVersions.pluginAbi,
    },
    schemaVersion: DRIVER_SCHEMA_VERSION,
  };
}

async function writeOutput(path, contents) {
  if (path === "-") {
    await Bun.write(Bun.stdout, contents);
    return;
  }
  await Bun.write(path, contents);
}

async function main() {
  const options = parseArguments(Bun.argv.slice(2));
  const compilerDirectory = import.meta.dir;
  const webRoot = dirname(compilerDirectory);
  const packageDocument = JSON.parse(await Bun.file(join(webRoot, "package.json")).text());
  const compilerVersion = nonempty(packageDocument.version, "Wake compiler version");
  const distUrl = Bun.pathToFileURL(`${options.dist.replace(/\/+$/u, "")}/`);
  const {
    parse_program_at: parseProgramAt,
    parse_program_configured_at: parseProgramConfiguredAt,
  } = await import(new URL("reader.js", distUrl).href);
  const { check_program: checkProgram } = await import(new URL("graph.js", distUrl).href);
  const { gen_program_bang: generateProgram } = await import(new URL("codegen.js", distUrl).href);
  const { gen_fram: generateFram } = await import(new URL("emit-fram.js", distUrl).href);
  const { generateWakeClient } = await import("./emit-client.mjs");
  const sourceText = await Bun.file(options.source).text();

  const root = /^#lang[ \t]+beagle\/js[ \t]*$/u.test(sourceText.split("\n", 1)[0])
    ? projectCheckedBeagle(options.source, sourceText, compilerVersion)
    : parseProgramAt(
        sourceText,
        basename(options.source),
        "application",
        compilerVersion,
      );
  const { linked, resolved } = await linkProgram(
    root,
    options.source,
    compilerVersion,
    parseProgramConfiguredAt,
  );
  const checkedGraph = checkProgram(linked);
  const checked = {
    ...checkedGraph,
    commands: checkCommandGraph(checkedGraph.commands ?? [], checkedGraph),
  };
  const fingerprint = sha256Digest(canonicalDocument(semanticValue(checked)));
  const checkedWithFingerprint = { ...checked, semantic_fingerprint: fingerprint };

  if (options.mode === "js") {
    const generated = `// wake: checked-application ${fingerprint}\n${generateProgram(checkedWithFingerprint)}`;
    await writeOutput(options.output, generated);
    return;
  }
  if (options.mode === "fram") {
    await writeOutput(options.output, generateFram(checkedWithFingerprint));
    return;
  }

  const generatedJavaScript = `// wake: checked-application ${fingerprint}\n${generateProgram(checkedWithFingerprint)}`;
  const browserClient = generateWakeClient(checkedWithFingerprint);
  const framPlan = generateFram(checkedWithFingerprint);
  const manifest = applicationManifest({
    browserClient,
    checked: checkedWithFingerprint,
    compilerCommit: compilerSourceCommit(webRoot),
    compilerVersion,
    fingerprint,
    framPlan,
    generatedJavaScript,
    resolved,
  });
  const manifestDocument = canonicalDocument(manifest);
  const deploymentReceipt = generateDeploymentReceipt({
    browserClient,
    browserJavaScript: generatedJavaScript,
    framPlan,
    manifest: manifestDocument,
  });
  await Bun.write(join(options.output, "app.js"), generatedJavaScript);
  await Bun.write(join(options.output, "wake-client.js"), browserClient);
  await Bun.write(join(options.output, "app.fram.json"), framPlan);
  await Bun.write(join(options.output, "app.wake.manifest.json"), manifestDocument);
  await Bun.write(join(options.output, "app.wake.deployment.json"), deploymentReceipt);
}

await main();
