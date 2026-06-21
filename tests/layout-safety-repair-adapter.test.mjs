import { describe, expect, it } from "vitest";
import { convertOne, convertSuggestions } from "../scripts/lib/layout-safety-repair-adapter.mjs";

describe("layout-safety-repair-adapter", () => {
  it("maps bounds with x/y suggestion to a move patch", () => {
    const patches = convertSuggestions(
      [{ kind: "bounds", elementId: "el-1", slideId: "s1", suggestion: { x: 0.5, y: 1.0 } }],
      "fallback"
    );
    expect(patches).toHaveLength(1);
    expect(patches[0].operation).toBe("move");
    expect(patches[0].changes).toEqual({ x: 0.5, y: 1.0 });
    expect(patches[0].targetElementId).toBe("el-1");
  });

  it("maps bounds with w/h suggestion to a resize patch", () => {
    const patches = convertSuggestions(
      [{ kind: "bounds", elementId: "el-1", slideId: "s1", suggestion: { w: 4, h: 2 } }],
      "fallback"
    );
    expect(patches).toHaveLength(1);
    expect(patches[0].operation).toBe("resize");
    expect(patches[0].changes).toEqual({ w: 4, h: 2 });
  });

  it("maps bounds with x/y/w/h to both move and resize patches", () => {
    const patches = convertSuggestions(
      [{ kind: "bounds", elementId: "el-1", slideId: "s1", suggestion: { x: 0, y: 0, w: 5, h: 3 } }],
      "fallback"
    );
    expect(patches).toHaveLength(2);
    expect(patches.map((p) => p.operation).sort()).toEqual(["move", "resize"]);
  });

  it("maps font-too-small to updateStyle with fontSize 12", () => {
    const [patch] = convertSuggestions(
      [{ kind: "font-too-small", elementId: "el-2", slideId: "s1" }],
      "fallback"
    );
    expect(patch.operation).toBe("updateStyle");
    expect(patch.changes.style.fontSize).toBe(12);
  });

  it("maps card-spacing-tight to increaseSpacing with spacing.md", () => {
    const [patch] = convertSuggestions(
      [{ kind: "card-spacing-tight", elementId: "el-3", slideId: "s1" }],
      "fallback"
    );
    expect(patch.operation).toBe("increaseSpacing");
    expect(patch.changes.padding).toBe("spacing.md");
    expect(patch.changes._inches).toBe(0.5);
  });

  it("maps text-overflow to reduceDensity", () => {
    const [patch] = convertSuggestions(
      [{ kind: "text-overflow", elementId: "el-4", slideId: "s1" }],
      "fallback"
    );
    expect(patch.operation).toBe("reduceDensity");
    expect(patch.targetElementId).toBe("el-4");
  });

  it("maps connector-detached endpoint suggestions to move and resize", () => {
    const patches = convertSuggestions([
      {
        kind: "connector-detached",
        elementId: "connector-1",
        slideId: "s1",
        suggestion: { x: 2, y: 2, w: 0, h: 1 }
      }
    ]);
    expect(patches).toEqual([
      { operation: "move", targetElementId: "connector-1", slideId: "s1", changes: { x: 2, y: 2 } },
      { operation: "resize", targetElementId: "connector-1", slideId: "s1", changes: { w: 0, h: 1 } }
    ]);
  });

  it("maps line-height-too-tight to adjustStyle with lineHeight 1.4 and suggestionKind", () => {
    const [patch] = convertSuggestions(
      [{ kind: "line-height-too-tight", elementId: "el-5", slideId: "s1" }],
      "fallback"
    );
    expect(patch.operation).toBe("adjustStyle");
    expect(patch.changes.style.lineHeight).toBe(1.4);
    expect(patch.changes.suggestionKind).toBe("line-height-too-tight");
  });

  it("returns null for unknown kind", () => {
    expect(convertOne({ kind: "mystery", elementId: "el-x", slideId: "s1" }, "fallback")).toBeNull();
  });

  it("output array length is sum of emit per check", () => {
    const checks = [
      { kind: "font-too-small", elementId: "a", slideId: "s1" },
      { kind: "text-overflow", elementId: "b", slideId: "s1" },
      { kind: "bounds", elementId: "c", slideId: "s1", suggestion: { x: 0, y: 0, w: 2, h: 2 } },
      { kind: "mystery", elementId: "d", slideId: "s1" }
    ];
    const patches = convertSuggestions(checks, "fallback");
    expect(patches).toHaveLength(4);
    expect(patches.filter((p) => p.operation === "move").length).toBe(1);
    expect(patches.filter((p) => p.operation === "resize").length).toBe(1);
    expect(patches.filter((p) => p.operation === "updateStyle").length).toBe(1);
    expect(patches.filter((p) => p.operation === "reduceDensity").length).toBe(1);
  });
});
