import { describe, expect, it } from "vitest";
import { resolveConnectorGeometry, resolveSemanticConnectors } from "../scripts/lib/connector-resolver.mjs";

describe("semantic connector resolver", () => {
  it("resolves automatic anchors against final node boundaries", () => {
    const elements = [
      { type: "shape", id: "a", x: 1, y: 1, w: 2, h: 1 },
      { type: "shape", id: "b", x: 5, y: 1.5, w: 2, h: 1 },
      { type: "line", role: "connector", id: "connector-a-b", x: 0, y: 0, w: 1, h: 1, connector: { sourceId: "a", targetId: "b", sourceAnchor: "auto", targetAnchor: "auto", route: "straight" }, style: {} }
    ];
    const resolved = resolveSemanticConnectors(elements);
    const line = resolved.find((element) => element.id === "connector-a-b");

    expect(line).toMatchObject({ x: 3, y: 1.5, w: 2, h: 0.5 });
    expect(elements[2]).toMatchObject({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("honors explicit source and target anchors", () => {
    const byId = new Map([
      ["a", { id: "a", x: 1, y: 1, w: 2, h: 1 }],
      ["b", { id: "b", x: 5, y: 4, w: 2, h: 1 }]
    ]);
    const line = resolveConnectorGeometry({
      type: "line", role: "connector", id: "connector-a-b", x: 0, y: 0, w: 1, h: 1,
      connector: { sourceId: "a", targetId: "b", sourceAnchor: "bottom", targetAnchor: "left", route: "straight" }, style: {}
    }, byId);

    expect(line).toMatchObject({ x: 2, y: 2, w: 3, h: 2.5 });
  });

  it("normalizes legacy style endpoint metadata into the connector object", () => {
    const resolved = resolveSemanticConnectors([
      { type: "shape", id: "a", x: 1, y: 1, w: 1, h: 1 },
      { type: "shape", id: "b", x: 4, y: 1, w: 1, h: 1 },
      { type: "line", role: "connector", id: "legacy", x: 0, y: 0, w: 1, h: 1, style: { sourceId: "a", targetId: "b", route: "straight", color: "#000000" } }
    ]);
    expect(resolved[2].connector).toEqual({ sourceId: "a", targetId: "b", sourceAnchor: "auto", targetAnchor: "auto", route: "straight" });
    expect(resolved[2].style).toEqual({ color: "#000000" });
  });
});
