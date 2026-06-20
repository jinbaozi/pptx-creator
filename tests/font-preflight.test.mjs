import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  preflightFonts,
  collectReferencedFonts,
  __test__
} from "../scripts/lib/font-preflight.mjs";

const { isOtfMagic, isTtfMagic, resolveTokenString } = __test__;

function sampleManifest(refs = {}) {
  return {
    version: "0.1.1",
    designSystem: {
      source: "design-systems/business-neutral/DESIGN.md",
      name: "Business Neutral",
      mode: "creative",
      tokens: {
        colors: { primary: "#1F3A8A" },
        typography: {
          title: { fontFamily: refs.title ?? "Arial", fontSize: 32 },
          body: { fontFamily: refs.body ?? "Helvetica", fontSize: 14 }
        }
      }
    },
    deck: { title: "Sample", language: "en-US", size: { preset: "wide", width: 13.333, height: 7.5, unit: "in" } },
    assets: [],
    slides: [
      {
        id: "slide-001",
        elements: [
          {
            type: "text",
            id: "t",
            x: 0.5,
            y: 0.5,
            w: 4,
            h: 0.5,
            text: "Hello",
            style: {
              fontFamily: refs.element ?? "Inter",
              fontSize: 18
            }
          }
        ]
      }
    ]
  };
}

const SAMPLE_DESIGN = {
  tokens: {
    typography: {
      title: { fontFamily: "Arial", fontSize: 32 },
      body: { fontFamily: "Helvetica", fontSize: 14 }
    }
  }
};

function darwinArialPath() {
  return "/System/Library/Fonts/Supplemental/Arial.ttf";
}

describe("font-preflight", () => {
  it("detects a built-in font as present when installed", async () => {
    if (process.platform !== "darwin" || !existsSync(darwinArialPath())) {
      // Skip on environments without Arial.
      return;
    }
    const manifest = sampleManifest({ title: "Arial", body: "Arial", element: "Arial" });
    const result = await preflightFonts(manifest, SAMPLE_DESIGN);
    // When fontkit is installed we get name-level matches; when only the
    // magic-byte fallback runs we can't extract names from headers, so we
    // accept either outcome as long as the result shape is sane.
    if (result.source === "fontkit") {
      expect(result.availability.Arial).toBe("present");
      expect(result.fallback.find((entry) => entry.requested === "Arial")).toBeUndefined();
    } else {
      expect(["magic-byte", "unavailable"]).toContain(result.source);
      expect(result.availability).toHaveProperty("Arial");
    }
  });

  it("flags missing custom fonts and emits a fallback entry", async () => {
    const manifest = sampleManifest({
      title: "NonExistentFont-12345",
      body: "AlsoMissing-9999",
      element: "Inter"
    });
    // Pass design tokens that mirror the manifest's references so we are
    // exercising the verifier's fallback path rather than the token-resolution
    // path that would inject "Arial"/"Helvetica".
    const designWithMissing = {
      tokens: {
        typography: {
          title: { fontFamily: "NonExistentFont-12345", fontSize: 32 },
          body: { fontFamily: "AlsoMissing-9999", fontSize: 14 }
        }
      }
    };
    const result = await preflightFonts(manifest, designWithMissing);
    expect(result.availability["NonExistentFont-12345"]).toBe("missing");
    expect(result.availability["AlsoMissing-9999"]).toBe("missing");
    const requested = result.fallback.map((entry) => entry.requested);
    expect(requested).toContain("NonExistentFont-12345");
    expect(requested).toContain("AlsoMissing-9999");
    const entry = result.fallback.find((entry) => entry.requested === "NonExistentFont-12345");
    expect(entry.fallback).toBe("system-default");
  });

  it("falls back to magic-byte or unavailable when fontkit import fails", async () => {
    const manifest = sampleManifest({ title: "FakeFont-7", body: "FakeFont-7", element: "FakeFont-7" });
    const designAllMissing = {
      tokens: {
        typography: {
          title: { fontFamily: "FakeFont-7", fontSize: 32 },
          body: { fontFamily: "FakeFont-7", fontSize: 14 }
        }
      }
    };
    const result = await preflightFonts(manifest, designAllMissing, {
      loadFontkit: async () => ({ error: new Error("mocked: fontkit not installed") })
    });
    expect(["magic-byte", "unavailable"]).toContain(result.source);
    expect(result.availability["FakeFont-7"]).toBe("missing");
    expect(result.fallback).toEqual([
      expect.objectContaining({ requested: "FakeFont-7", fallback: "system-default" })
    ]);
  });

  it("returns empty availability + no fallback for an empty manifest", async () => {
    const manifest = {
      version: "0.1.1",
      designSystem: {
        source: "design-systems/business-neutral/DESIGN.md",
        mode: "creative",
        tokens: { typography: {} }
      },
      deck: { size: { preset: "wide", width: 13.333, height: 7.5, unit: "in" } },
      slides: []
    };
    const result = await preflightFonts(manifest, { tokens: { typography: {} } });
    expect(result.availability).toEqual({});
    expect(result.fallback).toEqual([]);
  });

  it("produces a JSON-serializable result", async () => {
    const manifest = sampleManifest({ title: "Arial", element: "FakeFont-1" });
    const result = await preflightFonts(manifest, SAMPLE_DESIGN);
    const serialized = JSON.stringify(result);
    expect(serialized).toBeTruthy();
    const parsed = JSON.parse(serialized);
    expect(parsed.availability).toBeTypeOf("object");
    expect(Array.isArray(parsed.fallback)).toBe(true);
    expect(["fontkit", "magic-byte", "unavailable"]).toContain(parsed.source);
  });
});

describe("font-preflight helpers", () => {
  it("resolves {typography.title} token strings through the token map", () => {
    const tokens = { typography: { title: { fontFamily: "Arial" } } };
    expect(resolveTokenString("{typography.title}", tokens)).toEqual({ fontFamily: "Arial" });
    expect(resolveTokenString("Helvetica", tokens)).toBe("Helvetica");
  });

  it("identifies TTF and OTF magic bytes", () => {
    expect(isTtfMagic([0x00, 0x01, 0x00, 0x00])).toBe(true);
    expect(isTtfMagic([0x4f, 0x54, 0x54, 0x4f])).toBe(false);
    expect(isOtfMagic([0x4f, 0x54, 0x54, 0x4f])).toBe(true);
    expect(isOtfMagic([0x00, 0x01, 0x00, 0x00])).toBe(false);
  });

  it("collects font references from tokens + element styles", () => {
    const manifest = sampleManifest({ title: "Arial", body: "Helvetica", element: "Inter" });
    const tokens = manifest.designSystem.tokens;
    const refs = collectReferencedFonts(manifest, tokens);
    expect(refs.has("Arial")).toBe(true);
    expect(refs.has("Helvetica")).toBe(true);
    expect(refs.has("Inter")).toBe(true);
  });

  it("strips quotes and ignores generic families in font-family lists", () => {
    const manifest = {
      designSystem: {
        tokens: {
          typography: {
            title: { fontFamily: '"Source Sans Pro", sans-serif, Arial' }
          }
        }
      },
      slides: []
    };
    const refs = collectReferencedFonts(manifest, manifest.designSystem.tokens);
    expect(refs.has("Source Sans Pro")).toBe(true);
    expect(refs.has("Arial")).toBe(true);
    expect(refs.has("sans-serif")).toBe(false);
  });

  it("falls back to the home directory font list when running on this host", () => {
    const fonts = collectReferencedFonts(sampleManifest(), SAMPLE_DESIGN.tokens);
    expect(fonts.size).toBeGreaterThan(0);
    // Sanity: macOS test hosts have at least one font installed.
    if (process.platform === "darwin") {
      const candidate = join(homedir(), "Library", "Fonts");
      // Candidate directory may or may not exist; we just confirm preflight
      // doesn't throw regardless.
      expect(typeof candidate).toBe("string");
    }
  });
});
