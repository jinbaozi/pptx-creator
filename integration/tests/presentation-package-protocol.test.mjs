import { describe, expect, it } from "vitest";
import { validatePresentationPackage } from "../scripts/validate-presentation-package.mjs";

function fixture() {
  return {
    protocol: "pptx-creator.presentation-package",
    version: "1.0.0",
    kind: "html-presentation",
    producer: { skill: "text-to-html", version: "2.0.0" },
    entrypoint: "index.html",
    deck: {
      id: "deck-001",
      title: "Verified deck",
      language: "zh-CN",
      size: { width: 1280, height: 720, unit: "px" },
      slides: [{
        id: "slide-001",
        order: 1,
        title: "结论先行",
        coreMessage: "一页只表达一个核心观点。",
        notes: "说明来源和假设。",
        sourceRefs: ["source-001"],
        components: [{
          id: "title-001",
          type: "text",
          box: { x: 64, y: 60, w: 960, h: 72, unit: "px" },
          z: 10,
          editableIntent: true,
          sourceRefs: ["source-001"],
          confidence: 1
        }]
      }]
    },
    designTokens: "design-tokens.json",
    assets: [],
    sources: [{
      id: "source-001",
      kind: "user-input",
      label: "User brief",
      factStatus: "provided"
    }],
    validation: { status: "passed", reports: ["qa-report.json"] },
    degradations: [],
    compatibility: { minReaderVersion: "1.0.0", features: ["speaker-notes"] }
  };
}

describe("presentation-package protocol 1.0.0", () => {
  it("accepts a self-contained HTML presentation package", () => {
    expect(validatePresentationPackage(fixture())).toMatchObject({
      version: "1.0.0",
      producer: "text-to-html",
      slideCount: 1,
      componentCount: 1,
      validationStatus: "passed"
    });
  });

  it("fails closed on an unsupported version", () => {
    const value = fixture();
    value.version = "2.0.0";
    expect(() => validatePresentationPackage(value)).toThrow(/unsupported presentation-package version/);
    try {
      validatePresentationPackage(value);
    } catch (error) {
      expect(error.code).toBe("E_PROTOCOL_VERSION");
    }
  });

  it("rejects paths that escape the package root", () => {
    const value = fixture();
    value.entrypoint = "../index.html";
    expect(() => validatePresentationPackage(value)).toThrow(/escape the package root/);
  });

  it.each([
    ["Windows traversal", "..\\outside\\index.html"],
    ["Windows drive", "C:\\slides\\index.html"],
    ["Windows drive-relative", "C:index.html"],
    ["Windows drive-relative traversal", "C:..\\outside\\index.html"],
    ["UNC path", "\\\\server\\share\\index.html"],
    ["POSIX absolute", "/slides/index.html"]
  ])("rejects %s paths on every host", (_label, entrypoint) => {
    const value = fixture();
    value.entrypoint = entrypoint;
    try {
      validatePresentationPackage(value);
      throw new Error("expected protocol validation to fail");
    } catch (error) {
      expect(error.code).toBe("E_PROTOCOL_PATH");
    }
  });

  it("rejects dangling source references", () => {
    const value = fixture();
    value.deck.slides[0].components[0].sourceRefs = ["missing-source"];
    expect(() => validatePresentationPackage(value)).toThrow(/unknown source ref missing-source/);
  });

  it("rejects duplicate page order", () => {
    const value = fixture();
    value.deck.slides.push({
      ...structuredClone(value.deck.slides[0]),
      id: "slide-002"
    });
    expect(() => validatePresentationPackage(value)).toThrow(/duplicate value 1/);
  });

  it.each([
    ["source kind", (value) => { value.sources[0].kind = "model-memory"; }, "E_PROTOCOL_SOURCE"],
    ["component type", (value) => { value.deck.slides[0].components[0].type = "video"; }, "E_PROTOCOL_COMPONENT"],
    ["asset rights", (value) => {
      value.assets.push({ id: "asset-001", path: "assets/a.png", mime: "image/png", rights: "borrowed" });
    }, "E_PROTOCOL_ASSET"],
    ["degradation id", (value) => {
      value.degradations.push({
        slideId: "slide-001",
        reason: "unsupported filter",
        editabilityImpact: "partial"
      });
    }, "E_PROTOCOL_DEGRADATION"]
  ])("rejects schema-invalid %s values", (_label, mutate, expectedCode) => {
    const value = fixture();
    mutate(value);
    try {
      validatePresentationPackage(value);
      throw new Error("expected protocol validation to fail");
    } catch (error) {
      expect(error.code).toBe(expectedCode);
    }
  });

  it("rejects schema drift such as extra fields and numeric strings", () => {
    const extra = fixture();
    extra.deck.unexpected = true;
    expect(() => validatePresentationPackage(extra)).toThrow(/additional properties/);

    const numericString = fixture();
    numericString.deck.size.width = "1280";
    expect(() => validatePresentationPackage(numericString)).toThrow(/must be number/);
  });

  it("requires an HTML entrypoint, validation evidence, and a valid producer-kind pair", () => {
    const missingEntrypoint = fixture();
    delete missingEntrypoint.entrypoint;
    try {
      validatePresentationPackage(missingEntrypoint);
      throw new Error("expected protocol validation to fail");
    } catch (error) {
      expect(error.code).toBe("E_PROTOCOL_ENTRYPOINT");
    }

    const missingEvidence = fixture();
    missingEvidence.validation.reports = [];
    try {
      validatePresentationPackage(missingEvidence);
      throw new Error("expected protocol validation to fail");
    } catch (error) {
      expect(error.code).toBe("E_PROTOCOL_VALIDATION");
    }

    const wrongKind = fixture();
    wrongKind.kind = "pptx-delivery";
    try {
      validatePresentationPackage(wrongKind);
      throw new Error("expected protocol validation to fail");
    } catch (error) {
      expect(error.code).toBe("E_PROTOCOL_PRODUCER");
    }
  });

  it("rejects a degradation that points at a component on another slide", () => {
    const value = fixture();
    value.deck.slides.push({
      id: "slide-002",
      order: 2,
      title: "第二页",
      sourceRefs: ["source-001"],
      components: [{
        id: "title-002",
        type: "text",
        box: { x: 64, y: 60, w: 960, h: 72, unit: "px" },
        z: 10,
        editableIntent: true,
        sourceRefs: ["source-001"]
      }]
    });
    value.degradations.push({
      id: "degradation-001",
      slideId: "slide-001",
      componentId: "title-002",
      reason: "unsupported filter",
      editabilityImpact: "partial"
    });
    expect(() => validatePresentationPackage(value)).toThrow(/unknown component title-002 on slide slide-001/);
  });
});
