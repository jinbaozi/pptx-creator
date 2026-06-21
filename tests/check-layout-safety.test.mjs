import { describe, expect, it } from "vitest";
import {
  preflightLayout,
  checkBounds,
  checkFontSize,
  inferRole,
  __test__
} from "../scripts/lib/check-layout-safety.mjs";

const DECK = { width: 13.333, height: 7.5 };

function makeManifest(slides, designTokens = {}) {
  return {
    version: "0.1.1",
    designSystem: { source: "design-systems/business-neutral/DESIGN.md", name: "Business Neutral", mode: "creative", tokens: designTokens },
    deck: { title: "Sample", language: "en-US", size: { preset: "wide", width: 13.333, height: 7.5, unit: "in" } },
    assets: [],
    slides
  };
}

function textSlide(element, extras = {}) {
  return {
    id: extras.id ?? "s1",
    background: extras.background ?? { type: "solid", color: "#FFFFFF" },
    elements: [element]
  };
}

describe("check-layout-safety", () => {
  describe("(1) bounds", () => {
    it("returns critical bounds issue when x+w > deckSize.width", () => {
      const manifest = makeManifest([
        textSlide({ type: "text", id: "overflow", x: 12.9, y: 0.5, w: 1.0, h: 0.5, text: "X", style: { fontSize: 16 } })
      ]);
      const result = preflightLayout(manifest);
      const bounds = result.checks.find((c) => c.type === "bounds");
      expect(bounds).toBeTruthy();
      expect(bounds.severity).toBe("critical");
      expect(bounds.target).toBe("overflow");
      expect(result.summary.criticalCount).toBeGreaterThanOrEqual(1);
    });

    it("tolerates floating-point overshoot ≤ 0.005in", () => {
      const overflow = checkBounds({ id: "x", x: 13.33, y: 0, w: 0.005, h: 0.5 }, DECK);
      expect(overflow).toBeNull();
    });

    it("emits bounds only for genuine overflow", () => {
      const ok = checkBounds({ id: "x", x: 0.5, y: 0.5, w: 4, h: 1 }, DECK);
      expect(ok).toBeNull();
    });
  });

  describe("(3) role-aware font-size", () => {
    it("flags fontSize 8 on a body element as critical", () => {
      const manifest = makeManifest([
        textSlide({ type: "text", id: "body-tiny", x: 0.5, y: 0.5, w: 4, h: 0.5, text: "Hi", style: { fontSize: 8 } })
      ]);
      const result = preflightLayout(manifest);
      const issue = result.checks.find((c) => c.type === "font-size");
      expect(issue).toBeTruthy();
      expect(issue.severity).toBe("critical");
    });

    it("flags fontSize 14 on a title element as critical", () => {
      const manifest = makeManifest([
        textSlide({ type: "text", id: "title-small", x: 0.5, y: 0.5, w: 4, h: 0.5, text: "Hi", style: { fontSize: 14, role: "title" } })
      ]);
      const result = preflightLayout(manifest);
      const issue = result.checks.find((c) => c.type === "font-size");
      expect(issue).toBeTruthy();
      expect(issue.severity).toBe("critical");
    });

    it("infers title role from id pattern 'hero-title'", () => {
      expect(inferRole({ id: "hero-title", style: {} })).toBe("title");
      expect(inferRole({ id: "kpi-1", style: {} })).toBe("metric");
      expect(inferRole({ id: "footnote-x", style: {} })).toBe("caption");
    });

    it("infers title role from typography token {typography.title}", () => {
      const tokens = { typography: { title: { fontSize: 32, color: "#000" } } };
      expect(inferRole({ id: "x", style: { typography: "{typography.title}" } }, tokens)).toBe("title");
    });

    it("emits warning (not critical) when fontSize is 10 for body role", () => {
      const manifest = makeManifest([
        textSlide({ type: "text", id: "body-10", x: 0.5, y: 0.5, w: 4, h: 0.5, text: "Hi", style: { fontSize: 10 } })
      ]);
      const result = preflightLayout(manifest);
      const issue = result.checks.find((c) => c.type === "font-size");
      expect(issue).toBeTruthy();
      expect(issue.severity).toBe("warning");
    });

    it("does not flag body fontSize 11 (passes per spec)", () => {
      const manifest = makeManifest([
        textSlide({ type: "text", id: "body-11", x: 0.5, y: 0.5, w: 4, h: 0.5, text: "Hi", style: { fontSize: 11 } })
      ]);
      const result = preflightLayout(manifest);
      expect(result.checks.find((c) => c.type === "font-size")).toBeUndefined();
    });

    it("emits warning for metric role 28pt (< 32)", () => {
      const manifest = makeManifest([
        textSlide({ type: "text", id: "metric-mid", x: 0.5, y: 0.5, w: 4, h: 0.5, text: "73", style: { fontSize: 28, role: "metric" } })
      ]);
      const result = preflightLayout(manifest);
      const issue = result.checks.find((c) => c.type === "font-size");
      expect(issue).toBeTruthy();
      expect(issue.severity).toBe("warning");
    });
  });

  describe("(4) role-aware line-height", () => {
    it("flags body lineHeight 0.9 as critical (below 1.0)", () => {
      const manifest = makeManifest([
        textSlide({ type: "text", id: "body-tight", x: 0.5, y: 0.5, w: 4, h: 2, text: "Hi", style: { fontSize: 12, lineHeight: 0.9 } })
      ]);
      const result = preflightLayout(manifest);
      const issue = result.checks.find((c) => c.type === "line-height-too-tight");
      expect(issue).toBeTruthy();
      expect(issue.severity).toBe("critical");
    });

    it("flags title lineHeight 1.0 as warning (below 1.10)", () => {
      const manifest = makeManifest([
        textSlide({ type: "text", id: "title-tight", x: 0.5, y: 0.5, w: 4, h: 2, text: "Hi", style: { fontSize: 32, lineHeight: 1.0, role: "title" } })
      ]);
      const result = preflightLayout(manifest);
      const issue = result.checks.find((c) => c.type === "line-height-too-tight");
      expect(issue).toBeTruthy();
      expect(issue.severity).toBe("warning");
    });
  });

  describe("(5) text-overflow heuristic", () => {
    it("blocks when CJK long string dwarfs the textbox", () => {
      const longText = "中".repeat(400);
      const manifest = makeManifest([
        textSlide({ type: "text", id: "cjk-overflow", x: 0.5, y: 0.5, w: 1, h: 0.3, text: longText, style: { fontSize: 16 } })
      ]);
      const result = preflightLayout(manifest);
      const issue = result.checks.find((c) => c.type === "text-overflow");
      expect(issue).toBeTruthy();
      expect(issue.severity).toBe("critical");
    });

    it("does not flag short Latin text in a wide box", () => {
      const manifest = makeManifest([
        textSlide({ type: "text", id: "ok-text", x: 0.5, y: 0.5, w: 10, h: 2, text: "Hello world", style: { fontSize: 16 } })
      ]);
      const result = preflightLayout(manifest);
      const issue = result.checks.find((c) => c.type === "text-overflow");
      expect(issue).toBeUndefined();
    });
  });

  describe("(6) card-spacing", () => {
    it("warns when two content-cards are closer than spacing.md", () => {
      const tokens = { spacing: { md: 1 } };
      const manifest = makeManifest(
        [
          {
            id: "s1",
            background: { type: "solid", color: "#FFFFFF" },
            elements: [
              { type: "shape", id: "card-a", x: 0.5, y: 0.5, w: 2, h: 2, shape: "rect" },
              { type: "shape", id: "card-b", x: 3.0, y: 0.5, w: 2, h: 2, shape: "rect" }
            ]
          }
        ],
        tokens
      );
      const result = preflightLayout(manifest, { designTokens: tokens });
      const issue = result.checks.find((c) => c.type === "card-spacing-tight");
      expect(issue).toBeTruthy();
      expect(issue.severity).toBe("warning");
      expect(issue.target).toBe("card-a");
      expect(issue.relatedTarget).toBe("card-b");
    });
  });

  describe("(7) contrast", () => {
    it("flags body text on background with 3.5:1 as critical", () => {
      const manifest = makeManifest([
        {
          id: "s1",
          background: { type: "solid", color: "#888888" },
          elements: [
            // #888 on #888 → 1:1; build a 3.5:1 case: foreground #aaa on #fff
            { type: "text", id: "body-fg", x: 0.5, y: 0.5, w: 4, h: 0.5, text: "x", style: { fontSize: 12, color: "#A6A6A6" } }
          ]
        }
      ]);
      // Compute exact ratio using the helper to choose a guaranteed-<4.5 fg.
      const ratio = __test__.contrastRatio(__test__.hexToRgb("#A6A6A6"), __test__.hexToRgb("#FFFFFF"));
      expect(ratio).toBeLessThan(4.5);
      const result = preflightLayout(manifest);
      const issue = result.checks.find((c) => c.type === "contrast-fail");
      expect(issue).toBeTruthy();
      expect(issue.severity).toBe("critical");
    });

    it("emits warning for body text at ~3.5:1 (between 3.0 and 4.5)", () => {
      // #8e8e8e on #ffffff → ~3.46:1 (above 3.0 floor, below 4.5 critical).
      const fg = "#8E8E8E";
      const manifest = makeManifest([
        {
          id: "s1",
          background: { type: "solid", color: "#FFFFFF" },
          elements: [{ type: "text", id: "warn-fg", x: 0.5, y: 0.5, w: 4, h: 0.5, text: "x", style: { fontSize: 12, color: fg } }]
        }
      ]);
      const ratio = __test__.contrastRatio(__test__.hexToRgb(fg), __test__.hexToRgb("#FFFFFF"));
      expect(ratio).toBeGreaterThanOrEqual(3.0);
      expect(ratio).toBeLessThan(4.5);
      const result = preflightLayout(manifest);
      const issue = result.checks.find((c) => c.type === "contrast-fail");
      expect(issue).toBeTruthy();
      expect(issue.severity).toBe("warning");
    });
  });

  describe("(8) letter-spacing", () => {
    it("warns on CJK body letter-spacing -0.05em", () => {
      const longText = "中文".repeat(20);
      const manifest = makeManifest([
        textSlide({
          type: "text",
          id: "cjk-tight",
          x: 0.5,
          y: 0.5,
          w: 4,
          h: 1,
          text: longText,
          style: { fontSize: 14, letterSpacing: -0.05 }
        })
      ]);
      const result = preflightLayout(manifest);
      const issue = result.checks.find((c) => c.type === "letter-spacing-too-tight");
      expect(issue).toBeTruthy();
      expect(issue.severity).toBe("warning");
    });

    it("does not flag Latin body at -0.005em (above -0.01 threshold)", () => {
      const manifest = makeManifest([
        textSlide({
          type: "text",
          id: "latin-tight",
          x: 0.5,
          y: 0.5,
          w: 4,
          h: 1,
          text: "Hello world",
          style: { fontSize: 14, letterSpacing: -0.005 }
        })
      ]);
      const result = preflightLayout(manifest);
      const issue = result.checks.find((c) => c.type === "letter-spacing-too-tight");
      expect(issue).toBeUndefined();
    });
  });

  describe("(2) overlap", () => {
    it("flags critical overlap when > 5% of smaller area", () => {
      const manifest = makeManifest([
        {
          id: "s1",
          background: { type: "solid", color: "#FFFFFF" },
          elements: [
            { type: "text", id: "a", x: 0.5, y: 0.5, w: 4, h: 4, text: "a", style: { fontSize: 14 } },
            // b overlaps a heavily: small element almost entirely inside a.
            { type: "text", id: "b", x: 0.6, y: 0.6, w: 3.8, h: 3.8, text: "b", style: { fontSize: 14 } }
          ]
        }
      ]);
      const result = preflightLayout(manifest);
      const issue = result.checks.find((c) => c.type === "overlap");
      expect(issue).toBeTruthy();
      expect(issue.severity).toBe("critical");
    });

    it("does NOT flag decorative roles (background/backdrop/canvas)", () => {
      const manifest = makeManifest([
        {
          id: "s1",
          background: { type: "solid", color: "#FFFFFF" },
          elements: [
            { type: "shape", id: "bg", role: "background", x: 0, y: 0, w: 13.333, h: 7.5, shape: "rect" },
            { type: "text", id: "x", x: 0.5, y: 0.5, w: 4, h: 4, text: "x", style: { fontSize: 14 } }
          ]
        }
      ]);
      const result = preflightLayout(manifest);
      expect(result.checks.find((c) => c.type === "overlap")).toBeUndefined();
    });
  });

  describe("connector accuracy", () => {
    it("passes a connector attached to declared source and target boundaries", () => {
      const manifest = makeManifest([{
        id: "s1",
        background: { type: "solid", color: "#FFFFFF" },
        elements: [
          { type: "shape", id: "source", x: 1, y: 1, w: 2, h: 1, shape: "rect" },
          { type: "shape", id: "target", x: 1, y: 3, w: 2, h: 1, shape: "rect" },
          { type: "line", id: "connector-1", x: 2, y: 2, w: 0, h: 1, style: { sourceId: "source", targetId: "target", endArrowType: "triangle" } }
        ]
      }]);
      const result = preflightLayout(manifest);
      expect(result.checks.find((c) => c.type === "connector-detached")).toBeUndefined();
    });

    it("blocks a connector whose endpoints miss the declared nodes", () => {
      const manifest = makeManifest([{
        id: "s1",
        background: { type: "solid", color: "#FFFFFF" },
        elements: [
          { type: "shape", id: "source", x: 1, y: 1, w: 2, h: 1, shape: "rect" },
          { type: "shape", id: "target", x: 1, y: 3, w: 2, h: 1, shape: "rect" },
          { type: "line", id: "connector-1", x: 6, y: 2, w: 0, h: 1, style: { sourceId: "source", targetId: "target" } }
        ]
      }]);
      const result = preflightLayout(manifest, { strict: true });
      const issue = result.checks.find((c) => c.type === "connector-detached");
      expect(issue?.severity).toBe("critical");
      expect(issue?.suggestion).toMatchObject({ x: 2, y: 2, w: 0, h: 1 });
      expect(result.summary.blocked).toBe(true);
    });
  });

  describe("summary", () => {
    it("counts critical vs warning separately", () => {
      const manifest = makeManifest([
        {
          id: "s1",
          background: { type: "solid", color: "#FFFFFF" },
          elements: [
            { type: "text", id: "tiny", x: 0.5, y: 0.5, w: 4, h: 0.5, text: "tiny", style: { fontSize: 8 } }, // critical font-size
            { type: "shape", id: "card-a", x: 4.6, y: 0.5, w: 4, h: 2, shape: "rect" },
            { type: "shape", id: "card-b", x: 8.7, y: 0.5, w: 4, h: 2, shape: "rect" } // warning card-spacing
          ]
        }
      ]);
      const result = preflightLayout(manifest, {
        designTokens: { spacing: { md: 1.5 } }
      });
      expect(result.summary.criticalCount).toBeGreaterThanOrEqual(1);
      expect(result.summary.warningCount).toBeGreaterThanOrEqual(1);
      expect(result.summary.slideCount).toBe(1);
      expect(result.summary.blocked).toBe(false); // soft-block default
    });

    it("blocked=true when strict=true and critical>0", () => {
      const manifest = makeManifest([
        textSlide({ type: "text", id: "tiny", x: 0.5, y: 0.5, w: 4, h: 0.5, text: "x", style: { fontSize: 8 } })
      ]);
      const result = preflightLayout(manifest, { strict: true });
      expect(result.summary.blocked).toBe(true);
    });
  });
});
