function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function toBeagleValue(value, jsToClj, seen = new WeakMap()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    const result = [];
    seen.set(value, result);
    for (const item of value) result.push(toBeagleValue(item, jsToClj, seen));
    return result;
  }
  if (!plainObject(value)) return jsToClj(value);

  const entries = Object.entries(value);
  if (typeof value._tag === "string") {
    const result = {};
    seen.set(value, result);
    for (const [key, item] of entries) {
      result[key] = toBeagleValue(item, jsToClj, seen);
    }
    return result;
  }

  const result = jsToClj(Object.fromEntries(
    entries.map(([key], index) => [key, index]),
  ));
  seen.set(value, result);
  for (const [key, index] of Object.entries(result)) {
    result[key] = toBeagleValue(entries[index][1], jsToClj, seen);
  }
  return result;
}
