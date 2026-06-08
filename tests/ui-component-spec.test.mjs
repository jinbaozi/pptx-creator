import { describe, expect, it } from "vitest";
import { compileUiSpec } from "../scripts/lib/ui-spec-compiler.mjs";
import { compileComponentSpecs } from "../scripts/lib/component-spec-compiler.mjs";

describe("UI and component spec compilers", () => {
  it("creates semantic layout specs from storyboard slides", () => {
    const uiSpec = compileUiSpec({
      storyboard: {
        slides: [
          { id: "s1", title: "Cover", slideRole: "cover", visualIntent: "bold roadshow opening" },
          { id: "s2", title: "Architecture", slideRole: "architecture", visualIntent: "layered compiler pipeline" }
        ]
      },
      designDirection: {
        palette: { primary: "#155EEF", accent: "#F97316" }
      }
    });

    expect(uiSpec.slides).toHaveLength(2);
    expect(uiSpec.slides[0].layoutPattern).toBe("hero");
    expect(uiSpec.slides[1].layoutPattern).toBe("architecture-layered");
  });

  it("creates editable component specs from UI specs", () => {
    const components = compileComponentSpecs({
      uiSpec: {
        version: "1.0",
        slides: [
          {
            id: "s1",
            layoutPattern: "hero",
            regions: [{ id: "title", role: "headline", priority: 1 }]
          }
        ]
      }
    });

    expect(components.slides[0].components[0].type).toBe("textBlock");
    expect(components.slides[0].components[0].editability).toBe("native");
  });
});
