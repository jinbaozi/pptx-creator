import { describe, expect, it } from "vitest";
import { editableLevel } from "../scripts/render-pptx.mjs";

describe("editableLevel", () => {
  it("returns Level 5 for fully native slides without raster images", () => {
    expect(editableLevel({ text: 2, shape: 1, image: 0, table: 0 })).toBe(5);
    expect(editableLevel({ text: 1, shape: 0, image: 0, table: 1 })).toBe(5);
  });

  it("returns Level 4 when native text and shapes coexist with raster assets", () => {
    expect(editableLevel({ text: 1, shape: 1, image: 1, table: 0 })).toBe(4);
    expect(editableLevel({ text: 2, shape: 0, image: 1, table: 1 })).toBe(4);
  });

  it("returns Level 3 when text is native but visuals are mostly rasterized", () => {
    expect(editableLevel({ text: 1, shape: 0, image: 2, table: 0 })).toBe(3);
  });

  it("returns Level 1 for raster fallback slides without editable text", () => {
    expect(editableLevel({ text: 0, shape: 0, image: 1, table: 0 })).toBe(1);
  });

  it("returns Level 2 for shape-only slides", () => {
    expect(editableLevel({ text: 0, shape: 2, image: 0, table: 0 })).toBe(2);
  });

  // cropped-asset is image-class for editability purposes.
  it("treats cropped-asset as image-class for Level 1 (raster fallback)", () => {
    expect(editableLevel({ text: 0, shape: 0, image: 0, table: 0, croppedAsset: 1 })).toBe(1);
  });

  it("treats cropped-asset as image-class for Level 3 (text + image-class, no shapes/tables)", () => {
    expect(editableLevel({ text: 1, shape: 0, image: 0, table: 0, croppedAsset: 1 })).toBe(3);
  });

  it("treats cropped-asset as image-class for Level 4 (text + image-class + shape)", () => {
    expect(editableLevel({ text: 1, shape: 1, image: 0, table: 0, croppedAsset: 1 })).toBe(4);
  });

  it("treats cropped-asset as image-class for Level 4 with table", () => {
    expect(editableLevel({ text: 2, shape: 0, image: 0, table: 1, croppedAsset: 1 })).toBe(4);
  });

  it("Level 5 still requires no image-class (no image, no croppedAsset)", () => {
    expect(editableLevel({ text: 2, shape: 1, image: 0, table: 0, croppedAsset: 0 })).toBe(5);
  });

  it("scenarios without croppedAsset remain unchanged", () => {
    expect(editableLevel({ text: 2, shape: 1, image: 0, table: 0 })).toBe(5);
    expect(editableLevel({ text: 1, shape: 1, image: 1, table: 0 })).toBe(4);
    expect(editableLevel({ text: 1, shape: 0, image: 2, table: 0 })).toBe(3);
    expect(editableLevel({ text: 0, shape: 0, image: 1, table: 0 })).toBe(1);
    expect(editableLevel({ text: 0, shape: 2, image: 0, table: 0 })).toBe(2);
  });
});
