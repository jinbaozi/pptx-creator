import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  computeFloorViolation,
  DEFAULT_EDITABILITY_FLOOR,
  OCR_CLEARANCE_TARGET,
  OCR_CONFIDENCE_FLOOR_DEFAULT
} from "../scripts/lib/consistency-report-writer.mjs";

const ROOT = resolve(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");

function loadMarkdown() {
  const path = resolve(ROOT, "references/calibration.md");
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

function loadCalibrationJson() {
  const path = resolve(ROOT, "examples/image-input/calibration/calibration.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("references/calibration.md artifact", () => {
  it("exists and contains a distribution table", () => {
    const md = loadMarkdown();
    expect(md).toBeTruthy();
    expect(md).toMatch(/\| Fixture.*\|/);
  });

  it("lists the calibration fixtures by name", () => {
    const md = loadMarkdown();
    expect(md).toMatch(/text-heavy\.png/);
    expect(md).toMatch(/calibration\/mixed\.png/);
    expect(md).toMatch(/calibration\/sparse\.png/);
  });

  it("declares the locked threshold and clearance target", () => {
    const md = loadMarkdown();
    expect(md).toMatch(/Threshold default:\*\* 0\.7/);
    expect(md).toMatch(/Clearance target:\*\* ≥ 90%/);
  });

  it("≥ 90% of fixture blocks clear the threshold", () => {
    const data = loadCalibrationJson();
    expect(data).toBeTruthy();
    expect(data.aggregate.clearance).toBeGreaterThanOrEqual(OCR_CLEARANCE_TARGET);
  });
});

describe("computeFloorViolation", () => {
  it("returns satisfied: true when actualLevel ≥ floor (HTML L4)", () => {
    const result = computeFloorViolation({ deck: {} }, { editabilityLevel: 4 }, { inputType: "html" });
    expect(result.satisfied).toBe(true);
    expect(result.floor).toBe(DEFAULT_EDITABILITY_FLOOR.html);
    expect(result.floorViolation.pipelineCausal).toEqual([]);
    expect(result.floorViolation.sourceCausal).toEqual([]);
  });

  it("returns satisfied: 'with-justification' for image input at L3 (image default L3 met)", () => {
    const result = computeFloorViolation({ deck: {} }, { editabilityLevel: 3 }, { inputType: "image" });
    expect(result.satisfied).toBe(true);
    expect(result.floor).toBe(DEFAULT_EDITABILITY_FLOOR.image);
  });

  it("classifies image input at L2 as source-causal (with-justification by default)", () => {
    const result = computeFloorViolation({ deck: {} }, { editabilityLevel: 2 }, { inputType: "image" });
    expect(result.satisfied).toBe("with-justification");
    expect(result.floorViolation.pipelineCausal).toEqual([]);
    expect(result.floorViolation.sourceCausal).toHaveLength(1);
    expect(result.floorViolation.sourceCausal[0].reason).toBe("source-caused-raster-fallback");
    expect(result.floorViolation.sourceCausal[0].recoverable).toBe(false);
  });

  it("classifies HTML input at L2 as pipeline-causal hard-fail", () => {
    const result = computeFloorViolation({ deck: {} }, { editabilityLevel: 2 }, { inputType: "html" });
    expect(result.satisfied).toBe(false);
    expect(result.floorViolation.pipelineCausal).toHaveLength(1);
    expect(result.floorViolation.pipelineCausal[0].reason).toBe("adapter-under-perform");
    expect(result.floorViolation.pipelineCausal[0].recoverable).toBe(true);
    expect(result.floorViolation.sourceCausal).toEqual([]);
  });

  it("manifest.deck.editabilityFloor can raise (but not lower) the default floor", () => {
    // manifest sets floor=5, HTML default is 4 → effective floor=5; L4 fails
    const raised = computeFloorViolation({ deck: { editabilityFloor: 5 } }, { editabilityLevel: 4 }, { inputType: "html" });
    expect(raised.floor).toBe(5);
    expect(raised.satisfied).toBe(false);
    expect(raised.floorViolation.pipelineCausal[0].gap).toBe(1);

    // manifest sets floor=2, image default is 3 → effective floor=3 (cannot lower)
    const lowered = computeFloorViolation({ deck: { editabilityFloor: 2 } }, { editabilityLevel: 3 }, { inputType: "image" });
    expect(lowered.floor).toBe(3);
    expect(lowered.satisfied).toBe(true);
  });

  it("--allow-source-floor-violation=false blocks source-causal as well", () => {
    const result = computeFloorViolation(
      { deck: {} },
      { editabilityLevel: 2 },
      { inputType: "image", allowSourceFloorViolation: false }
    );
    expect(result.satisfied).toBe(false);
    expect(result.floorViolation.sourceCausal).toHaveLength(1);
  });

  it("infers editabilityLevel from counters when not provided", () => {
    const result = computeFloorViolation(
      { deck: {} },
      { editabilityCounter: { text: 1, shape: 1, image: 0, table: 0, croppedAsset: 0 } },
      { inputType: "html" }
    );
    // counters describe L5 native, so floor=4 is met
    expect(result.level).toBe(5);
    expect(result.satisfied).toBe(true);
  });

  it("treats explicit sourceCausal flag as source-causal regardless of inputType", () => {
    const result = computeFloorViolation(
      { deck: {} },
      { editabilityLevel: 2, sourceCausal: true },
      { inputType: "html" }
    );
    expect(result.satisfied).toBe("with-justification");
    expect(result.floorViolation.sourceCausal).toHaveLength(1);
  });
});

describe("OCR confidence floor constants", () => {
  it("exports OCR_CONFIDENCE_FLOOR_DEFAULT = 0.7", () => {
    expect(OCR_CONFIDENCE_FLOOR_DEFAULT).toBe(0.7);
  });

  it("exports OCR_CLEARANCE_TARGET = 0.9", () => {
    expect(OCR_CLEARANCE_TARGET).toBe(0.9);
  });
});