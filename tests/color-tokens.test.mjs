import { describe, expect, it } from "vitest";
import {
  buildTokenLookup,
  deltaE76,
  exactTokenRef,
  hexToRgb,
  resolveTokens
} from "../scripts/lib/color-tokens.mjs";

const DESIGN_WITH_RED = {
  colors: {
    primary: "#FF0000",
    secondary: "#0000FF",
    text: "#111111"
  }
};

describe("color-tokens / deltaE76 math", () => {
  it("returns 0 for identical colors", () => {
    expect(deltaE76([255, 0, 0], [255, 0, 0])).toBe(0);
    expect(deltaE76("#FF0000", "#FF0000")).toBe(0);
  });

  it("returns a large value for clearly different colors (red vs green)", () => {
    const d = deltaE76([255, 0, 0], [0, 255, 0]);
    expect(d).toBeGreaterThan(8);
  });

  it("accepts hex strings or rgb tuples interchangeably", () => {
    const fromTuples = deltaE76([10, 20, 30], [40, 50, 60]);
    const fromHex = deltaE76("#0A141E", "#28323C");
    expect(fromTuples).toBeCloseTo(fromHex, 6);
  });

  it("rejects malformed hex", () => {
    expect(() => hexToRgb("not-a-color")).toThrow();
    expect(() => hexToRgb("#FFF")).toThrow();
  });
});

describe("color-tokens / resolveTokens", () => {
  it("matches #FF0000 against a design system with a red token at ΔE76 ≤ 8", () => {
    const result = resolveTokens(
      [{ hex: "#FF0000", origin: "palette-0" }],
      DESIGN_WITH_RED,
      { threshold: 8 }
    );
    expect(result.skipped).toBe(false);
    expect(result.matches).toHaveLength(1);
    expect(result.unmapped).toHaveLength(0);
    const match = result.matches[0];
    expect(match.tokenName).toBe("primary");
    expect(match.extractedHex).toBe("#FF0000");
    expect(match.deltaE).toBeLessThanOrEqual(8);
    // ΔE for #FF0000 vs #FF0000 is 0, so confidence ≈ 1.0.
    expect(match.confidence).toBeCloseTo(1, 5);
    expect(result.paletteMatch).toBeGreaterThan(0.99);
  });

  it("matches slightly-off red with computed ΔE and confidence inversely proportional to distance", () => {
    const result = resolveTokens(
      [{ hex: "#FE0001", origin: "palette-0" }],
      DESIGN_WITH_RED,
      { threshold: 8 }
    );
    expect(result.skipped).toBe(false);
    expect(result.matches).toHaveLength(1);
    expect(result.unmapped).toHaveLength(0);
    const match = result.matches[0];
    expect(match.tokenName).toBe("primary");
    // ΔE76(#FE0001, #FF0000) ≈ 0.37; below the threshold but > 0.
    expect(match.deltaE).toBeGreaterThan(0);
    expect(match.deltaE).toBeLessThan(8);
    expect(match.confidence).toBeLessThan(1);
    expect(match.confidence).toBeGreaterThan(0.9);
    // Confidence = 1 - (ΔE / threshold) → derive and compare.
    const expected = 1 - match.deltaE / 8;
    expect(match.confidence).toBeCloseTo(expected, 4);
  });

  it("marks green as unmapped when no green token exists, lowering paletteMatch", () => {
    const result = resolveTokens(
      [{ hex: "#00FF00", origin: "palette-0" }],
      DESIGN_WITH_RED,
      { threshold: 8 }
    );
    expect(result.skipped).toBe(false);
    expect(result.matches).toHaveLength(0);
    expect(result.unmapped).toHaveLength(1);
    expect(result.unmapped[0].extractedHex).toBe("#00FF00");
    expect(result.unmapped[0].origin).toBe("palette-0");
    expect(result.paletteMatch).toBeLessThan(1);
    expect(result.paletteMatch).toBe(0);
  });

  it("returns skipped result when isReplica is true", () => {
    const result = resolveTokens(
      [{ hex: "#FF0000", origin: "palette-0" }],
      DESIGN_WITH_RED,
      { isReplica: true }
    );
    expect(result.skipped).toBe(true);
    expect(result.matches).toEqual([]);
    expect(result.unmapped).toEqual([]);
    expect(result.paletteMatch).toBe(0);
  });

  it("returns paletteMatch: 1 for empty extractedColors (no mismatch to measure)", () => {
    const result = resolveTokens([], DESIGN_WITH_RED);
    expect(result.skipped).toBe(false);
    expect(result.matches).toEqual([]);
    expect(result.unmapped).toEqual([]);
    expect(result.paletteMatch).toBe(1);
  });

  it("marks every extracted color as unmapped when designTokens.colors is empty", () => {
    const result = resolveTokens(
      [
        { hex: "#FF0000", origin: "a" },
        { hex: "#00FF00", origin: "b" }
      ],
      { colors: {} }
    );
    expect(result.skipped).toBe(false);
    expect(result.matches).toEqual([]);
    expect(result.unmapped).toHaveLength(2);
    expect(result.paletteMatch).toBe(0);
  });

  it("rejects unknown formulas", () => {
    expect(() => resolveTokens([], DESIGN_WITH_RED, { formula: "ΔE94" })).toThrow(/unsupported formula/);
  });

  it("rejects non-positive thresholds", () => {
    expect(() => resolveTokens([], DESIGN_WITH_RED, { threshold: 0 })).toThrow(/threshold/);
    expect(() => resolveTokens([], DESIGN_WITH_RED, { threshold: -1 })).toThrow(/threshold/);
  });

  it("mixes matched and unmatched colors and reflects confidence in paletteMatch", () => {
    const result = resolveTokens(
      [
        { hex: "#FF0000", origin: "a" },
        { hex: "#00FF00", origin: "b" }
      ],
      DESIGN_WITH_RED,
      { threshold: 8 }
    );
    expect(result.matches).toHaveLength(1);
    expect(result.unmapped).toHaveLength(1);
    expect(result.paletteMatch).toBeGreaterThan(0);
    expect(result.paletteMatch).toBeLessThan(1);
  });
});

describe("color-tokens / exactTokenRef + lookup", () => {
  it("buildTokenLookup maps normalized uppercase hex values to token names", () => {
    const lookup = buildTokenLookup(DESIGN_WITH_RED);
    // The lookup uses uppercase keys internally; exactTokenRef does the
    // case-insensitive normalization at the public API boundary.
    expect(lookup.get("#FF0000")).toBe("primary");
    expect(lookup.get("#0000FF")).toBe("secondary");
  });

  it("exactTokenRef returns a token reference for an exact hex match", () => {
    const lookup = buildTokenLookup(DESIGN_WITH_RED);
    expect(exactTokenRef("#FF0000", lookup)).toBe("colors.primary");
    expect(exactTokenRef("#ABCDEF", lookup)).toBeNull();
  });

  it("exactTokenRef normalizes lowercase hex input", () => {
    const lookup = buildTokenLookup(DESIGN_WITH_RED);
    expect(exactTokenRef("#ff0000", lookup)).toBe("colors.primary");
  });

  it("exactTokenRef tolerates missing leading #", () => {
    const lookup = buildTokenLookup(DESIGN_WITH_RED);
    expect(exactTokenRef("FF0000", lookup)).toBe("colors.primary");
  });
});