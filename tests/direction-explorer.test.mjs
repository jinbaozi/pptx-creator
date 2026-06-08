import { describe, expect, it } from "vitest";
import { createDirectionCandidates, rankDirections, selectRepresentativeSlides } from "../scripts/lib/direction-explorer.mjs";

describe("direction exploration", () => {
  it("creates three visually distinct candidate directions", () => {
    const directions = createDirectionCandidates({ title: "kycc Roadshow", audience: "technical buyers" });
    expect(directions).toHaveLength(3);
    expect(new Set(directions.map((direction) => direction.id)).size).toBe(3);
    expect(new Set(directions.map((direction) => direction.layoutStrategy)).size).toBe(3);
  });

  it("selects cover, architecture, and value slides when available", () => {
    const storyboard = {
      slides: [
        { id: "slide-001", role: "cover" },
        { id: "slide-002", role: "background" },
        { id: "slide-003", role: "architecture" },
        { id: "slide-004", role: "user-value" }
      ]
    };
    expect(selectRepresentativeSlides(storyboard)).toEqual(["slide-001", "slide-003", "slide-004"]);
  });

  it("ranks directions by total score descending", () => {
    const ranked = rankDirections([
      { directionId: "direction-001", total: 84 },
      { directionId: "direction-002", total: 91 },
      { directionId: "direction-003", total: 78 }
    ]);
    expect(ranked[0].directionId).toBe("direction-002");
  });
});
