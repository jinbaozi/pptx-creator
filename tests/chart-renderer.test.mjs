import { describe, expect, it } from "vitest";
import { expandChartElement } from "../scripts/lib/chart-renderer.mjs";

function stackedFixture() {
  return {
    type: "chart",
    kind: "stackedBar",
    id: "chart-001",
    semanticParentId: "slide-node",
    x: 1,
    y: 1,
    w: 6,
    h: 3,
    data: [
      { id: "phase/alpha", label: "Phase α", series: { "Dev Team": 30, "QA/Test": 10 } },
      { label: "第二阶段", series: { "Dev Team": 20, "QA/Test": 20 } }
    ],
    style: { palette: ["#36C5F0", "#7CFFB2"], showLegend: true, showValues: true }
  };
}

function ids(elements) {
  return elements.map((element) => element.id);
}

describe("chart renderer expansion", () => {
  it("expands stacked bars into editable shapes and labels", () => {
    const elements = expandChartElement({
      type: "chart",
      kind: "stackedBar",
      id: "chart-001",
      x: 1,
      y: 1,
      w: 6,
      h: 3,
      data: [
        { label: "Phase 1", series: { Dev: 30, Test: 10 } },
        { label: "Phase 2", series: { Dev: 20, Test: 20 } }
      ],
      style: { palette: ["#36C5F0", "#7CFFB2"], showLegend: true, showValues: true }
    });
    expect(elements.some((element) => element.type === "shape")).toBe(true);
    expect(elements.some((element) => element.type === "text" && element.text === "Phase 1")).toBe(true);
  });

  it("expands KPI groups into editable text and shapes", () => {
    const elements = expandChartElement({
      type: "chart",
      kind: "kpiGroup",
      id: "kpi-001",
      x: 0.8,
      y: 1,
      w: 10,
      h: 2,
      data: [{ label: "Compile", value: 95 }, { label: "Optimize", value: 88 }]
    });
    expect(elements.filter((element) => element.type === "text").length).toBeGreaterThanOrEqual(4);
  });

  it("emits deterministic unique semantic chart paths with immediate lineage", () => {
    const fixture = stackedFixture();
    const before = structuredClone(fixture);
    const first = expandChartElement(fixture);
    const second = expandChartElement(fixture);

    expect(first).toEqual(second);
    expect(fixture).toEqual(before);
    expect(new Set(ids(first)).size).toBe(first.length);
    expect(first.every((element) => element.semanticParentId === fixture.id)).toBe(true);
    expect(ids(first)).toEqual(expect.arrayContaining([
      "chart-001__chart__point-phase-alpha__series-dev-team__segment",
      "chart-001__chart__point-phase-alpha__series-qa-test__segment",
      "chart-001__chart__point-phase-alpha__label",
      "chart-001__chart__point-第二阶段__series-dev-team__segment",
      "chart-001__chart__series-dev-team__legend-segment",
      "chart-001__chart__series-dev-team__legend-label"
    ]));
    expect(ids(first).every((id) => !/[ /]/.test(id))).toBe(true);

    const duplicates = stackedFixture();
    duplicates.data = [
      { label: "Same", series: { Value: 1 } },
      { label: "Same", series: { Value: 2 } }
    ];
    const duplicateIds = ids(expandChartElement(duplicates));
    expect(duplicateIds.some((id) => id.includes("point-same__"))).toBe(true);
    expect(duplicateIds.some((id) => id.includes("point-same__occurrence-2__"))).toBe(true);
    expect(new Set(duplicateIds).size).toBe(duplicateIds.length);
  });

  it("keeps uniquely identified point and series child IDs stable across unrelated insertion", () => {
    const base = stackedFixture();
    const baseIds = new Set(ids(expandChartElement(base)));

    const inserted = structuredClone(base);
    inserted.data.splice(1, 0, { label: "Unrelated", series: { "Dev Team": 5, "QA/Test": 4, Ops: 3 } });
    inserted.data.forEach((point) => { point.series.Ops ??= 0; });
    const insertedIds = new Set(ids(expandChartElement(inserted)));

    for (const id of baseIds) expect(insertedIds.has(id), id).toBe(true);
  });

  it("allocates collision-safe point keys and skips invalid identity candidates", () => {
    const expandedIds = ids(expandChartElement({
      type: "chart",
      kind: "stackedBar",
      id: "collision-chart",
      x: 0,
      y: 0,
      w: 8,
      h: 3,
      data: [
        { id: "a", label: "First", series: { Value: 1 } },
        { id: "a-2", label: "Second", series: { Value: 2 } },
        { id: "a", label: "Third", series: { Value: 3 } },
        { id: "///", name: "Useful Name", label: "Ignored Label", series: { Value: 4 } },
        { id: "!!!", name: "???", label: "Useful Label", series: { Value: 5 } }
      ]
    }));

    expect(new Set(expandedIds).size).toBe(expandedIds.length);
    expect(expandedIds).toEqual(expect.arrayContaining([
      "collision-chart__chart__point-a__series-value__segment",
      "collision-chart__chart__point-a-2__series-value__segment",
      "collision-chart__chart__point-a__occurrence-2__series-value__segment",
      "collision-chart__chart__point-useful-name__series-value__segment",
      "collision-chart__chart__point-useful-label__series-value__segment"
    ]));
  });

  it("keeps duplicate occurrences stable when natural suffix-like keys are inserted", () => {
    const chart = (data) => expandChartElement({
      type: "chart",
      kind: "horizontalBar",
      id: "occurrence-chart",
      x: 0,
      y: 0,
      w: 8,
      h: 3,
      data
    });
    const base = chart([
      { id: "a", label: "First", value: 1 },
      { id: "a", label: "Second", value: 2 }
    ]);
    const inserted = chart([
      { id: "a", label: "First", value: 1 },
      { id: "a-2", label: "Natural", value: 99 },
      { id: "a", label: "Second", value: 2 }
    ]);

    const textId = (elements, value) => elements.find(
      (child) => child.type === "text" && child.text === String(value)
    )?.id;
    expect(textId(base, 2)).toBe("occurrence-chart__chart__point-a__occurrence-2__value");
    expect(textId(inserted, 2)).toBe(textId(base, 2));
    expect(textId(inserted, 99)).toBe("occurrence-chart__chart__point-a-2__value");

    const fallback = chart([
      { id: "///", name: "???", label: "!!!", value: 11 },
      { id: "point-1", label: "Natural Point", value: 22 }
    ]);
    expect(textId(fallback, 11)).toContain("__position-1__value");
    expect(textId(fallback, 22)).toBe("occurrence-chart__chart__point-point-1__value");
  });

  it("uses semantic KPI, horizontal point, and sparkline segment roles", () => {
    const kpi = expandChartElement({
      type: "chart", kind: "kpiGroup", id: "kpi-chart", x: 0, y: 0, w: 8, h: 2,
      data: [{ id: "compile", label: "Compile", value: 95 }]
    });
    expect(ids(kpi)).toEqual(expect.arrayContaining([
      "kpi-chart__chart__kpi-compile__card",
      "kpi-chart__chart__kpi-compile__accent",
      "kpi-chart__chart__kpi-compile__value",
      "kpi-chart__chart__kpi-compile__label"
    ]));

    const horizontal = expandChartElement({
      type: "chart", kind: "horizontalBar", id: "bar-chart", x: 0, y: 0, w: 8, h: 2,
      data: [{ label: "Readiness", value: 84 }]
    });
    expect(ids(horizontal)).toEqual(expect.arrayContaining([
      "bar-chart__chart__point-readiness__label",
      "bar-chart__chart__point-readiness__segment",
      "bar-chart__chart__point-readiness__value"
    ]));

    const sparkline = expandChartElement({
      type: "chart", kind: "sparkline", id: "spark-chart", x: 0, y: 0, w: 8, h: 2,
      data: [{ label: "Start", value: 2 }, { label: "End", value: 5 }]
    });
    expect(ids(sparkline)).toEqual(expect.arrayContaining([
      "spark-chart__chart__series-main__segment__source-start__target-end",
      "spark-chart__chart__point-end__value"
    ]));
  });

  it("uses unambiguous sparkline source and target segments", () => {
    const lineIds = ids(expandChartElement({
      type: "chart",
      kind: "sparkline",
      id: "ambiguous-spark",
      x: 0,
      y: 0,
      w: 8,
      h: 2,
      data: [
        { id: "a", value: 1 },
        { id: "b-to-c", value: 2 },
        { id: "a-to-b", value: 3 },
        { id: "c", value: 4 }
      ]
    }).filter((child) => child.type === "line"));

    expect(lineIds).toHaveLength(3);
    expect(new Set(lineIds).size).toBe(lineIds.length);
    expect(lineIds).toEqual(expect.arrayContaining([
      "ambiguous-spark__chart__series-main__segment__source-a__target-b-to-c",
      "ambiguous-spark__chart__series-main__segment__source-a-to-b__target-c"
    ]));
  });

  it("returns legacy chart kinds one-to-one without mutation or invented lineage", () => {
    for (const kind of ["bar", "line", "pie"]) {
      const element = {
        type: "chart", kind, id: `legacy-${kind}`, x: 0, y: 0, w: 4, h: 2,
        data: [{ label: "A", value: 1 }]
      };
      const before = structuredClone(element);
      const expanded = expandChartElement(element);
      expect(expanded).toHaveLength(1);
      expect(expanded[0]).toBe(element);
      expect(expanded[0]).not.toHaveProperty("semanticParentId");
      expect(element).toEqual(before);
    }
  });
});
