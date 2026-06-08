import { describe, expect, it } from "vitest";
import { expandDiagramElement } from "../scripts/lib/diagram-compiler.mjs";

describe("diagram compiler", () => {
  it("expands layered architecture diagrams into native shapes, lines, and text", () => {
    const elements = expandDiagramElement({
      type: "diagram",
      kind: "layeredArchitecture",
      id: "diagram-001",
      x: 0.7,
      y: 1.2,
      w: 11,
      h: 5.2,
      layers: [
        { label: "Frontend", nodes: ["Preprocess", "Parse"] },
        { label: "Middle End", nodes: ["IR", "Optimize"] },
        { label: "Backend", nodes: ["Codegen", "Assemble"] }
      ],
      style: { theme: "business-tech", connector: "orthogonal", density: "medium" }
    });
    expect(elements.some((element) => element.type === "shape")).toBe(true);
    expect(elements.some((element) => element.type === "line")).toBe(true);
    expect(elements.some((element) => element.type === "text" && element.text === "Frontend")).toBe(true);
  });

  it("expands capability stacks into editable layers", () => {
    const elements = expandDiagramElement({
      type: "diagram",
      kind: "capabilityStack",
      id: "diagram-002",
      x: 1,
      y: 1,
      w: 6,
      h: 4,
      layers: [
        { label: "Driver", nodes: ["CLI"] },
        { label: "Frontend", nodes: ["Lexer", "Parser"] }
      ]
    });
    expect(elements.filter((element) => element.type === "text").map((element) => element.text)).toContain("Driver");
  });
});
