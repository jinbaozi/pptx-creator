import { describe, expect, it } from "vitest";
import { compileDesignFirstManifest } from "../scripts/lib/manifest-compiler.mjs";
import { loadDesignFirstArtifacts } from "../scripts/lib/design-first-loader.mjs";
import { compileUiSpec } from "../scripts/lib/ui-spec-compiler.mjs";
import { compileComponentSpecs } from "../scripts/lib/component-spec-compiler.mjs";
import { expandDiagramElement } from "../scripts/lib/diagram-compiler.mjs";

function buildArtifactsWithArchitectureHint() {
  const artifacts = loadDesignFirstArtifacts("examples/design-first/compiler-roadshow");
  const uiSpec = compileUiSpec({ storyboard: artifacts.storyboard, designDirection: artifacts.designDirection });
  const componentSpecs = compileComponentSpecs({ uiSpec });
  const archIndex = uiSpec.slides.findIndex((s) => s.id === "slide-003");
  if (archIndex >= 0) {
    uiSpec.slides[archIndex] = {
      ...uiSpec.slides[archIndex],
      layoutPattern: "architecture-layered",
      regions: [
        { id: "diagram", role: "diagram", priority: 1 },
        { id: "headline", role: "headline", priority: 2 }
      ]
    };
  }
  const compIndex = componentSpecs.slides.findIndex((s) => s.id === "slide-003");
  if (compIndex >= 0) {
    componentSpecs.slides[compIndex] = {
      id: "slide-003",
      layoutPattern: "architecture-layered",
      components: [
        { id: "slide-003-diagram", type: "semanticDiagram", editability: "native", region: "diagram", role: "diagram" },
        { id: "slide-003-headline", type: "textBlock", editability: "native", region: "headline", role: "headline" }
      ]
    };
  }
  return { artifacts, uiSpec, componentSpecs };
}

describe("artifact-aware manifest compiler", () => {
  it("uses uiSpec layoutPattern to choose architecture archetype with diagram elements", () => {
    const { artifacts, uiSpec, componentSpecs } = buildArtifactsWithArchitectureHint();

    const manifest = compileDesignFirstManifest(artifacts, {
      uiSpec,
      componentSpecs
    });

    const archSlide = manifest.slides.find((slide) => {
      const spec = uiSpec.slides.find((s) => s.id === slide.id);
      return spec && spec.layoutPattern === "architecture-layered";
    });
    expect(archSlide).toBeTruthy();

    const types = new Set(archSlide.elements.map((el) => el.type));
    expect(types.has("text")).toBe(true);
    expect(types.has("line")).toBe(false);

    const semanticDiagram = archSlide.elements.find(
      (el) => el.type === "diagram" && el.kind === "layeredArchitecture"
    );
    expect(semanticDiagram).toBeTruthy();

    const expanded = expandDiagramElement(semanticDiagram);
    const arrowLine = expanded.find((el) => el.type === "line" && el.style?.endArrowType);
    expect(arrowLine).toBeTruthy();
    expect(arrowLine.style.sourceId).toBeTruthy();
    expect(arrowLine.style.targetId).toBeTruthy();
  });

  it("preserves generic compilation when uiSpec and componentSpecs are omitted", () => {
    const artifacts = loadDesignFirstArtifacts("examples/design-first/compiler-roadshow");
    const manifest = compileDesignFirstManifest(artifacts, {
      designSystemSource: "design-systems/product-roadshow/DESIGN.md",
      designSystemName: "Product Roadshow"
    });
    expect(manifest.slides.length).toBe(3);
    expect(manifest.slides[0].elements.some((el) => el.type === "text")).toBe(true);
  });
});
