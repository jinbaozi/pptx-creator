import { describe, expect, it } from "vitest";
import {
  adaptImageDesignTokens,
  runV2CompositionTests
} from "../scripts/run-v2-composition-tests.mjs";

const integrationIt = process.env.V2_COMPOSITION_RUN === "1" ? it : it.skip;

describe("V2 explicit Skill composition", () => {
  it("adapts image design tokens without importing reference-image facts", () => {
    const result = adaptImageDesignTokens({
      version: "1.0.0",
      colors: {
        background: "#F5F7FB",
        primary: "#FFFFFF",
        palette: ["#F5F7FB", "#FFFFFF", "#102A43", "#EEF1F5", "#8899AD"]
      },
      typography: {
        primary: "Arial",
        fallbacks: ["Liberation Sans", "Noto Sans"]
      },
      page: {
        widthPx: 1280,
        heightPx: 720
      }
    });

    expect(result).toMatchObject({
      protocol: "pptx-creator.design-token-adaptation",
      version: "1.0.0",
      target: {
        consumer: "text-to-html",
        field: "$.designIntent.tokenOverrides"
      },
      factsImported: false
    });
    expect(result.tokenOverrides.colors).toMatchObject({
      background: "#F5F7FB",
      surface: "#FFFFFF",
      text: "#102A43",
      muted: "#102A43",
      primary: "#102A43"
    });
    expect(result.tokenOverrides.fonts.body).toContain("\"Liberation Sans\"");
  });

  it("fails closed when reference page dimensions are not protocol-compatible", () => {
    expect(() => adaptImageDesignTokens({
      colors: {
        background: "#FFFFFF",
        primary: "#000000",
        palette: ["#FFFFFF", "#000000"]
      },
      page: {
        widthPx: 1920,
        heightPx: 1080
      }
    })).toThrowError(expect.objectContaining({
      name: "V2CompositionError",
      code: "E_TOKEN_PAGE_SIZE"
    }));
  });

  integrationIt(
    "runs all five chains in temporary directories with blocking visual and editability gates",
    async () => {
      const keepArtifacts = process.env.V2_COMPOSITION_KEEP === "1";
      const report = await runV2CompositionTests({
        keepArtifacts,
        browserTimeoutMs: 90_000,
        processTimeoutMs: 15 * 60 * 1000
      });

      expect(report.status).toBe("passed");
      expect(report.gate).toBe("v2-explicit-composition");
      expect(report.chainCount).toBe(5);
      expect(report.chains.map((chain) => chain.id)).toEqual([
        "text-to-html-to-pptx",
        "image-to-pptx-independent",
        "image-html-to-pptx",
        "reference-style-to-text-to-html-to-pptx",
        "incompatible-protocol-rejection"
      ]);
      expect(report.chains.every((chain) => chain.status === "passed")).toBe(true);
      expect(report.implicitSiblingInvocation).toBe(false);
      expect(report.cleaned).toBe(!keepArtifacts);
      expect(report.chains[1].evidence.image.editabilityLevel).toBeGreaterThanOrEqual(3);
      expect(report.chains[1].evidence.image.wholeSlideRasterCount).toBe(0);
      expect(report.chains[4].evidence).toMatchObject({
        consumerCode: "E_PROTOCOL_VERSION",
        canonicalValidatorCode: "E_PROTOCOL_VERSION",
        finalPptxPublished: false
      });
    },
    20 * 60 * 1000
  );
});
