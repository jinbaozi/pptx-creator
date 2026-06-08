function assertObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
}

function assertArray(value, path) {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
}

function assertString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string`);
  }
}

function assertNumber(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
}

export function assertStoryboard(storyboard) {
  assertObject(storyboard, "storyboard");
  for (const key of ["title", "audience", "goal", "language"]) {
    assertString(storyboard[key], `storyboard.${key}`);
  }
  assertArray(storyboard.slides, "storyboard.slides");
  if (storyboard.slides.length === 0) throw new Error("storyboard.slides must not be empty");
  storyboard.slides.forEach((slide, index) => {
    assertObject(slide, `storyboard.slides[${index}]`);
    for (const key of ["id", "role", "message"]) {
      assertString(slide[key], `storyboard.slides[${index}].${key}`);
    }
    assertArray(slide.contentBlocks, `storyboard.slides[${index}].contentBlocks`);
  });
}

export function assertDesignDirection(direction) {
  assertObject(direction, "designDirection");
  assertString(direction.style, "designDirection.style");
  assertArray(direction.tone, "designDirection.tone");
  assertObject(direction.palette, "designDirection.palette");
  for (const key of ["background", "surface", "primary", "accent", "text"]) {
    assertString(direction.palette[key], `designDirection.palette.${key}`);
  }
  assertObject(direction.typography, "designDirection.typography");
  assertString(direction.typography.title, "designDirection.typography.title");
  assertString(direction.typography.body, "designDirection.typography.body");
  assertString(direction.layoutStrategy, "designDirection.layoutStrategy");
  assertArray(direction.avoid, "designDirection.avoid");
}

export function assertSlideDesignSpecs(specs) {
  assertObject(specs, "slideDesignSpecs");
  assertArray(specs.slides, "slideDesignSpecs.slides");
  if (specs.slides.length === 0) throw new Error("slideDesignSpecs.slides must not be empty");
  specs.slides.forEach((slide, index) => {
    assertObject(slide, `slideDesignSpecs.slides[${index}]`);
    for (const key of ["id", "layoutType", "intent", "mainIdea"]) {
      assertString(slide[key], `slideDesignSpecs.slides[${index}].${key}`);
    }
    assertObject(slide.visualPlan, `slideDesignSpecs.slides[${index}].visualPlan`);
    assertString(slide.visualPlan.focalPoint, `slideDesignSpecs.slides[${index}].visualPlan.focalPoint`);
    assertString(slide.visualPlan.density, `slideDesignSpecs.slides[${index}].visualPlan.density`);
    assertObject(slide.visualPlan.visualWeight, `slideDesignSpecs.slides[${index}].visualPlan.visualWeight`);
    assertArray(slide.contentSlots, `slideDesignSpecs.slides[${index}].contentSlots`);
    assertNumber(slide.editableTarget, `slideDesignSpecs.slides[${index}].editableTarget`);
  });
}

function jsonTypeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validateValue(value, schema, path, errors) {
  if (schema === true) return;
  if (schema === false) {
    errors.push({ path, message: "value not allowed" });
    return;
  }
  if (schema.$ref) {
    errors.push({ path, message: `$ref not supported in lightweight validator: ${schema.$ref}` });
    return;
  }
  if (Array.isArray(schema.type)) {
    const actual = jsonTypeOf(value);
    if (!schema.type.includes(actual)) {
      errors.push({ path, message: `expected type ${schema.type.join("|")}, got ${actual}` });
      return;
    }
  } else if (typeof schema.type === "string") {
    const actual = jsonTypeOf(value);
    if (actual !== schema.type) {
      errors.push({ path, message: `expected type ${schema.type}, got ${actual}` });
      return;
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
    if (schema.items) {
      value.forEach((item, index) => {
        validateValue(item, schema.items, `${path}[${index}]`, errors);
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
          validateValue(value[key], schema.properties[key], `${path}.${key}`, errors);
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
          validateValue(value[key], schema.additionalProperties, `${path}.${key}`, errors);
        }
      }
    }
  }
}

export function validateJsonSchema(value, schema) {
  const errors = [];
  validateValue(value, schema, "$", errors);
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
