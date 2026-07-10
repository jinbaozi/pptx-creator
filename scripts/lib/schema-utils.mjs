function jsonTypeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function resolveLocalRef(rootSchema, ref) {
  if (!ref.startsWith("#/")) return null;
  return ref.slice(2).split("/").reduce((node, part) => node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")], rootSchema);
}

function validateValue(value, schema, path, errors, rootSchema) {
  if (schema === true) return;
  if (schema === false) {
    errors.push({ path, message: "value not allowed" });
    return;
  }
  if (schema.$ref) {
    const target = resolveLocalRef(rootSchema, schema.$ref);
    if (!target) errors.push({ path, message: `unresolved local $ref ${schema.$ref}` });
    else validateValue(value, target, path, errors, rootSchema);
    return;
  }
  if (Array.isArray(schema.type)) {
    const actual = jsonTypeOf(value);
    if (!schema.type.includes(actual) && !(schema.type.includes("integer") && typeof value === "number" && Number.isInteger(value))) {
      errors.push({ path, message: `expected type ${schema.type.join("|")}, got ${actual}` });
      return;
    }
  } else if (typeof schema.type === "string") {
    const actual = jsonTypeOf(value);
    if (actual !== schema.type) {
      if (!(schema.type === "integer" && typeof value === "number" && Number.isInteger(value))) {
        errors.push({ path, message: `expected type ${schema.type}, got ${actual}` });
        return;
      }
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({ path, message: `value must be one of ${JSON.stringify(schema.enum)}` });
  }
  if (Object.prototype.hasOwnProperty.call(schema, "const") && value !== schema.const) {
    errors.push({ path, message: `value must equal ${JSON.stringify(schema.const)}` });
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push({ path, message: `string shorter than minLength ${schema.minLength}` });
    }
    if (typeof schema.pattern === "string" && !(new RegExp(schema.pattern).test(value))) {
      errors.push({ path, message: `string does not match pattern ${schema.pattern}` });
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push({ path, message: `string longer than maxLength ${schema.maxLength}` });
    }
    if (schema.format === "date-time" && isNaN(Date.parse(value))) {
      errors.push({ path, message: `string is not a valid date-time` });
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push({ path, message: `number less than minimum ${schema.minimum}` });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push({ path, message: `number greater than maximum ${schema.maximum}` });
    }
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
      errors.push({ path, message: `number not greater than exclusiveMinimum ${schema.exclusiveMinimum}` });
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push({ path, message: `array shorter than minItems ${schema.minItems}` });
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push({ path, message: `array longer than maxItems ${schema.maxItems}` });
    }
    if (schema.items) {
      value.forEach((item, index) => {
        validateValue(item, schema.items, `${path}[${index}]`, errors, rootSchema);
      });
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          errors.push({ path, message: `missing required property "${key}"` });
        }
      }
    }
    if (schema.properties) {
      for (const key of Object.keys(schema.properties)) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          validateValue(value[key], schema.properties[key], `${path}.${key}`, errors, rootSchema);
        }
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          errors.push({ path, message: `unexpected property "${key}"` });
        }
      }
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      const allowed = new Set(schema.properties ? Object.keys(schema.properties) : []);
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          validateValue(value[key], schema.additionalProperties, `${path}.${key}`, errors, rootSchema);
        }
      }
    }
    if (schema.propertyNames) {
      for (const key of Object.keys(value)) validateValue(key, schema.propertyNames, `${path}.{${key}}`, errors, rootSchema);
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      validateValue(value, sub, path, errors, rootSchema);
    }
  }
  if (Array.isArray(schema.anyOf)) {
    let anyMatched = false;
    for (const sub of schema.anyOf) {
      const subErrors = [];
      validateValue(value, sub, `${path}[anyOf]`, subErrors, rootSchema);
      if (subErrors.length === 0) {
        anyMatched = true;
        break;
      }
    }
    if (!anyMatched) {
      errors.push({ path, message: `value did not match any of ${schema.anyOf.length} anyOf branches` });
    }
  }
  if (Array.isArray(schema.oneOf)) {
    let matches = 0;
    for (const sub of schema.oneOf) {
      const subErrors = [];
      validateValue(value, sub, `${path}[oneOf]`, subErrors, rootSchema);
      if (subErrors.length === 0) matches += 1;
    }
    if (matches !== 1) errors.push({ path, message: `value matched ${matches} of ${schema.oneOf.length} oneOf branches` });
  }
  if (schema.if && typeof schema.if === "object") {
    const branchErrors = [];
    validateValue(value, schema.if, `${path}[if]`, branchErrors, rootSchema);
    const matchesIf = branchErrors.length === 0;
    if (matchesIf && schema.then) {
      validateValue(value, schema.then, `${path}[then]`, errors, rootSchema);
    } else if (!matchesIf && schema.else) {
      validateValue(value, schema.else, `${path}[else]`, errors, rootSchema);
    }
  }
  if (schema.not) {
    const notErrors = [];
    validateValue(value, schema.not, `${path}[not]`, notErrors, rootSchema);
    if (notErrors.length === 0) {
      errors.push({ path, message: "value must not match the not schema" });
    }
  }
}

export function validateJsonSchema(value, schema) {
  const errors = [];
  validateValue(value, schema, "$", errors, schema);
  return { valid: errors.length === 0, errors };
}

export async function readJson(relativePath) {
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  return JSON.parse(await readFile(resolve(relativePath), "utf8"));
}

export function validateSchema(schema, value, name = "value") {
  const { valid, errors } = validateJsonSchema(value, schema);
  if (!valid) {
    throw new Error(`${name} fails schema: ${errors.map(e => `${e.path} ${e.message}`).join("; ")}`);
  }
}
