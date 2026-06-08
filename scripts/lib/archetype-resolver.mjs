import fs from "node:fs";
import path from "node:path";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function loadArchetype(layoutType, archetypeRoot = "layout-archetypes") {
  const dir = path.resolve(archetypeRoot, layoutType);
  const schemaPath = path.join(dir, "schema.json");
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Unknown layout archetype: ${layoutType}`);
  }
  return {
    name: layoutType,
    dir,
    schema: readJson(schemaPath),
    archetypeMd: fs.readFileSync(path.join(dir, "archetype.md"), "utf8"),
    rulesMd: fs.readFileSync(path.join(dir, "rules.md"), "utf8")
  };
}

export function resolveArchetypeForSlide(slideSpec, archetypeRoot = "layout-archetypes") {
  const archetype = loadArchetype(slideSpec.layoutType, archetypeRoot);
  const providedSlots = new Set(slideSpec.contentSlots.map((slot) => slot.slot));
  const missing = archetype.schema.requiredSlots.filter((slot) => !providedSlots.has(slot));
  if (missing.length > 0) {
    throw new Error(`Slide ${slideSpec.id} is missing required slots for ${slideSpec.layoutType}: ${missing.join(", ")}`);
  }
  return archetype;
}
