import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  LAYOUT_ARCHETYPE_CATALOG_VERSION,
  LAYOUT_ARCHETYPE_IDS,
  LAYOUT_ARCHETYPE_REGISTRY,
  LAYOUT_ARCHETYPE_REGISTRY_SHA256,
  LEGACY_LAYOUT_ADAPTERS,
  getLayoutArchetype,
  resolveLayoutArchetype,
  validateLayoutArchetypeRegistry,
  validateLayoutArchetypeSlots
} from "../../scripts/lib/archetypes.mjs";
import { skillRoot } from "../helpers.mjs";

async function fixture(name) {
  const path = join(skillRoot, "layout-archetypes", "fixtures", `${name}.json`);
  return JSON.parse(await readFile(path, "utf8"));
}

test("loads the complete static catalog with a stable fingerprint", async () => {
  assert.equal(LAYOUT_ARCHETYPE_CATALOG_VERSION, "1.0.0");
  assert.deepEqual(LAYOUT_ARCHETYPE_IDS, [
    "closing-action",
    "comparison-matrix",
    "cover",
    "dashboard",
    "editorial-split",
    "evidence-image",
    "executive-summary",
    "hero-statement",
    "metric-focus",
    "process-flow",
    "quote-story",
    "section-break",
    "table-chart-diagram",
    "timeline-roadmap"
  ]);
  assert.deepEqual(Object.keys(LAYOUT_ARCHETYPE_REGISTRY), LAYOUT_ARCHETYPE_IDS);
  assert.match(LAYOUT_ARCHETYPE_REGISTRY_SHA256, /^[a-f0-9]{64}$/);
  assert.deepEqual(validateLayoutArchetypeRegistry(), {
    version: "1.0.0",
    ids: LAYOUT_ARCHETYPE_IDS,
    sha256: LAYOUT_ARCHETYPE_REGISTRY_SHA256
  });
  assert.equal(Object.isFrozen(LAYOUT_ARCHETYPE_REGISTRY), true);

  const reloaded = await import(`${new URL("../../scripts/lib/archetypes.mjs", import.meta.url).href}?catalog-reload=1`);
  assert.equal(reloaded.LAYOUT_ARCHETYPE_REGISTRY_SHA256, LAYOUT_ARCHETYPE_REGISTRY_SHA256);
});

test("resolves every canonical archetype and adapts each legacy renderer type", () => {
  for (const id of LAYOUT_ARCHETYPE_IDS) {
    const archetype = getLayoutArchetype(id);
    assert.equal(archetype.id, id);
    assert.equal(resolveLayoutArchetype(id).id, id);
    assert.equal(resolveLayoutArchetype(id).legacyType, archetype.legacyType);
  }

  for (const [legacyType, canonicalId] of Object.entries(LEGACY_LAYOUT_ADAPTERS)) {
    const resolved = resolveLayoutArchetype(legacyType);
    assert.equal(resolved.id, canonicalId, legacyType);
    assert.equal(resolved.legacyType, legacyType, legacyType);
    if (legacyType !== canonicalId) assert.equal(resolved.adaptedFrom, legacyType, legacyType);
  }
  assert.equal(resolveLayoutArchetype("unknown-layout"), undefined);
  assert.equal(resolveLayoutArchetype(null), undefined);
});

test("accepts catalog should-pass and boundary-pressure slot fixtures", async () => {
  for (const name of ["should-pass", "pressure"]) {
    const data = await fixture(name);
    for (const [index, item] of data.cases.entries()) {
      const resolved = validateLayoutArchetypeSlots(item.id, item.slots, {
        path: `$.fixtures.${name}[${index}].slots`
      });
      assert.equal(resolved.id, item.id);
    }
  }

  const adapted = validateLayoutArchetypeSlots("bullets", {
    points: [{ text: "The old page type remains supported." }]
  }, { path: "$.legacy.slots" });
  assert.deepEqual(adapted, { id: "executive-summary", legacyType: "bullets", adaptedFrom: "bullets" });
});

test("rejects unknown, missing, excessive, malformed, and undeclared slots", async () => {
  const data = await fixture("should-fail");
  for (const [index, item] of data.cases.entries()) {
    const path = `$.fixtures.shouldFail[${index}].slots`;
    assert.throws(
      () => validateLayoutArchetypeSlots(item.id, item.slots, { path }),
      (error) => error.code === "E_LAYOUT_CONTENT" && error.path.endsWith(item.expectedPathSuffix),
      item.id
    );
  }
});
