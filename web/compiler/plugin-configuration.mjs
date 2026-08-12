const DECLARATION_KINDS = new Set([
  "capability",
  "command",
  "component",
  "entity",
  "field",
  "provider-port",
  "query",
  "route",
  "state",
  "value-type",
]);

function defaultReject(message) {
  throw new TypeError(message);
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(value, key) {
  return Object.hasOwn(value, key);
}

function exactKeys(value, required, optional, label, reject) {
  if (!plainObject(value)) reject(`${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) reject(`${label} contains unknown key '${key}'`);
  }
  for (const key of required) {
    if (!own(value, key)) reject(`${label} requires ${key}`);
  }
}

function nonempty(value, label, reject) {
  if (typeof value !== "string" || value.length === 0) {
    reject(`${label} must be a nonempty string`);
  }
  return value;
}

function pathPart(value, label, reject) {
  nonempty(value, label, reject);
  if (value.includes(".")) reject(`${label} must not contain '.'`);
  return value;
}

function nonnegativeBound(value, label, reject) {
  if (!Number.isSafeInteger(value) || value < 0) {
    reject(`${label} must be a nonnegative safe integer`);
  }
}

function integerBound(value, label, reject) {
  if (!Number.isSafeInteger(value)) reject(`${label} must be a safe integer`);
}

function validateStringBounds(type, label, reject) {
  for (const name of ["minLength", "maxLength", "maxBytes"]) {
    if (own(type, name)) nonnegativeBound(type[name], `${label}.${name}`, reject);
  }
  if (own(type, "minLength") && own(type, "maxLength")
      && type.minLength > type.maxLength) {
    reject(`${label}.minLength must not exceed maxLength`);
  }
}

function validateIntegerBounds(type, label, reject) {
  if (own(type, "minimum")) integerBound(type.minimum, `${label}.minimum`, reject);
  if (own(type, "maximum")) integerBound(type.maximum, `${label}.maximum`, reject);
  if (own(type, "minimum") && own(type, "maximum")
      && type.minimum > type.maximum) {
    reject(`${label}.minimum must not exceed maximum`);
  }
}

function validateType(type, label, declarations, reject) {
  if (!plainObject(type)) reject(`${label} must be an object`);
  const kind = nonempty(type.kind, `${label}.kind`, reject);
  switch (kind) {
    case "string":
      exactKeys(type, ["kind"], ["maxBytes", "maxLength", "minLength"], label, reject);
      validateStringBounds(type, label, reject);
      break;
    case "integer":
      exactKeys(type, ["kind"], ["maximum", "minimum"], label, reject);
      validateIntegerBounds(type, label, reject);
      break;
    case "boolean":
    case "keyword":
      exactKeys(type, ["kind"], [], label, reject);
      break;
    case "symbol": {
      exactKeys(
        type,
        ["declarationKind", "kind"],
        ["declarationId"],
        label,
        reject,
      );
      nonempty(type.declarationKind, `${label}.declarationKind`, reject);
      if (!DECLARATION_KINDS.has(type.declarationKind)) {
        reject(`${label}.declarationKind '${type.declarationKind}' is unsupported`);
      }
      if (own(type, "declarationId")) {
        nonempty(type.declarationId, `${label}.declarationId`, reject);
        const declarationKey = `${type.declarationKind}\u0000${type.declarationId}`;
        if (declarations.has(declarationKey)) {
          reject(
            `${label}.declarationId repeats ${type.declarationKind} '${type.declarationId}'`,
          );
        }
        declarations.add(declarationKey);
      }
      break;
    }
    case "record": {
      exactKeys(type, ["closed", "fields", "kind"], [], label, reject);
      if (type.closed !== true) reject(`${label}.closed must be true`);
      if (!Array.isArray(type.fields)) reject(`${label}.fields must be an array`);
      const names = new Set();
      for (const [index, field] of type.fields.entries()) {
        const fieldLabel = `${label}.fields[${index}]`;
        exactKeys(field, ["name", "required", "type"], [], fieldLabel, reject);
        pathPart(field.name, `${fieldLabel}.name`, reject);
        if (names.has(field.name)) reject(`${label}.fields repeats '${field.name}'`);
        names.add(field.name);
        if (typeof field.required !== "boolean") {
          reject(`${fieldLabel}.required must be boolean`);
        }
        validateType(field.type, `${fieldLabel}.type`, declarations, reject);
      }
      break;
    }
    default:
      reject(`${label}.kind '${kind}' is unsupported`);
  }
  return type;
}

export function validateConfigurationSchema(
  configuration,
  label = "manifest.configuration",
  reject = defaultReject,
) {
  if (!plainObject(configuration)) reject(`${label} must be an object`);
  const declarations = new Set();
  for (const [key, descriptor] of Object.entries(configuration)) {
    pathPart(key, `${label} key`, reject);
    exactKeys(descriptor, ["required", "type"], [], `${label}.${key}`, reject);
    if (typeof descriptor.required !== "boolean") {
      reject(`${label}.${key}.required must be boolean`);
    }
    validateType(descriptor.type, `${label}.${key}.type`, declarations, reject);
  }
  return configuration;
}

function symbolName(value) {
  return value?._tag === "Sym" && typeof value.name === "string" ? value.name : null;
}

function keywordName(value) {
  return value?._tag === "Kw" && typeof value.name === "string" ? value.name : null;
}

function recordItems(value) {
  return value?._tag === "SexprVec" && Array.isArray(value.items) ? value.items : null;
}

function checkedRecordEntries(value, type, label, reject) {
  const items = recordItems(value);
  if (items === null) reject(`${label} must be a record vector`);
  if (items.length % 2 !== 0) reject(`${label} must contain name/value pairs`);
  const supplied = new Map();
  for (let index = 0; index < items.length; index += 2) {
    const key = symbolName(items[index]);
    if (key === null) reject(`${label} keys must be symbols`);
    if (supplied.has(key)) reject(`${label} repeats '${key}'`);
    supplied.set(key, { keySource: items[index], value: items[index + 1] });
  }
  const fields = new Map(type.fields.map(field => [field.name, field]));
  if (type.closed) {
    for (const key of supplied.keys()) {
      if (!fields.has(key)) reject(`${label}.${key} is unknown`);
    }
  }
  for (const field of type.fields) {
    if (field.required && !supplied.has(field.name)) {
      reject(`${label}.${field.name} is required`);
    }
  }
  return supplied;
}

function checkedValue(value, type, label, path, references, declarations, reject) {
  let canonical;
  let source = value;
  switch (type.kind) {
    case "string": {
      if (typeof value !== "string") reject(`${label} must be a string`);
      const scalarLength = [...value].length;
      const byteLength = new TextEncoder().encode(value).byteLength;
      if (own(type, "minLength") && scalarLength < type.minLength) {
        reject(`${label} is shorter than ${type.minLength} scalar values`);
      }
      if (own(type, "maxLength") && scalarLength > type.maxLength) {
        reject(`${label} exceeds ${type.maxLength} scalar values`);
      }
      if (own(type, "maxBytes") && byteLength > type.maxBytes) {
        reject(`${label} exceeds ${type.maxBytes} UTF-8 bytes`);
      }
      canonical = value;
      break;
    }
    case "integer":
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
        reject(`${label} must be an integer`);
      }
      if (own(type, "minimum") && value < type.minimum) {
        reject(`${label} must be at least ${type.minimum}`);
      }
      if (own(type, "maximum") && value > type.maximum) {
        reject(`${label} must be at most ${type.maximum}`);
      }
      canonical = value;
      break;
    case "boolean": {
      const spelling = symbolName(value);
      if (typeof value === "boolean") canonical = value;
      else if (spelling === "true") canonical = true;
      else if (spelling === "false") canonical = false;
      else reject(`${label} must be boolean`);
      break;
    }
    case "symbol": {
      const name = symbolName(value);
      if (name === null || name.length === 0) reject(`${label} must be a symbol`);
      canonical = { symbol: name };
      if (own(type, "declarationId")) {
        declarations.push({
          alias: name,
          declarationId: type.declarationId,
          declarationKind: type.declarationKind,
          path,
        });
      }
      break;
    }
    case "keyword": {
      const name = keywordName(value);
      if (name === null || name.length <= 1) reject(`${label} must be a keyword`);
      canonical = { keyword: name };
      break;
    }
    case "record": {
      const supplied = checkedRecordEntries(value, type, label, reject);
      const canonicalRecord = {};
      const sourceItems = [];
      for (const field of [...type.fields].sort((left, right) =>
        left.name.localeCompare(right.name))) {
        const entry = supplied.get(field.name);
        if (entry === undefined) continue;
        const checked = checkedValue(
          entry.value,
          field.type,
          `${label}.${field.name}`,
          `${path}.${field.name}`,
          references,
          declarations,
          reject,
        );
        canonicalRecord[field.name] = checked.canonical;
        sourceItems.push(entry.keySource, checked.source);
      }
      canonical = canonicalRecord;
      source = { ...value, items: sourceItems };
      break;
    }
    default:
      reject(`${label} uses unsupported configuration type '${type.kind}'`);
  }
  references.set(path, source);
  return { canonical, source };
}

export function checkPluginConfiguration(
  entries,
  configuration,
  label,
  reject = defaultReject,
) {
  validateConfigurationSchema(configuration, "manifest.configuration", reject);
  if (!Array.isArray(entries)) reject(`${label} must be a configuration entry array`);
  const supplied = new Map();
  for (const entry of entries) {
    if (!plainObject(entry) || typeof entry.key !== "string" || !own(entry, "value")) {
      reject(`${label} contains an invalid configuration entry`);
    }
    if (supplied.has(entry.key)) reject(`${label} repeats configuration '${entry.key}'`);
    supplied.set(entry.key, entry.value);
  }
  for (const key of supplied.keys()) {
    if (!own(configuration, key)) reject(`${label} supplies unknown configuration '${key}'`);
  }

  const canonical = {};
  const references = new Map();
  const declarations = [];
  for (const key of Object.keys(configuration).sort()) {
    const descriptor = configuration[key];
    if (!supplied.has(key)) {
      if (descriptor.required) reject(`${label} requires configuration '${key}'`);
      continue;
    }
    const checked = checkedValue(
      supplied.get(key),
      descriptor.type,
      `${label} configuration '${key}'`,
      key,
      references,
      declarations,
      reject,
    );
    canonical[key] = checked.canonical;
  }
  return { canonical, declarations, references };
}

export function configurationDeclarationDescriptors(configuration) {
  const result = [];
  const visit = (type, path) => {
    if (type.kind === "symbol" && own(type, "declarationId")) {
      result.push({
        declarationId: type.declarationId,
        declarationKind: type.declarationKind,
        path,
      });
    }
    if (type.kind === "record") {
      for (const field of type.fields) visit(field.type, `${path}.${field.name}`);
    }
  };
  for (const [key, descriptor] of Object.entries(configuration)) {
    visit(descriptor.type, key);
  }
  return result;
}
