import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function resolveCatalogRoot(catalogRoot) {
  return path.isAbsolute(catalogRoot) ? catalogRoot : path.resolve(SKILL_ROOT, catalogRoot);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadFromRoot(layoutType, archetypeRoot) {
  const dir = path.resolve(resolveCatalogRoot(archetypeRoot), layoutType);
  const schemaPath = path.join(dir, "schema.json");
  if (!fs.existsSync(schemaPath)) return null;
  return {
    name: layoutType,
    dir,
    schema: readJson(schemaPath),
    archetypeMd: fs.readFileSync(path.join(dir, "archetype.md"), "utf8"),
    rulesMd: fs.readFileSync(path.join(dir, "rules.md"), "utf8")
  };
}

export function loadArchetype(layoutType, archetypeRoot = "layout-archetypes") {
  const loaded = loadFromRoot(layoutType, archetypeRoot);
  if (!loaded) {
    throw new Error(`Unknown layout archetype: ${layoutType}`);
  }
  return loaded;
}

/**
 * Dual-root lookup. Tries `slide-archetypes/<name>` first (the new
 * content-pattern catalog), then falls back to `layout-archetypes/<name>`
 * (the original layout-archetype catalog). Throws only if neither root
 * resolves the name. Used by the HTML adapter to honor the
 * `data-archetype` attribute on a slide section without forcing callers
 * to know which catalog the archetype lives in.
 */
export function loadFromBothRoots(layoutType) {
  const slideLoaded = loadFromRoot(layoutType, "slide-archetypes");
  if (slideLoaded) return { ...slideLoaded, root: "slide-archetypes" };
  const layoutLoaded = loadFromRoot(layoutType, "layout-archetypes");
  if (layoutLoaded) return { ...layoutLoaded, root: "layout-archetypes" };
  throw new Error(`Unknown layout archetype: ${layoutType}`);
}
