import { describe, expect, it } from "vitest";
import { generatePreviewArtifacts } from "../scripts/lib/preview-artifact-generator.mjs";

describe("preview artifact generator", () => {
  it("generates static HTML, CSS, React, and data artifacts", () => {
    const artifacts = generatePreviewArtifacts({
      uiSpec: {
        version: "1.0",
        slides: [{ id: "s1", layoutPattern: "hero", regions: [{ id: "title", role: "headline", priority: 1 }] }]
      },
      componentSpecs: {
        version: "1.0",
        slides: [{ id: "s1", components: [{ id: "c1", type: "textBlock", editability: "native", region: "title" }] }]
      },
      designTokens: {
        version: "1.0",
        color: { background: "#FFFFFF", text: "#111827", primary: "#155EEF" },
        typography: { heading: "Aptos Display", body: "Aptos" },
        spacing: { slidePadding: 48 }
      }
    });

    expect(artifacts.files["index.html"]).toContain("slides-root");
    expect(artifacts.files["styles.css"]).toContain("--color-primary");
    expect(artifacts.files["components.jsx"]).toContain("function Slide");
    expect(artifacts.files["data.jsx"]).toContain("slides");
  });
});
