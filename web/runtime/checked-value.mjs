const DEFAULT_MAX_DESCRIPTOR_DEPTH = 128;

export class CheckedValueError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "CheckedValueError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new CheckedValueError(code, message);
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(value, key) {
  return Object.hasOwn(value, key);
}

function enumerableData(value, key, label, code) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
    fail(code, `${label}.${String(key)} must be an enumerable data property`);
  }
  return descriptor.value;
}

function exactOwnKeys(value, expected, label, code) {
  if (!plainObject(value)) fail(code, `${label} must be a plain object`);
  const allowed = new Set(expected);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      fail(code, `${label} contains unsupported property ${String(key)}`);
    }
    enumerableData(value, key, label, code);
  }
}

function nonempty(value, label, code) {
  if (typeof value !== "string" || value.length === 0) {
    fail(code, `${label} must be a nonempty string`);
  }
  return value;
}

function bound(value, label, code, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    fail(code, `${label} must be a ${positive ? "positive" : "nonnegative"} safe integer`);
  }
  return value;
}

function scalarLiteral(value, label, code) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
  fail(code, `${label} must be a scalar JSON literal`);
}

function defineData(target, key, value) {
  Object.defineProperty(target, key, {
    enumerable: true,
    value,
  });
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}

function descriptorRecord(value, required, optional, label, code) {
  exactOwnKeys(value, [...required, ...optional], label, code);
  for (const key of required) {
    if (!own(value, key)) fail(code, `${label}.${key} is required`);
  }
}

function cloneField(field, label, visit, code) {
  descriptorRecord(field, ["name", "required", "value"], [], label, code);
  const name = nonempty(enumerableData(field, "name", label, code), `${label}.name`, code);
  const required = enumerableData(field, "required", label, code);
  if (typeof required !== "boolean") fail(code, `${label}.required must be boolean`);
  return {
    name,
    required,
    value: visit(enumerableData(field, "value", label, code), `${label}.value`),
  };
}

function checkedDescriptor(source, code) {
  const definitions = new Map();
  const referenced = new Set();

  const visit = (value, label, depth = 0) => {
    if (depth > DEFAULT_MAX_DESCRIPTOR_DEPTH) {
      fail(code, `${label} exceeds descriptor depth ${DEFAULT_MAX_DESCRIPTOR_DEPTH}`);
    }
    if (!plainObject(value)) fail(code, `${label} must be a type descriptor`);
    const kind = nonempty(enumerableData(value, "kind", label, code), `${label}.kind`, code);
    switch (kind) {
      case "string": {
        descriptorRecord(value, ["kind"], ["maxBytes", "maxLength", "minLength"], label, code);
        const result = { kind };
        for (const name of ["minLength", "maxLength", "maxBytes"]) {
          if (own(value, name)) result[name] = bound(
            enumerableData(value, name, label, code),
            `${label}.${name}`,
            code,
          );
        }
        if (result.minLength !== undefined && result.maxLength !== undefined
            && result.minLength > result.maxLength) {
          fail(code, `${label}.minLength must not exceed maxLength`);
        }
        return result;
      }
      case "integer": {
        descriptorRecord(value, ["kind"], ["maximum", "minimum"], label, code);
        const result = { kind };
        for (const name of ["minimum", "maximum"]) {
          if (own(value, name)) {
            const valueBound = enumerableData(value, name, label, code);
            if (!Number.isSafeInteger(valueBound)) fail(code, `${label}.${name} must be a safe integer`);
            result[name] = valueBound;
          }
        }
        if (result.minimum !== undefined && result.maximum !== undefined
            && result.minimum > result.maximum) {
          fail(code, `${label}.minimum must not exceed maximum`);
        }
        return result;
      }
      case "number":
      case "boolean":
        descriptorRecord(value, ["kind"], [], label, code);
        return { kind };
      case "literal":
        descriptorRecord(value, ["kind", "value"], [], label, code);
        return {
          kind,
          value: scalarLiteral(enumerableData(value, "value", label, code), `${label}.value`, code),
        };
      case "enum": {
        descriptorRecord(value, ["kind", "values"], [], label, code);
        const values = enumerableData(value, "values", label, code);
        if (!Array.isArray(values) || values.length === 0) {
          fail(code, `${label}.values must be a nonempty array`);
        }
        const checked = values.map((item, index) => scalarLiteral(
          enumerableData(values, String(index), `${label}.values`, code),
          `${label}.values[${index}]`,
          code,
        ));
        if (new Set(checked.map(item => `${typeof item}\u0000${String(item)}`)).size !== checked.length) {
          fail(code, `${label}.values contains a duplicate`);
        }
        return { kind, values: checked };
      }
      case "nullable":
        descriptorRecord(value, ["kind", "value"], [], label, code);
        return {
          kind,
          value: visit(enumerableData(value, "value", label, code), `${label}.value`, depth + 1),
        };
      case "list":
        descriptorRecord(value, ["items", "kind", "maxItems"], [], label, code);
        return {
          items: visit(enumerableData(value, "items", label, code), `${label}.items`, depth + 1),
          kind,
          maxItems: bound(
            enumerableData(value, "maxItems", label, code),
            `${label}.maxItems`,
            code,
          ),
        };
      case "record": {
        descriptorRecord(value, ["fields", "kind"], [], label, code);
        const fields = enumerableData(value, "fields", label, code);
        if (!Array.isArray(fields)) fail(code, `${label}.fields must be an array`);
        const checked = fields.map((field, index) => cloneField(
          enumerableData(fields, String(index), `${label}.fields`, code),
          `${label}.fields[${index}]`,
          (item, itemLabel) => visit(item, itemLabel, depth + 1),
          code,
        ));
        const names = new Set();
        for (const field of checked) {
          if (names.has(field.name)) fail(code, `${label}.fields repeats '${field.name}'`);
          names.add(field.name);
        }
        return { fields: checked, kind };
      }
      case "tagged": {
        descriptorRecord(value, ["kind", "tag", "variants"], [], label, code);
        const tag = nonempty(
          enumerableData(value, "tag", label, code),
          `${label}.tag`,
          code,
        );
        const variants = enumerableData(value, "variants", label, code);
        if (!Array.isArray(variants) || variants.length === 0) {
          fail(code, `${label}.variants must be a nonempty array`);
        }
        const checked = variants.map((variant, index) => {
          const variantLabel = `${label}.variants[${index}]`;
          descriptorRecord(variant, ["fields", "tag"], [], variantLabel, code);
          const variantTag = nonempty(
            enumerableData(variant, "tag", variantLabel, code),
            `${variantLabel}.tag`,
            code,
          );
          const fields = enumerableData(variant, "fields", variantLabel, code);
          if (!Array.isArray(fields)) fail(code, `${variantLabel}.fields must be an array`);
          const checkedFields = fields.map((field, fieldIndex) => cloneField(
            enumerableData(fields, String(fieldIndex), `${variantLabel}.fields`, code),
            `${variantLabel}.fields[${fieldIndex}]`,
            (item, itemLabel) => visit(item, itemLabel, depth + 1),
            code,
          ));
          const names = new Set([tag]);
          for (const field of checkedFields) {
            if (names.has(field.name)) fail(code, `${variantLabel}.fields repeats '${field.name}'`);
            names.add(field.name);
          }
          return { fields: checkedFields, tag: variantTag };
        });
        if (new Set(checked.map(variant => variant.tag)).size !== checked.length) {
          fail(code, `${label}.variants repeats a tag`);
        }
        return { kind, tag, variants: checked };
      }
      case "ref": {
        descriptorRecord(value, ["kind", "name"], [], label, code);
        const name = nonempty(
          enumerableData(value, "name", label, code),
          `${label}.name`,
          code,
        );
        referenced.add(name);
        return { kind, name };
      }
      case "bounded": {
        descriptorRecord(
          value,
          ["definitions", "kind", "maxBytes", "maxDepth", "maxNodes", "value"],
          [],
          label,
          code,
        );
        const sourceDefinitions = enumerableData(value, "definitions", label, code);
        if (!Array.isArray(sourceDefinitions) || sourceDefinitions.length === 0) {
          fail(code, `${label}.definitions must be a nonempty array`);
        }
        const placeholders = [];
        for (let index = 0; index < sourceDefinitions.length; index += 1) {
          const definition = enumerableData(
            sourceDefinitions,
            String(index),
            `${label}.definitions`,
            code,
          );
          const definitionLabel = `${label}.definitions[${index}]`;
          descriptorRecord(definition, ["name", "value"], [], definitionLabel, code);
          const name = nonempty(
            enumerableData(definition, "name", definitionLabel, code),
            `${definitionLabel}.name`,
            code,
          );
          if (definitions.has(name)) fail(code, `${label}.definitions repeats '${name}'`);
          definitions.set(name, null);
          placeholders.push({ definition, definitionLabel, name });
        }
        const checkedDefinitions = placeholders.map(({ definition, definitionLabel, name }) => {
          const checkedValue = visit(
            enumerableData(definition, "value", definitionLabel, code),
            `${definitionLabel}.value`,
            depth + 1,
          );
          definitions.set(name, checkedValue);
          return { name, value: checkedValue };
        });
        const result = {
          definitions: checkedDefinitions,
          kind,
          maxBytes: bound(
            enumerableData(value, "maxBytes", label, code),
            `${label}.maxBytes`,
            code,
            { positive: true },
          ),
          maxDepth: bound(
            enumerableData(value, "maxDepth", label, code),
            `${label}.maxDepth`,
            code,
            { positive: true },
          ),
          maxNodes: bound(
            enumerableData(value, "maxNodes", label, code),
            `${label}.maxNodes`,
            code,
            { positive: true },
          ),
          value: visit(enumerableData(value, "value", label, code), `${label}.value`, depth + 1),
        };
        for (const name of referenced) {
          if (!definitions.has(name)) fail(code, `${label} references unknown type '${name}'`);
        }
        return result;
      }
      default:
        fail(code, `${label}.kind '${kind}' is unsupported`);
    }
  };

  const descriptor = visit(source, "descriptor");
  if (descriptor.kind !== "bounded" && referenced.size > 0) {
    fail(code, "descriptor references require a bounded root with definitions");
  }
  return descriptor;
}

function scalarBytes(value, state, label) {
  if (typeof value !== "string") return;
  let scalars = 0;
  for (const scalar of value) {
    const point = scalar.codePointAt(0);
    if (point >= 0xd800 && point <= 0xdfff) {
      fail(state.code, `${label} contains an unpaired surrogate`);
    }
    scalars += 1;
  }
  state.bytes += state.encoder.encode(value).byteLength;
  if (state.bytes > state.maxBytes) {
    fail(state.code, `${state.rootLabel} exceeds ${state.maxBytes} aggregate UTF-8 bytes`);
  }
  return scalars;
}

function enterRecord(value, state, label, depth) {
  if (state.active.has(value)) fail(state.code, `${label} must not be cyclic`);
  const nextDepth = depth + 1;
  if (nextDepth > state.maxDepth) {
    fail(state.code, `${state.rootLabel} exceeds record depth ${state.maxDepth}`);
  }
  state.nodes += 1;
  if (state.nodes > state.maxNodes) {
    fail(state.code, `${state.rootLabel} exceeds ${state.maxNodes} record nodes`);
  }
  state.active.add(value);
  return nextDepth;
}

function checkedArray(value, label, state, maximum) {
  if (!Array.isArray(value)) fail(state.code, `${label} must be an array`);
  if (value.length > maximum) fail(state.code, `${label} exceeds ${maximum} items`);
  if (state.active.has(value)) fail(state.code, `${label} must not be cyclic`);
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)
        || Number(key) >= value.length) {
      fail(state.code, `${label} contains unsupported property ${String(key)}`);
    }
    enumerableData(value, key, label, state.code);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!own(value, index)) fail(state.code, `${label} must be dense`);
  }
}

function normalizedValue(value, descriptor, environment, state, label, depth, refStack) {
  switch (descriptor.kind) {
    case "bounded": {
      const nested = {
        ...state,
        bytes: 0,
        maxBytes: descriptor.maxBytes,
        maxDepth: descriptor.maxDepth,
        maxNodes: descriptor.maxNodes,
        nodes: 0,
        rootLabel: label,
      };
      return normalizedValue(value, descriptor.value, new Map(
        descriptor.definitions.map(definition => [definition.name, definition.value]),
      ), nested, label, 0, new Set());
    }
    case "ref": {
      if (refStack.has(descriptor.name)) {
        fail(state.code, `${label} reaches unguarded recursive type '${descriptor.name}'`);
      }
      const target = environment.get(descriptor.name);
      if (target === undefined) fail(state.code, `${label} references unknown type '${descriptor.name}'`);
      const next = new Set(refStack);
      next.add(descriptor.name);
      return normalizedValue(value, target, environment, state, label, depth, next);
    }
    case "string": {
      if (typeof value !== "string") fail(state.code, `${label} must be a string`);
      const length = scalarBytes(value, state, label);
      if (descriptor.minLength !== undefined && length < descriptor.minLength) {
        fail(state.code, `${label} is shorter than ${descriptor.minLength} scalar values`);
      }
      if (descriptor.maxLength !== undefined && length > descriptor.maxLength) {
        fail(state.code, `${label} exceeds ${descriptor.maxLength} scalar values`);
      }
      if (descriptor.maxBytes !== undefined
          && state.encoder.encode(value).byteLength > descriptor.maxBytes) {
        fail(state.code, `${label} exceeds ${descriptor.maxBytes} UTF-8 bytes`);
      }
      return value;
    }
    case "integer":
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
        fail(state.code, `${label} must be a safe integer`);
      }
      if (descriptor.minimum !== undefined && value < descriptor.minimum) {
        fail(state.code, `${label} must be at least ${descriptor.minimum}`);
      }
      if (descriptor.maximum !== undefined && value > descriptor.maximum) {
        fail(state.code, `${label} must be at most ${descriptor.maximum}`);
      }
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) {
        fail(state.code, `${label} must be a finite JSON number other than negative zero`);
      }
      return value;
    case "boolean":
      if (typeof value !== "boolean") fail(state.code, `${label} must be boolean`);
      return value;
    case "literal":
      if (!Object.is(value, descriptor.value)) {
        fail(state.code, `${label} must equal ${JSON.stringify(descriptor.value)}`);
      }
      scalarBytes(value, state, label);
      return value;
    case "enum":
      if (!descriptor.values.some(candidate => Object.is(candidate, value))) {
        fail(state.code, `${label} is not an allowed value`);
      }
      scalarBytes(value, state, label);
      return value;
    case "nullable":
      return value === null
        ? null
        : normalizedValue(value, descriptor.value, environment, state, label, depth, refStack);
    case "list": {
      checkedArray(value, label, state, descriptor.maxItems);
      state.active.add(value);
      try {
        const result = [];
        for (let index = 0; index < value.length; index += 1) {
          result.push(normalizedValue(
            enumerableData(value, String(index), label, state.code),
            descriptor.items,
            environment,
            state,
            `${label}[${index}]`,
            depth,
            new Set(),
          ));
        }
        return deepFreeze(result);
      } finally {
        state.active.delete(value);
      }
    }
    case "record": {
      const nextDepth = enterRecord(value, state, label, depth);
      try {
        exactOwnKeys(value, descriptor.fields.map(field => field.name), label, state.code);
        const result = Object.create(null);
        for (const field of descriptor.fields) {
          if (!own(value, field.name)) {
            if (field.required) fail(state.code, `${label}.${field.name} is required`);
            continue;
          }
          defineData(result, field.name, normalizedValue(
            enumerableData(value, field.name, label, state.code),
            field.value,
            environment,
            state,
            `${label}.${field.name}`,
            nextDepth,
            new Set(),
          ));
        }
        return deepFreeze(result);
      } finally {
        state.active.delete(value);
      }
    }
    case "tagged": {
      const nextDepth = enterRecord(value, state, label, depth);
      try {
        if (!plainObject(value)) fail(state.code, `${label} must be a plain object`);
        if (!own(value, descriptor.tag)) fail(state.code, `${label}.${descriptor.tag} is required`);
        const tag = enumerableData(value, descriptor.tag, label, state.code);
        if (typeof tag !== "string") fail(state.code, `${label}.${descriptor.tag} must be a string`);
        scalarBytes(tag, state, `${label}.${descriptor.tag}`);
        const variant = descriptor.variants.find(candidate => candidate.tag === tag);
        if (variant === undefined) fail(state.code, `${label}.${descriptor.tag} '${tag}' is unknown`);
        exactOwnKeys(
          value,
          [descriptor.tag, ...variant.fields.map(field => field.name)],
          label,
          state.code,
        );
        const result = Object.create(null);
        defineData(result, descriptor.tag, tag);
        for (const field of variant.fields) {
          if (!own(value, field.name)) {
            if (field.required) fail(state.code, `${label}.${field.name} is required`);
            continue;
          }
          defineData(result, field.name, normalizedValue(
            enumerableData(value, field.name, label, state.code),
            field.value,
            environment,
            state,
            `${label}.${field.name}`,
            nextDepth,
            new Set(),
          ));
        }
        return deepFreeze(result);
      } finally {
        state.active.delete(value);
      }
    }
    default:
      fail(state.code, `${label} uses unsupported checked type '${descriptor.kind}'`);
  }
}

export function compileCheckedValue(source, {
  descriptorCode = "checked-value/invalid-descriptor",
} = {}) {
  const descriptor = deepFreeze(checkedDescriptor(source, descriptorCode));
  return Object.freeze({
    descriptor,
    normalize(value, {
      code = "checked-value/type-mismatch",
      label = "value",
    } = {}) {
      const rootLimits = descriptor.kind === "bounded"
        ? descriptor
        : { maxBytes: Number.MAX_SAFE_INTEGER, maxDepth: 256, maxNodes: 65_536 };
      return normalizedValue(
        value,
        descriptor,
        new Map(),
        {
          active: new Set(),
          bytes: 0,
          code,
          encoder: new TextEncoder(),
          maxBytes: rootLimits.maxBytes,
          maxDepth: rootLimits.maxDepth,
          maxNodes: rootLimits.maxNodes,
          nodes: 0,
          rootLabel: label,
        },
        label,
        0,
        new Set(),
      );
    },
  });
}

export function normalizeCheckedValue(value, descriptor, options = {}) {
  return compileCheckedValue(descriptor).normalize(value, options);
}

export const safeUrlDescriptor = deepFreeze({
  kind: "tagged",
  tag: "kind",
  variants: [{
    fields: [{ name: "href", required: true, value: { kind: "string", minLength: 1 } }],
    tag: "external",
  }, {
    fields: [{ name: "reference", required: true, value: { kind: "string", minLength: 1 } }],
    tag: "internal",
  }],
});
