import { describe, expect, it } from "vitest";
import {
  buildConsistencyBatch,
  buildConsistencyReport,
  DIMENSION_SECTIONS,
  loadBatchSchema,
  loadPerDeckSchema,
  sortObjectKeys,
  validateBatchReport,
  validatePerDeckReport
} from "../scripts/lib/consistency-report-writer.mjs";

const SAMPLE_MANIFEST = {
  version: "0.1.1",
  designSystem: { source: "design.md", name: "Business Neutral", mode: "balanced" },
  deck: { title: "AI Platform Roadshow", language: "zh-CN", size: { preset: "wide", width: 13.333, height: 7.5, unit: "in" } },
  assets: [],
  slides: [
    {
      id: "slide-001",
      type: "cover",
      title: "AI Platform Roadshow",
      background: { type: "solid", color: "#fff" },
      elements: [
        { type: "text", id: "title", text: "AI 平台建设路线图", x: 0.7, y: 0.8, w: 11.8, h: 0.8 }
      ]
    }
  ]
};

const FULL_INTERMEDIATE = {
  sourceCoordinates: [
    { slideId: "slide-001", elementId: "title", dx: 1, dy: 1 }
  ],
  fontNames: [
    { element: "title", requested: "Inter", fallback: "Arial" },
    { element: "body", requested: "Source Han Sans SC", fallback: "Microsoft YaHei" }
  ],
  paletteMatches: [
    { slideId: "slide-001", score: 0.9 }
  ],
  editabilityCounter: { text: 3, shape: 0, image: 0, table: 0, croppedAsset: 0 },
  preview: { libreofficeAvailable: true, perSlide: [{ slideId: "slide-001", diff: 0.02 }] }
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

describe("consistency-report-writer", () => {
  describe("schema files", () => {
    it("loads the per-deck schema as Draft 2020-12 with required fields", async () => {
      const schema = await loadPerDeckSchema();
      expect(schema.$schema).toContain("draft/2020-12");
      expect(schema.required).toEqual(expect.arrayContaining(["inputType", "inputSource"]));
      expect(schema.properties.inputType.enum).toEqual(["html", "image", "design-first"]);
    });

    it("loads the batch schema with aggregate fields", async () => {
      const schema = await loadBatchSchema();
      expect(schema.$schema).toContain("draft/2020-12");
      expect(schema.required).toEqual(
        expect.arrayContaining([
          "version",
          "createdAt",
          "batch",
          "editabilityDistribution",
          "averageCoordinateDriftPx",
          "fontFallbackRate",
          "paletteMatch",
          "perDeckReports",
          "layoutSafetyDistribution",
          "averageSlopRisk"
        ])
      );
    });
  });

  describe("validation", () => {
    it("rejects a per-deck report missing required inputType", async () => {
      const { json } = buildConsistencyReport(SAMPLE_MANIFEST, FULL_INTERMEDIATE, {
        inputSource: "demo.html"
        // inputType missing
      });
      const parsed = JSON.parse(json);
      const result = await validatePerDeckReport(parsed);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => /inputType/.test(e.message))).toBe(true);
    });

    it("rejects a per-deck report missing required inputSource", async () => {
      const { json } = buildConsistencyReport(
        SAMPLE_MANIFEST,
        FULL_INTERMEDIATE,
        { inputType: "html" }
        // inputSource missing AND no manifest.deck.title fallback
      );
      // Manifest has a title, so fallback kicks in. Force the failure by
      // using a manifest with no title.
      const noTitleManifest = { ...clone(SAMPLE_MANIFEST), deck: { ...SAMPLE_MANIFEST.deck, title: "" } };
      const { json: json2 } = buildConsistencyReport(noTitleManifest, FULL_INTERMEDIATE, { inputType: "html" });
      const result = await validatePerDeckReport(JSON.parse(json2));
      expect(result.valid).toBe(false);
      // The error may surface as a "missing required property" or as a
      // minLength violation; either is acceptable evidence that the
      // empty inputSource is being flagged.
      expect(result.errors.some((e) => /inputSource/.test(e.message) || /inputSource/.test(e.path))).toBe(true);
      // Sanity: ensure the first call did not throw unexpectedly.
      expect(() => JSON.parse(json)).not.toThrow();
    });

    it("passes validation when optional coordinateDriftPx and arrays are empty", async () => {
      const { json } = buildConsistencyReport(SAMPLE_MANIFEST, {}, { inputType: "design-first", inputSource: "storyboard" });
      const result = await validatePerDeckReport(JSON.parse(json));
      expect(result.valid).toBe(true);
    });

    it("renders the not-measured phrase in markdown for missing coordinate drift", () => {
      const { md } = buildConsistencyReport(SAMPLE_MANIFEST, {}, { inputType: "design-first", inputSource: "storyboard" });
      expect(md).toMatch(/## coordinateDriftPx\s*\n\s*\n_not measured_/);
    });
  });

  describe("editability floor", () => {
    it("accepts empty pipelineCausal / sourceCausal arrays", async () => {
      const { json } = buildConsistencyReport(SAMPLE_MANIFEST, FULL_INTERMEDIATE, {
        inputType: "html",
        inputSource: "demo.html",
        editabilityFloor: {
          level: 3,
          floorViolation: { pipelineCausal: [], sourceCausal: [] }
        }
      });
      const result = await validatePerDeckReport(JSON.parse(json));
      expect(result.valid).toBe(true);
    });

    it("lists pipeline-causal element IDs in markdown when non-empty", () => {
      const { md } = buildConsistencyReport(SAMPLE_MANIFEST, FULL_INTERMEDIATE, {
        inputType: "html",
        inputSource: "demo.html",
        editabilityFloor: {
          level: 3,
          floorViolation: {
            pipelineCausal: ["slide-001/title", "slide-001/hero"],
            sourceCausal: []
          }
        }
      });
      expect(md).toContain("Pipeline-causal: slide-001/title, slide-001/hero");
    });
  });

  describe("previewDiff conditional validation", () => {
    it("passes when status is 'deferred' (perSlide optional)", async () => {
      const { json } = buildConsistencyReport(SAMPLE_MANIFEST, {}, { inputType: "html", inputSource: "demo.html" });
      const result = await validatePerDeckReport(JSON.parse(json));
      expect(result.valid).toBe(true);
    });

    it("passes when status is 'ok' with perSlide array", async () => {
      const intermediate = clone(FULL_INTERMEDIATE);
      intermediate.preview = { libreofficeAvailable: true, perSlide: [{ slideId: "slide-001", diff: 0.01 }] };
      const { json } = buildConsistencyReport(SAMPLE_MANIFEST, intermediate, { inputType: "html", inputSource: "demo.html" });
      const result = await validatePerDeckReport(JSON.parse(json));
      expect(result.valid).toBe(true);
    });

    it("fails when status is 'ok' and perSlide is missing", async () => {
      const { json } = buildConsistencyReport(SAMPLE_MANIFEST, FULL_INTERMEDIATE, {
        inputType: "html",
        inputSource: "demo.html",
        previewDiff: { status: "ok" }
      });
      const result = await validatePerDeckReport(JSON.parse(json));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => /perSlide/.test(e.message))).toBe(true);
    });
  });

  describe("determinism", () => {
    it("produces byte-identical JSON for the same input across two calls", () => {
      const options = { inputType: "html", inputSource: "demo.html" };
      const a = buildConsistencyReport(SAMPLE_MANIFEST, FULL_INTERMEDIATE, options);
      const b = buildConsistencyReport(SAMPLE_MANIFEST, FULL_INTERMEDIATE, options);
      expect(a.json).toBe(b.json);
    });

    it("omits createdAt by default so structurally-same inputs stay byte-equal across runs", () => {
      const a = buildConsistencyReport(SAMPLE_MANIFEST, FULL_INTERMEDIATE, { inputType: "html", inputSource: "demo.html" });
      const b = buildConsistencyReport(SAMPLE_MANIFEST, FULL_INTERMEDIATE, { inputType: "html", inputSource: "demo.html" });
      expect(a.json).toBe(b.json);
      expect(a.json.includes("createdAt")).toBe(false);
    });

    it("sorts object keys deterministically even when input order differs", () => {
      const ordered = { a: 1, b: 2, c: 3 };
      const reversed = { c: 3, b: 2, a: 1 };
      expect(sortObjectKeys(ordered)).toEqual(sortObjectKeys(reversed));
    });
  });

  describe("markdown structure", () => {
    it("contains all 8 dimension sections regardless of input type", () => {
      const cases = [
        { inputType: "html", inputSource: "demo.html" },
        { inputType: "image", inputSource: "ref.png" },
        { inputType: "design-first", inputSource: "storyboard" }
      ];
      for (const opts of cases) {
        const { md } = buildConsistencyReport(SAMPLE_MANIFEST, {}, opts);
        for (const section of DIMENSION_SECTIONS) {
          expect(md).toContain(`## ${section}`);
        }
      }
    });

    it("starts with a # title and includes a ## Summary block", () => {
      const { md } = buildConsistencyReport(SAMPLE_MANIFEST, {}, { inputType: "html", inputSource: "demo.html" });
      expect(md.startsWith("# Consistency Report")).toBe(true);
      expect(md).toContain("## Summary");
    });
  });

  describe("batch aggregate", () => {
    const deckA = buildConsistencyReport(SAMPLE_MANIFEST, FULL_INTERMEDIATE, {
      inputType: "html",
      inputSource: "a.html"
    });
    const deckB = buildConsistencyReport(SAMPLE_MANIFEST, {}, {
      inputType: "image",
      inputSource: "b.png"
    });

    it("aggregates editabilityDistribution, averageCoordinateDriftPx, fontFallbackRate, paletteMatch", () => {
      const batch = buildConsistencyBatch(
        [
          { path: "deck-a/consistency-report.json", report: deckA.report },
          { path: "deck-b/consistency-report.json", report: deckB.report }
        ],
        { createdAt: "2026-06-20T00:00:00.000Z" }
      );
      expect(batch.editabilityDistribution).toBeDefined();
      expect(typeof batch.averageCoordinateDriftPx).toBe("number");
      expect(typeof batch.fontFallbackRate).toBe("number");
      expect(typeof batch.paletteMatch).toBe("number");
      expect(batch.perDeckReports).toEqual(["deck-a/consistency-report.json", "deck-b/consistency-report.json"]);
    });

    it("rejects a per-deck floorViolation shape passed through the batch schema", async () => {
      const batch = buildConsistencyBatch(
        [
          { path: "deck-a/consistency-report.json", report: deckA.report }
        ],
        { createdAt: "2026-06-20T00:00:00.000Z" }
      );
      // Should validate cleanly as a batch.
      const ok = await validateBatchReport(batch);
      expect(ok.valid).toBe(true);

      // Tamper: inject a per-deck-only key (`floorViolation`) directly on
      // the batch envelope. The schema's `not.anyOf` rule rejects
      // per-deck-only keys.
      const tampered = { ...batch, floorViolation: { pipelineCausal: ["x"], sourceCausal: [] } };
      const reject = await validateBatchReport(tampered);
      expect(reject.valid).toBe(false);
    });
  });

  describe("layoutSafety (U1)", () => {
    it("round-trips layoutSafety: 'violated-with-flag' through buildConsistencyReport and validates against the schema", async () => {
      const { json } = buildConsistencyReport(SAMPLE_MANIFEST, FULL_INTERMEDIATE, {
        inputType: "html",
        inputSource: "demo.html",
        layoutSafety: "violated-with-flag"
      });
      const parsed = JSON.parse(json);
      expect(parsed.layoutSafety).toBe("violated-with-flag");
      const result = await validatePerDeckReport(parsed);
      expect(result.valid).toBe(true);
    });

    it("passes schema validation when layoutSafety is absent (optional, strict-soft)", async () => {
      const { json } = buildConsistencyReport(SAMPLE_MANIFEST, FULL_INTERMEDIATE, {
        inputType: "html",
        inputSource: "demo.html"
        // layoutSafety intentionally omitted
      });
      const parsed = JSON.parse(json);
      expect(parsed.layoutSafety).toBeUndefined();
      const result = await validatePerDeckReport(parsed);
      expect(result.valid).toBe(true);
    });

    it("rejects an invalid layoutSafety enum value", async () => {
      const { json } = buildConsistencyReport(SAMPLE_MANIFEST, FULL_INTERMEDIATE, {
        inputType: "html",
        inputSource: "demo.html",
        layoutSafety: "not-a-real-status"
      });
      const result = await validatePerDeckReport(JSON.parse(json));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => /layoutSafety/.test(e.message) || /layoutSafety/.test(e.path))).toBe(true);
    });

    it("includes '## layoutSafety' section in markdown when value is present", () => {
      const { md } = buildConsistencyReport(SAMPLE_MANIFEST, FULL_INTERMEDIATE, {
        inputType: "html",
        inputSource: "demo.html",
        layoutSafety: "violated-blocked"
      });
      expect(md).toMatch(/## layoutSafety\s*\n\s*\n- Layout safety: violated-blocked/);
    });

    it("renders 'not measured' in markdown when layoutSafety is absent", () => {
      const { md } = buildConsistencyReport(SAMPLE_MANIFEST, {}, {
        inputType: "html",
        inputSource: "demo.html"
      });
      expect(md).toMatch(/## layoutSafety\s*\n\s*\n_not measured_/);
    });

    it("exposes layoutSafety and slopRisk in fixed order (10th = slopRisk, U3)", () => {
      expect(DIMENSION_SECTIONS).toEqual([
        "inputSource",
        "editabilityLevel",
        "coordinateDriftPx",
        "fontFallback",
        "paletteMatch",
        "rasterizedRegions",
        "layoutSafety",
        "editabilityFloor",
        "slopRisk",
        "previewDiff"
      ]);
      expect(DIMENSION_SECTIONS).toHaveLength(10);
    });

    it("keeps byte-identical JSON when layoutSafety is omitted (determinism preserved)", () => {
      const options = { inputType: "html", inputSource: "demo.html" };
      const a = buildConsistencyReport(SAMPLE_MANIFEST, FULL_INTERMEDIATE, options);
      const b = buildConsistencyReport(SAMPLE_MANIFEST, FULL_INTERMEDIATE, options);
      expect(a.json).toBe(b.json);
      expect(a.json.includes("layoutSafety")).toBe(false);
    });

    it("includes the layoutSafety section in markdown regardless of input type", () => {
      const cases = [
        { inputType: "html", inputSource: "demo.html" },
        { inputType: "image", inputSource: "ref.png" },
        { inputType: "design-first", inputSource: "storyboard" }
      ];
      for (const opts of cases) {
        const { md } = buildConsistencyReport(SAMPLE_MANIFEST, {}, opts);
        expect(md).toContain("## layoutSafety");
      }
    });
  });

  describe("feedback block (U10 / R22)", () => {
    it("omits the feedback block by default so byte-equality across runs is preserved", () => {
      const a = buildConsistencyReport(SAMPLE_MANIFEST, FULL_INTERMEDIATE, { inputType: "html", inputSource: "demo.html" });
      const b = buildConsistencyReport(SAMPLE_MANIFEST, FULL_INTERMEDIATE, { inputType: "html", inputSource: "demo.html" });
      expect(a.json).toBe(b.json);
      expect(a.json.includes("feedback")).toBe(false);
    });

    it("round-trips feedback: null into an empty defaults block", async () => {
      const { json } = buildConsistencyReport(SAMPLE_MANIFEST, FULL_INTERMEDIATE, {
        inputType: "html",
        inputSource: "demo.html",
        feedback: null
      });
      const parsed = JSON.parse(json);
      expect(parsed.feedback).toEqual({ retryCount: 0, accepted: null, acceptedAt: null });
      const result = await validatePerDeckReport(parsed);
      expect(result.valid).toBe(true);
    });

    it("round-trips feedback: {retryCount: 2, accepted: null, acceptedAt: null}", async () => {
      const { json } = buildConsistencyReport(SAMPLE_MANIFEST, FULL_INTERMEDIATE, {
        inputType: "html",
        inputSource: "demo.html",
        feedback: { retryCount: 2, accepted: null, acceptedAt: null }
      });
      const parsed = JSON.parse(json);
      expect(parsed.feedback).toEqual({ retryCount: 2, accepted: null, acceptedAt: null });
      const result = await validatePerDeckReport(parsed);
      expect(result.valid).toBe(true);
    });

    it("round-trips feedback: {retryCount: 3, accepted: true, acceptedAt: ISO}", async () => {
      const iso = "2026-06-21T00:00:00.000Z";
      const { json } = buildConsistencyReport(SAMPLE_MANIFEST, FULL_INTERMEDIATE, {
        inputType: "html",
        inputSource: "demo.html",
        feedback: { retryCount: 3, accepted: true, acceptedAt: iso }
      });
      const parsed = JSON.parse(json);
      expect(parsed.feedback).toEqual({ retryCount: 3, accepted: true, acceptedAt: iso });
      const result = await validatePerDeckReport(parsed);
      expect(result.valid).toBe(true);
    });

    it("clamps non-integer retryCount to 0", () => {
      const { json } = buildConsistencyReport(SAMPLE_MANIFEST, FULL_INTERMEDIATE, {
        inputType: "html",
        inputSource: "demo.html",
        feedback: { retryCount: "two", accepted: null, acceptedAt: null }
      });
      const parsed = JSON.parse(json);
      expect(parsed.feedback.retryCount).toBe(0);
    });
  });
});
