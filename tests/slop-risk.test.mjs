import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { calibrateSlopRules, scoreSlopRisk, SLOP_RULES, SLOP_WEIGHTS, __test__ } from "../scripts/lib/slop-risk.mjs";
import { reviewManifest } from "../scripts/lib/visual-critic.mjs";
import { validateJsonSchema } from "../scripts/lib/schema-utils.mjs";

function slide(elements) {
  return {
    version: "0.1.1",
    designSystem: { source: "design-systems/business-neutral/DESIGN.md", name: "Business Neutral", mode: "balanced" },
    deck: { title: "Sample", language: "en-US", size: { preset: "wide", width: 13.333, height: 7.5, unit: "in" } },
    assets: [],
    slides: [{ id: "slide-001", elements }]
  };
}

function scenario(name) {
  const text = (id, value, style = {}, extra = {}) => ({ type: "text", id, x: 0, y: 0, w: 2, h: 0.5, text: value, style, ...extra });
  const shape = (id, value, x, y, style = {}) => ({ type: "shape", id, shape: value, x, y, w: 0.5, h: 0.5, style });
  const cases = {
    clean: [text("body", "Clear evidence", { fontFamily: "Inter" })],
    "clean-zh": [text("title", "清晰的证据", { typography: "{typography.title}" })],
    "font-four": ["Inter", "Roboto", "Source Serif Pro", "JetBrains Mono"].map((font, index) => text(`f${index}`, font, { fontFamily: font })),
    "font-three": ["Inter", "Roboto", "Source Serif Pro"].map((font, index) => text(`f${index}`, font, { fontFamily: font })),
    emoji: [text("emoji", "Launch 🚀")],
    gradient: [shape("gradient", "rect", 0, 0, { fill: "linear-gradient(90deg,#fff,#000)" })],
    "multicolor-chart": [{ type: "chart", id: "chart", x: 0, y: 0, w: 4, h: 3, data: [{ label: "A", value: 1, color: "#f00" }, { label: "B", value: 2, color: "#00f" }] }],
    "caps-treatment": [text("hero", "POWER", { stroke: "#000", shadow: "2px 2px #000" })],
    "caps-no-shadow": [text("hero", "POWER", { stroke: "#000" })],
    "zh-rhetoric": [text("title", "Unlock the power of AI 平台", { typography: "{typography.title}" })],
    "rounded-cards": [shape("card1", "roundRect", 0, 0, { borderRadius: "rounded.lg" }), shape("card2", "roundRect", 2, 0, { borderRadius: "rounded.lg" })],
    "rounded-mixed": [shape("card1", "roundRect", 0, 0, { borderRadius: "rounded.sm" }), shape("card2", "roundRect", 2, 0, { borderRadius: "rounded.lg" })],
    "rounded-implicit": [{ type: "shape", id: "implicit-card", shape: "roundRect", x: 0, y: 0, w: 5, h: 3, style: {} }],
    "rounded-oversized": [{ type: "shape", id: "oversized-card", shape: "roundRect", x: 0, y: 0, w: 5, h: 3, style: { borderRadius: 48 } }],
    "circle-triad": [0, 1, 2].map((x) => shape(`i${x}`, "ellipse", x, 1)),
    "circle-pair": [0, 1].map((x) => shape(`i${x}`, "ellipse", x, 1)),
    "kpi-row": [0, 1, 2].map((x) => text(`kpi-${x}`, `${x}`, {}, { role: "metric", x, y: 2 })),
    "kpi-pair": [0, 1].map((x) => text(`kpi-${x}`, `${x}`, {}, { role: "metric", x, y: 2 })),
    "equal-rhythm": [1, 2, 3, 4].map((y) => text(`r${y}`, `${y}`, {}, { y })),
    "varied-rhythm": [1, 1.8, 3.2, 4.5].map((y, index) => text(`r${index}`, `${index}`, {}, { y }))
  };
  return slide(cases[name] ?? cases.clean);
}

describe("slop-risk.mjs — role inference (KTD-8)", () => {
  it("maps typography.title to role=title", () => {
    expect(__test__.inferRole({ style: { typography: "{typography.title}" } })).toBe("title");
  });

  it("maps typography.metric to role=metric", () => {
    expect(__test__.inferRole({ style: { typography: "{typography.metric}" } })).toBe("metric");
  });

  it("maps typography.body to role=body and falls back to body when no token", () => {
    expect(__test__.inferRole({ style: { typography: "{typography.body}" } })).toBe("body");
    expect(__test__.inferRole({ style: {} })).toBe("body");
  });

  it("explicit el.role wins over typography token", () => {
    expect(__test__.inferRole({ role: "metric", style: { typography: "{typography.title}" } })).toBe("metric");
  });
});

describe("slop-risk.mjs — 9 detection signals", () => {
  it("flags font-family dedup when >3 unique families appear", () => {
    const elements = [
      { type: "text", id: "a", x: 0, y: 0, w: 2, h: 0.5, text: "A", style: { fontFamily: "Inter, sans-serif" } },
      { type: "text", id: "b", x: 2, y: 0, w: 2, h: 0.5, text: "B", style: { fontFamily: "Roboto, sans-serif" } },
      { type: "text", id: "c", x: 4, y: 0, w: 2, h: 0.5, text: "C", style: { fontFamily: "Source Serif Pro, serif" } },
      { type: "text", id: "d", x: 6, y: 0, w: 2, h: 0.5, text: "D", style: { fontFamily: "JetBrains Mono, monospace" } }
    ];
    const result = scoreSlopRisk(slide(elements));
    const fontSig = result.signals.find((s) => s.id === "font-family-dedup");
    expect(fontSig.weight).toBe(SLOP_WEIGHTS.fontFamilyDedup);
    expect(fontSig.count).toBe(4);
    expect(result.score).toBeGreaterThanOrEqual(SLOP_WEIGHTS.fontFamilyDedup);
  });

  it("flags emoji-as-icon when an emoji codepoint appears in text", () => {
    const elements = [
      { type: "text", id: "title", x: 0, y: 0, w: 4, h: 0.5, text: "Hello \u{1F600} world" }
    ];
    const result = scoreSlopRisk(slide(elements));
    const sig = result.signals.find((s) => s.id === "emoji-as-icon");
    expect(sig.weight).toBe(SLOP_WEIGHTS.emojiAsIcon);
    expect(sig.count).toBe(1);
  });

  it("flags CSS gradient in inline style.fill", () => {
    const elements = [
      { type: "shape", id: "card", shape: "rect", x: 0, y: 0, w: 4, h: 2, style: { fill: "linear-gradient(90deg, #fff, #000)" } }
    ];
    const result = scoreSlopRisk(slide(elements));
    const sig = result.signals.find((s) => s.id === "css-gradient");
    expect(sig.weight).toBe(SLOP_WEIGHTS.cssGradient);
    expect(sig.count).toBe(1);
  });

  it("flags all-caps + stroke + shadow combo", () => {
    const elements = [
      {
        type: "text",
        id: "hero",
        x: 0,
        y: 0,
        w: 6,
        h: 1,
        text: "POWER",
        style: { stroke: "#000", shadow: "2px 2px 4px #000" }
      }
    ];
    const result = scoreSlopRisk(slide(elements));
    const sig = result.signals.find((s) => s.id === "all-caps-stroke-shadow");
    expect(sig.weight).toBe(SLOP_WEIGHTS.allCapsStrokeShadow);
    expect(sig.count).toBe(1);
  });

  it("flags English rhetoric on a Chinese title", () => {
    const elements = [
      { type: "text", id: "title", x: 0, y: 0, w: 6, h: 0.5, text: "Unlock the future of AI 平台", style: { typography: "{typography.title}" } }
    ];
    const result = scoreSlopRisk(slide(elements));
    const sig = result.signals.find((s) => s.id === "english-rhetoric-on-zh");
    expect(sig.weight).toBe(SLOP_WEIGHTS.englishRhetoricOnZh);
    expect(sig.count).toBe(1);
  });

  it("accepts peer cards that share a restrained rounded token", () => {
    const elements = [
      { type: "shape", id: "card-1", shape: "roundRect", x: 0, y: 0, w: 3, h: 2, style: { borderRadius: "rounded.lg" } },
      { type: "shape", id: "card-2", shape: "roundRect", x: 4, y: 0, w: 3, h: 2, style: { borderRadius: "rounded.lg" } }
    ];
    const result = scoreSlopRisk(slide(elements), { rounded: { lg: 14 } });
    const sig = result.signals.find((s) => s.id === "rounded-token-variance");
    expect(sig.weight).toBe(0);
  });

  it("flags a large card that lacks a radius source or exceeds the safe ratio", () => {
    const elements = [
      { type: "shape", id: "implicit-card", shape: "roundRect", x: 0, y: 0, w: 5, h: 3, style: {} },
      { type: "shape", id: "oversized-card", shape: "roundRect", x: 6, y: 0, w: 5, h: 3, style: { borderRadius: 48 } }
    ];
    const result = scoreSlopRisk(slide(elements));
    const sig = result.signals.find((s) => s.id === "rounded-token-variance");
    expect(sig.count).toBe(2);
    expect(sig.weight).toBe(SLOP_WEIGHTS.roundedTokenVariance);
  });

  it("flags icon-circle triad when ≥3 circle shapes share a y-bucket", () => {
    const elements = [
      { type: "shape", id: "i1", shape: "ellipse", x: 0, y: 1, w: 0.5, h: 0.5, style: {} },
      { type: "shape", id: "i2", shape: "ellipse", x: 1, y: 1, w: 0.5, h: 0.5, style: {} },
      { type: "shape", id: "i3", shape: "ellipse", x: 2, y: 1, w: 0.5, h: 0.5, style: {} }
    ];
    const result = scoreSlopRisk(slide(elements));
    const sig = result.signals.find((s) => s.id === "icon-circle-triad");
    expect(sig.weight).toBe(SLOP_WEIGHTS.iconCircleTriad);
  });

  it("flags 3-up KPI sandwich when 3 metric-role elements share a y-bucket", () => {
    const elements = [
      { type: "text", id: "m1", role: "metric", x: 0, y: 2, w: 1, h: 0.5, text: "10x" },
      { type: "text", id: "m2", role: "metric", x: 2, y: 2, w: 1, h: 0.5, text: "5x" },
      { type: "text", id: "m3", role: "metric", x: 4, y: 2, w: 1, h: 0.5, text: "2x" }
    ];
    const result = scoreSlopRisk(slide(elements));
    const sig = result.signals.find((s) => s.id === "kpi-sandwich");
    expect(sig.weight).toBe(SLOP_WEIGHTS.kpiSandwich);
  });

  it("flags vertical-rhythm variance when all gaps are identical", () => {
    const elements = [
      { type: "text", id: "a", x: 0, y: 1, w: 2, h: 0.5, text: "A" },
      { type: "text", id: "b", x: 0, y: 2, w: 2, h: 0.5, text: "B" },
      { type: "text", id: "c", x: 0, y: 3, w: 2, h: 0.5, text: "C" },
      { type: "text", id: "d", x: 0, y: 4, w: 2, h: 0.5, text: "D" }
    ];
    const result = scoreSlopRisk(slide(elements));
    const sig = result.signals.find((s) => s.id === "vertical-rhythm-variance");
    expect(sig.weight).toBe(SLOP_WEIGHTS.verticalRhythmVariance);
  });
});

describe("slop-risk.mjs — score range and idempotence", () => {
  it("score is always in [0, 100]", () => {
    const elements = [
      { type: "text", id: "a", x: 0, y: 0, w: 2, h: 0.5, text: "Hi \u{1F600}", style: { fontFamily: "Inter, Roboto, Source Serif Pro, JetBrains Mono, sans-serif", fill: "linear-gradient(red, blue)", stroke: "#000", shadow: "x y z" } }
    ];
    for (let i = 0; i < 50; i += 1) {
      const result = scoreSlopRisk(slide(elements));
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    }
  });

  it("same input → same score (idempotent)", () => {
    const elements = [
      { type: "shape", id: "card", shape: "roundRect", x: 0, y: 0, w: 3, h: 1, style: { borderRadius: "rounded.lg", fill: "linear-gradient(red, blue)" } },
      { type: "text", id: "title", x: 0, y: 0, w: 3, h: 0.5, text: "AI \u{1F4A1}", style: { typography: "{typography.title}" } }
    ];
    const a = scoreSlopRisk(slide(elements));
    const b = scoreSlopRisk(slide(elements));
    expect(a.score).toBe(b.score);
    expect(a.signals).toEqual(b.signals);
  });

  it("clean manifest yields 0", () => {
    const elements = [
      { type: "text", id: "t", x: 0, y: 0, w: 4, h: 0.5, text: "Hello world", style: { fontFamily: "Inter, sans-serif" } }
    ];
    const result = scoreSlopRisk(slide(elements));
    expect(result.score).toBe(0);
    expect(result.signals.every((s) => s.weight === 0)).toBe(true);
  });

  it("returns 9 signals with stable IDs", () => {
    const result = scoreSlopRisk(slide([]));
    expect(result.signals).toHaveLength(9);
    const ids = result.signals.map((s) => s.id).sort();
    expect(ids).toEqual([
      "all-caps-stroke-shadow",
      "css-gradient",
      "emoji-as-icon",
      "english-rhetoric-on-zh",
      "font-family-dedup",
      "icon-circle-triad",
      "kpi-sandwich",
      "rounded-token-variance",
      "vertical-rhythm-variance"
    ]);
  });
});

describe("slop-risk.mjs — contextual rule contracts and paired calibration", () => {
  it("declares the complete closed policy fields for all nine rules", () => {
    expect(SLOP_RULES).toHaveLength(9);
    for (const rule of SLOP_RULES) {
      expect(Object.keys(rule)).toEqual(["id", "category", "applicableWhen", "exemptWhen", "severity", "confidence", "evidence", "repairCommand", "brandOverrideAllowed", "readabilityOverrideAllowed"]);
      expect(rule.applicableWhen.length).toBeGreaterThan(0);
      expect(rule.exemptWhen.length).toBeGreaterThan(0);
      expect(rule.readabilityOverrideAllowed).toBe(false);
    }
  });

  it("calibrates every rule on at least six flag and six pass fixtures", async () => {
    const fixture = JSON.parse(await readFile(new URL("./fixtures/slop-rules/paired-cases.json", import.meta.url), "utf8"));
    const records = [];
    for (const group of fixture.rules) {
      expect(group.shouldFlag).toHaveLength(6);
      expect(group.shouldPass).toHaveLength(6);
      for (const [expectedFlag, cases] of [[true, group.shouldFlag], [false, group.shouldPass]]) {
        for (const item of cases) {
          const report = scoreSlopRisk(scenario(item.scenario ?? group.trigger), {}, item.context ?? {});
          const signal = report.signals.find((entry) => entry.id === group.ruleId);
          expect(signal.weight > 0, item.id).toBe(expectedFlag);
          records.push({ ruleId: group.ruleId, expectedFlag, formulaFlag: signal.weight > 0, reviewerRisk: expectedFlag ? SLOP_WEIGHTS[Object.keys(SLOP_WEIGHTS).find((key) => SLOP_RULES.find((rule) => rule.id === group.ruleId) && key.toLowerCase().replace(/[^a-z]/g, "") === group.ruleId.replace(/-/g, ""))] ?? signal.weight : 0, formulaRisk: signal.weight });
        }
      }
    }
    const calibration = calibrateSlopRules(records);
    expect(calibration.passed).toBe(true);
    for (const entry of calibration.perRule) {
      expect(entry).toMatchObject({ cases: 12, recall: 1, specificity: 1, falsePositiveRate: 0, passed: true });
    }
    expect(calibration.agreement).toMatchObject({ agreementWithin20: 1, spearman: 1, mae: 0 });
  });

  it("never lets a contextual exemption suppress an active readability risk", () => {
    const report = scoreSlopRisk(scenario("gradient"), {}, { brandLocked: true, gradientIntent: "approved-brand", readabilityRisk: true });
    const signal = report.signals.find((entry) => entry.id === "css-gradient");
    expect(signal).toMatchObject({ applicable: true, exempted: false, readabilityOverrideAllowed: false });
    expect(signal.weight).toBe(SLOP_WEIGHTS.cssGradient);
  });

  it("emits schema-valid closed rule evidence through the visual critic", async () => {
    const schema = JSON.parse(await readFile(new URL("../schemas/visual-review.schema.json", import.meta.url), "utf8"));
    const review = reviewManifest(scenario("gradient"), { mode: "creative" });
    expect(validateJsonSchema(review, schema)).toEqual({ valid: true, errors: [] });
    expect(review.slides[0].slopSignals.find((entry) => entry.id === "css-gradient")).toMatchObject({
      category: "color-material", repairCommand: "colorize", readabilityOverrideAllowed: false
    });
  });
});
