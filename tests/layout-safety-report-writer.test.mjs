import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  preflightLayout,
  formatReport,
  sortObjectKeys
} from "../scripts/lib/check-layout-safety.mjs";
import { validateJsonSchema } from "../scripts/lib/schema-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, "..", "schemas", "layout-safety-report.schema.json");

async function loadSchema() {
  return JSON.parse(await readFile(SCHEMA_PATH, "utf8"));
}

const DECK_SIZE = { width: 13.333, height: 7.5 };

function makeManifest(slides, designTokens = {}) {
  return {
    version: "0.1.1",
    designSystem: { source: "design.md", name: "Business Neutral", mode: "creative", tokens: designTokens },
    deck: { title: "Layout Safety Sample", language: "en-US", size: { preset: "wide", width: DECK_SIZE.width, height: DECK_SIZE.height, unit: "in" } },
    assets: [],
    slides
  };
}

function textSlide(element, extras = {}) {
  return {
    id: extras.id ?? "s1",
    background: extras.background ?? { type: "solid", color: "#FFFFFF" },
    elements: [element]
  };
}

describe("layout-safety-report-writer (U5)", () => {
  describe("schema validation", () => {
    it("loads the layout-safety schema with required deckSize / checks / summary", async () => {
      const schema = await loadSchema();
      expect(schema.$schema).toContain("draft-07");
      expect(schema.required).toEqual(
        expect.arrayContaining(["deckSize", "checks", "summary"])
      );
      // `kind` is nested under checks.items.properties.
      const checkItems = schema.properties.checks.items;
      expect(checkItems.properties.kind).toBeDefined();
      expect(checkItems.properties.kind.enum).toEqual(
        expect.arrayContaining(["bounds", "overlap", "font-too-small"])
      );
    });

    it("formats a clean manifest into a schema-valid wire report", async () => {
      const schema = await loadSchema();
      const manifest = makeManifest([
        textSlide({ type: "text", id: "title", x: 0.5, y: 0.5, w: 12, h: 1, text: "Hello", style: { fontSize: 24, role: "title" } })
      ]);
      const wire = formatReport(preflightLayout(manifest));
      const result = validateJsonSchema(wire, schema);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("formats a manifest with violations into a schema-valid wire report", async () => {
      const schema = await loadSchema();
      const manifest = makeManifest([
        {
          id: "s1",
          background: { type: "solid", color: "#FFFFFF" },
          elements: [
            { type: "text", id: "tiny", x: 0.5, y: 0.5, w: 4, h: 0.5, text: "tiny", style: { fontSize: 8 } },
            { type: "shape", id: "card-a", x: 4.6, y: 0.5, w: 4, h: 2, shape: "rect" },
            { type: "shape", id: "card-b", x: 8.7, y: 0.5, w: 4, h: 2, shape: "rect" }
          ]
        }
      ]);
      const wire = formatReport(
        preflightLayout(manifest, { designTokens: { spacing: { md: 1.5 } } })
      );
      const result = validateJsonSchema(wire, schema);
      expect(result.valid).toBe(true);
      expect(wire.checks.length).toBeGreaterThan(0);
      expect(wire.summary.criticalCount).toBeGreaterThan(0);
      expect(wire.summary.warningCount).toBeGreaterThan(0);
      // Each check must have the schema-required field names.
      for (const check of wire.checks) {
        expect(typeof check.elementId).toBe("string");
        expect(check.elementId.length).toBeGreaterThan(0);
        expect(typeof check.kind).toBe("string");
        expect(["critical", "warning", "pass"]).toContain(check.severity);
        expect(typeof check.message).toBe("string");
      }
    });

    it("rejects a wire report missing required deckSize", async () => {
      const schema = await loadSchema();
      const manifest = makeManifest([textSlide({ type: "text", id: "x", x: 0.5, y: 0.5, w: 1, h: 0.5, text: "x" })]);
      const wire = formatReport(preflightLayout(manifest));
      const tampered = { ...wire };
      delete tampered.deckSize;
      const result = validateJsonSchema(tampered, schema);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => /deckSize/.test(e.message))).toBe(true);
    });

    it("rejects a wire report missing required checks", async () => {
      const schema = await loadSchema();
      const manifest = makeManifest([textSlide({ type: "text", id: "x", x: 0.5, y: 0.5, w: 1, h: 0.5, text: "x" })]);
      const wire = formatReport(preflightLayout(manifest));
      const tampered = { ...wire };
      delete tampered.checks;
      const result = validateJsonSchema(tampered, schema);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => /checks/.test(e.message))).toBe(true);
    });

    it("rejects a wire report missing required summary", async () => {
      const schema = await loadSchema();
      const manifest = makeManifest([textSlide({ type: "text", id: "x", x: 0.5, y: 0.5, w: 1, h: 0.5, text: "x" })]);
      const wire = formatReport(preflightLayout(manifest));
      const tampered = { ...wire };
      delete tampered.summary;
      const result = validateJsonSchema(tampered, schema);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => /summary/.test(e.message))).toBe(true);
    });

    it("rejects a wire report with an extra top-level key (additionalProperties: false)", async () => {
      const schema = await loadSchema();
      const manifest = makeManifest([textSlide({ type: "text", id: "x", x: 0.5, y: 0.5, w: 1, h: 0.5, text: "x" })]);
      const wire = formatReport(preflightLayout(manifest));
      const tampered = { ...wire, unexpected: { deep: true } };
      const result = validateJsonSchema(tampered, schema);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => /unexpected/.test(e.message))).toBe(true);
    });

    it("rejects an unknown kind enum value", async () => {
      const schema = await loadSchema();
      const manifest = makeManifest([
        textSlide({ type: "text", id: "tiny", x: 0.5, y: 0.5, w: 4, h: 0.5, text: "tiny", style: { fontSize: 8 } })
      ]);
      const wire = formatReport(preflightLayout(manifest));
      const tampered = {
        ...wire,
        checks: wire.checks.map((c, i) => (i === 0 ? { ...c, kind: "made-up-kind" } : c))
      };
      const result = validateJsonSchema(tampered, schema);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => /kind/.test(e.path) || /kind/.test(e.message))).toBe(true);
    });

    it("rejects an invalid severity enum value", async () => {
      const schema = await loadSchema();
      const manifest = makeManifest([
        textSlide({ type: "text", id: "tiny", x: 0.5, y: 0.5, w: 4, h: 0.5, text: "tiny", style: { fontSize: 8 } })
      ]);
      const wire = formatReport(preflightLayout(manifest));
      const tampered = {
        ...wire,
        checks: wire.checks.map((c, i) => (i === 0 ? { ...c, severity: "fatal" } : c))
      };
      const result = validateJsonSchema(tampered, schema);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => /severity/.test(e.path) || /severity/.test(e.message))).toBe(true);
    });
  });

  describe("suggestion field", () => {
    it("omits suggestion from check when none is present", async () => {
      const schema = await loadSchema();
      const manifest = makeManifest([
        textSlide({ type: "text", id: "tiny", x: 0.5, y: 0.5, w: 4, h: 0.5, text: "tiny", style: { fontSize: 8 } })
      ]);
      const wire = formatReport(preflightLayout(manifest));
      // Wire shape should validate clean.
      expect(validateJsonSchema(wire, schema).valid).toBe(true);
      // No suggestion is generated by the U4 library, so the field is absent.
      for (const check of wire.checks) {
        expect(check.suggestion).toBeUndefined();
      }
    });

    it("preserves suggestion shape when present (operation/targetElementId/changes)", async () => {
      const schema = await loadSchema();
      const wire = formatReport(preflightLayout(makeManifest([])));
      // Inject a synthetic suggestion to verify the schema accepts the U6 shape.
      wire.checks.push({
        elementId: "demo-el",
        kind: "bounds",
        severity: "warning",
        message: "Demo suggestion",
        suggestion: {
          operation: "move-element",
          targetElementId: "demo-el",
          changes: { x: 0.5, y: 0.5, w: 4, h: 2 }
        }
      });
      const result = validateJsonSchema(wire, schema);
      expect(result.valid).toBe(true);
    });
  });

  describe("byte-identical determinism", () => {
    it("two consecutive formatReport calls produce byte-identical JSON", () => {
      const manifest = makeManifest([
        {
          id: "s1",
          background: { type: "solid", color: "#FFFFFF" },
          elements: [
            { type: "text", id: "tiny", x: 0.5, y: 0.5, w: 4, h: 0.5, text: "tiny", style: { fontSize: 8 } },
            { type: "shape", id: "card-a", x: 4.6, y: 0.5, w: 4, h: 2, shape: "rect" },
            { type: "shape", id: "card-b", x: 4.7, y: 0.5, w: 4, h: 2, shape: "rect" }
          ]
        }
      ]);
      const tokens = { spacing: { md: 1.5 } };
      const a = JSON.stringify(formatReport(preflightLayout(manifest, { designTokens: tokens })), null, 2);
      const b = JSON.stringify(formatReport(preflightLayout(manifest, { designTokens: tokens })), null, 2);
      expect(a).toBe(b);
    });

    it("sortObjectKeys produces deterministic key order even when input order varies", () => {
      const ordered = { a: 1, b: 2, c: 3 };
      const reversed = { c: 3, b: 2, a: 1 };
      expect(sortObjectKeys(ordered)).toEqual(sortObjectKeys(reversed));
    });

    it("wire object has alphabetically sorted top-level keys (checks → summary → deckSize → version is forbidden)", () => {
      const manifest = makeManifest([textSlide({ type: "text", id: "x", x: 0.5, y: 0.5, w: 1, h: 0.5, text: "x" })]);
      const wire = formatReport(preflightLayout(manifest));
      const keys = Object.keys(wire);
      const sorted = [...keys].sort();
      expect(keys).toEqual(sorted);
    });

    it("check entries have alphabetically sorted keys", () => {
      const manifest = makeManifest([
        textSlide({ type: "text", id: "tiny", x: 0.5, y: 0.5, w: 4, h: 0.5, text: "tiny", style: { fontSize: 8 } })
      ]);
      const wire = formatReport(preflightLayout(manifest));
      for (const check of wire.checks) {
        expect(Object.keys(check)).toEqual([...Object.keys(check)].sort());
      }
    });
  });

  describe("formatReport behavior", () => {
    it("uses DEFAULT_DECK_SIZE when result has no deckSize hint", () => {
      const wire = formatReport({ checks: [], summary: { criticalCount: 0, warningCount: 0, blocked: false } });
      expect(wire.deckSize).toEqual({ width: 13.333, height: 7.5 });
    });

    it("uses caller-provided deckSize override", () => {
      const wire = formatReport(
        { checks: [], summary: { criticalCount: 0, warningCount: 0, blocked: false } },
        { deckSize: { width: 10, height: 5.625 } }
      );
      expect(wire.deckSize).toEqual({ width: 10, height: 5.625 });
    });

    it("propagates slideCount from internal summary when present", () => {
      const wire = formatReport({
        checks: [],
        summary: { criticalCount: 0, warningCount: 0, slideCount: 7, blocked: false }
      });
      expect(wire.summary.slideCount).toBe(7);
    });

    it("omits slideCount when internal summary lacks it", () => {
      const wire = formatReport({
        checks: [],
        summary: { criticalCount: 0, warningCount: 0, blocked: false }
      });
      expect(wire.summary.slideCount).toBeUndefined();
    });

    it("includes createdAt only when caller passes it through", () => {
      const a = formatReport({ checks: [], summary: { criticalCount: 0, warningCount: 0, blocked: false } });
      expect(a.createdAt).toBeUndefined();
      const b = formatReport(
        { checks: [], summary: { criticalCount: 0, warningCount: 0, blocked: false } },
        { createdAt: "2026-06-21T00:00:00.000Z" }
      );
      expect(b.createdAt).toBe("2026-06-21T00:00:00.000Z");
    });

    it("translates internal type 'font-size' to wire kind 'font-too-small'", () => {
      const manifest = makeManifest([
        textSlide({ type: "text", id: "tiny", x: 0.5, y: 0.5, w: 4, h: 0.5, text: "tiny", style: { fontSize: 8 } })
      ]);
      const wire = formatReport(preflightLayout(manifest));
      const fontCheck = wire.checks.find((c) => c.kind === "font-too-small");
      expect(fontCheck).toBeTruthy();
      expect(fontCheck.elementId).toBe("tiny");
    });

    it("translates overlap checks with relatedElementId", () => {
      const manifest = makeManifest([
        {
          id: "s1",
          background: { type: "solid", color: "#FFFFFF" },
          elements: [
            { type: "text", id: "a", x: 0.5, y: 0.5, w: 4, h: 4, text: "a", style: { fontSize: 14 } },
            { type: "text", id: "b", x: 0.6, y: 0.6, w: 3.8, h: 3.8, text: "b", style: { fontSize: 14 } }
          ]
        }
      ]);
      const wire = formatReport(preflightLayout(manifest));
      const overlap = wire.checks.find((c) => c.kind === "overlap");
      expect(overlap).toBeTruthy();
      expect(overlap.elementId).toBe("a");
      expect(overlap.relatedElementId).toBe("b");
    });
  });
});
