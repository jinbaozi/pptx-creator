import { describe, expect, it } from "vitest";
import { expandChartElement } from "../scripts/lib/chart-renderer.mjs";

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
});
