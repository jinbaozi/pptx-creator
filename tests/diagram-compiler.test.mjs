import { describe, expect, it } from "vitest";
import { expandDiagramElement } from "../scripts/lib/diagram-compiler.mjs";

function layeredFixture() {
  return {
    type: "diagram",
    kind: "layeredArchitecture",
    id: "diagram-001",
    semanticParentId: "slide-node",
    x: 0.7,
    y: 1.2,
    w: 11,
    h: 5.2,
    layers: [
      { id: "front/end", label: "Frontend", nodes: [{ id: "pre/process", label: "Preprocess" }, "Parse"] },
      { label: "中间层", nodes: ["IR", "Optimize"] },
      { label: "Backend", nodes: ["Codegen", "Assemble"] }
    ],
    style: { theme: "business-tech", connector: "orthogonal", density: "medium" }
  };
}

function ids(elements) {
  return elements.map((element) => element.id);
}

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

  it("emits deterministic unique semantic layer, node, and connector paths with immediate lineage", () => {
    const fixture = layeredFixture();
    const before = structuredClone(fixture);
    const first = expandDiagramElement(fixture);
    const second = expandDiagramElement(fixture);

    expect(first).toEqual(second);
    expect(fixture).toEqual(before);
    expect(new Set(ids(first)).size).toBe(first.length);
    expect(first.every((element) => element.semanticParentId === fixture.id)).toBe(true);
    expect(ids(first)).toEqual(expect.arrayContaining([
      "diagram-001__diagram__layer-front-end__shape",
      "diagram-001__diagram__layer-front-end__label",
      "diagram-001__diagram__layer-front-end__node-pre-process__shape",
      "diagram-001__diagram__layer-front-end__node-pre-process__label",
      "diagram-001__diagram__layer-中间层__shape",
      "diagram-001__diagram__connector__source-front-end__target-中间层"
    ]));
    expect(ids(first).every((id) => !/[ /]/.test(id))).toBe(true);

    const primitiveIds = new Set(ids(first));
    for (const connector of first.filter((element) => element.type === "line")) {
      expect(primitiveIds.has(connector.style.sourceId), `${connector.id} source`).toBe(true);
      expect(primitiveIds.has(connector.style.targetId), `${connector.id} target`).toBe(true);
    }
  });

  it("keeps uniquely identified layer and node child IDs stable across unrelated insertion", () => {
    const base = layeredFixture();
    const stableIds = ids(expandDiagramElement(base)).filter((id) => !id.includes("__connector"));
    const inserted = structuredClone(base);
    inserted.layers.splice(1, 0, { label: "Unrelated Layer", nodes: ["Audit"] });
    const insertedIds = new Set(ids(expandDiagramElement(inserted)));
    for (const id of stableIds) expect(insertedIds.has(id), id).toBe(true);

    const duplicates = layeredFixture();
    duplicates.layers = [
      { label: "Same", nodes: ["Node"] },
      { label: "Same", nodes: ["Node"] }
    ];
    const duplicateIds = ids(expandDiagramElement(duplicates));
    expect(duplicateIds.some((id) => id.includes("layer-same__"))).toBe(true);
    expect(duplicateIds.some((id) => id.includes("layer-same__occurrence-2__"))).toBe(true);
    expect(new Set(duplicateIds).size).toBe(duplicateIds.length);
  });

  it("allocates collision-safe layer and node keys and skips invalid identity candidates", () => {
    const element = {
      type: "diagram",
      kind: "layeredArchitecture",
      id: "collision-diagram",
      x: 0,
      y: 0,
      w: 8,
      h: 5,
      layers: [
        {
          id: "a",
          label: "First",
          nodes: [
            { id: "///", name: "Useful Node", label: "Ignored Node Label" },
            { id: "!!!", name: "???", label: "Useful Node Label" }
          ]
        },
        { id: "a-2", label: "Second", nodes: [] },
        { id: "a", label: "Third", nodes: [] },
        { id: "///", name: "Useful Layer", label: "Ignored Layer Label", nodes: [] }
      ]
    };
    const expanded = expandDiagramElement(element);
    const expandedIds = ids(expanded);

    expect(new Set(expandedIds).size).toBe(expandedIds.length);
    expect(expandedIds).toEqual(expect.arrayContaining([
      "collision-diagram__diagram__layer-a__shape",
      "collision-diagram__diagram__layer-a-2__shape",
      "collision-diagram__diagram__layer-a__occurrence-2__shape",
      "collision-diagram__diagram__layer-useful-layer__shape",
      "collision-diagram__diagram__layer-a__node-useful-node__shape",
      "collision-diagram__diagram__layer-a__node-useful-node-label__shape"
    ]));

    const primitiveIds = new Set(expandedIds);
    for (const connector of expanded.filter((child) => child.type === "line")) {
      expect(connector.style.sourceId).not.toBe(connector.style.targetId);
      expect(primitiveIds.has(connector.style.sourceId), `${connector.id} source`).toBe(true);
      expect(primitiveIds.has(connector.style.targetId), `${connector.id} target`).toBe(true);
    }
  });

  it("keeps duplicate occurrences stable when natural suffix-like keys are inserted", () => {
    const diagram = (layers) => expandDiagramElement({
      type: "diagram",
      kind: "layeredArchitecture",
      id: "occurrence-diagram",
      x: 0,
      y: 0,
      w: 8,
      h: 4,
      layers
    });
    const base = diagram([
      { id: "a", label: "First", nodes: [] },
      { id: "a", label: "Second", nodes: [] }
    ]);
    const inserted = diagram([
      { id: "a", label: "First", nodes: [] },
      { id: "a-2", label: "Natural", nodes: [] },
      { id: "a", label: "Second", nodes: [] }
    ]);

    const textId = (elements, value) => elements.find(
      (child) => child.type === "text" && child.text === value
    )?.id;
    expect(textId(base, "Second")).toBe("occurrence-diagram__diagram__layer-a__occurrence-2__label");
    expect(textId(inserted, "Second")).toBe(textId(base, "Second"));
    expect(textId(inserted, "Natural")).toBe("occurrence-diagram__diagram__layer-a-2__label");

    const fallback = diagram([
      { id: "///", name: "???", label: "!!!", nodes: [] },
      { id: "layer-1", label: "Natural Layer", nodes: [] }
    ]);
    expect(textId(fallback, "!!!")).toContain("__position-1__label");
    expect(textId(fallback, "Natural Layer")).toBe("occurrence-diagram__diagram__layer-layer-1__label");
  });

  it("uses unambiguous connector source and target segments", () => {
    const expanded = expandDiagramElement({
      type: "diagram",
      kind: "layeredArchitecture",
      id: "connector-diagram",
      x: 0,
      y: 0,
      w: 8,
      h: 5,
      layers: [
        { id: "a", label: "A", nodes: [] },
        { id: "b-to-c", label: "B to C", nodes: [] },
        { id: "a-to-b", label: "A to B", nodes: [] },
        { id: "c", label: "C", nodes: [] }
      ]
    });
    const connectorIds = ids(expanded.filter((child) => child.type === "line"));

    expect(new Set(connectorIds).size).toBe(connectorIds.length);
    expect(connectorIds).toEqual(expect.arrayContaining([
      "connector-diagram__diagram__connector__source-a__target-b-to-c",
      "connector-diagram__diagram__connector__source-a-to-b__target-c"
    ]));
  });

  it("uses object metadata for identity without changing legacy display coercion", () => {
    const layered = expandDiagramElement({
      type: "diagram",
      kind: "layeredArchitecture",
      id: "display-diagram",
      x: 0,
      y: 0,
      w: 8,
      h: 3,
      layers: [{
        id: "layer-id",
        name: "Name Only",
        nodes: [{ id: "node-id", label: "Node Label" }]
      }]
    });
    expect(layered.find((child) => child.id.endsWith("layer-layer-id__label"))?.text).toBe("");
    expect(layered.find((child) => child.id.endsWith("node-node-id__label"))?.text).toBe("[object Object]");

    const matrix = expandDiagramElement({
      type: "diagram",
      kind: "matrixMap",
      id: "display-matrix",
      x: 0,
      y: 0,
      w: 8,
      h: 4,
      rows: [{ id: "row-id", label: "Row Label" }],
      columns: [{ id: "column-id", label: "Column Label" }]
    });
    expect(matrix.find((child) => child.id.endsWith("row-row-id__label"))?.text).toBe("[object Object]");
    expect(matrix.find((child) => child.id.endsWith("column-column-id__label"))?.text).toBe("[object Object]");
  });

  it("uses semantic row, column, and cell paths for matrix maps", () => {
    const element = {
      type: "diagram", kind: "matrixMap", id: "matrix-001", x: 0, y: 0, w: 8, h: 4,
      rows: [{ id: "now", label: "Now" }, "Later"],
      columns: [{ id: "high/value", label: "High Value" }, "Low Value"]
    };
    const expanded = expandDiagramElement(element);
    expect(ids(expanded)).toEqual(expect.arrayContaining([
      "matrix-001__diagram__column-high-value__label",
      "matrix-001__diagram__row-now__label",
      "matrix-001__diagram__row-now__column-high-value__cell"
    ]));
    expect(expanded.every((child) => child.semanticParentId === element.id)).toBe(true);

    const inserted = structuredClone(element);
    inserted.rows.unshift("Unrelated");
    inserted.columns.unshift("Other");
    const insertedIds = new Set(ids(expandDiagramElement(inserted)));
    for (const id of ids(expanded)) expect(insertedIds.has(id), id).toBe(true);
  });
});
