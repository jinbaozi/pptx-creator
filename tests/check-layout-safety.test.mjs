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
    it("flags critical content occlusion when > 1% of smaller area", () => {
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
      const issue = result.checks.find((c) => c.type === "content-occlusion");
      expect(issue).toBeTruthy();
      expect(issue.severity).toBe("critical");
    });

    it("blocks decorative occlusion unless the exact pair is allowlisted", () => {
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
      expect(result.checks.find((c) => c.type === "decoration-occlusion")).toBeTruthy();
      manifest.slides[0].elements[0].allowOverlapWith = ["x"];
      const approved = preflightLayout(manifest);
      expect(approved.checks.find((c) => c.type === "decoration-occlusion")).toBeUndefined();
    });

    it("blocks CJK body line height below 1.20 and warns below 1.35", () => {
      const manifest = makeManifest([textSlide({
        type: "text", id: "cjk-body", x: 1, y: 1, w: 4, h: 1,
        text: "中文正文需要舒适的阅读节奏", style: { fontSize: 14, lineHeight: 1.1 }
      })]);
      expect(preflightLayout(manifest).checks.find((check) => check.type === "line-height-too-tight")?.severity).toBe("critical");
      manifest.slides[0].elements[0].style.lineHeight = 1.25;
      expect(preflightLayout(manifest).checks.find((check) => check.type === "line-height-too-tight")?.severity).toBe("warning");
    });
  });

  describe("connector accuracy", () => {
    it("blocks connector-like lines that omit semantic endpoint metadata", () => {
      const manifest = makeManifest([{
        id: "s1",
        background: { type: "solid", color: "#FFFFFF" },
        elements: [{ type: "line", role: "connector", id: "connector-1", x: 1, y: 1, w: 2, h: 0.01, style: {} }]
      }]);
      const result = preflightLayout(manifest, { strict: true });
      const issue = result.checks.find((c) => c.type === "connector-detached");
      expect(issue?.severity).toBe("critical");
      expect(result.summary.blocked).toBe(true);
    });

    it("does not require semantic endpoints for axes, dividers, or decorative lines", () => {
      const manifest = makeManifest([{
        id: "s1",
        background: { type: "solid", color: "#FFFFFF" },
        elements: [
          { type: "line", role: "axis", id: "axis-x", x: 1, y: 1, w: 2, h: 0.01, style: {} },
          { type: "line", role: "divider", id: "divider", x: 1, y: 2, w: 2, h: 0.01, style: {} },
          { type: "line", role: "decorative", id: "accent-line", x: 1, y: 3, w: 2, h: 0.01, style: {} }
        ]
      }]);
      const result = preflightLayout(manifest, { strict: true });
      expect(result.checks.find((c) => c.type === "connector-detached")).toBeUndefined();
    });

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

    it("blocks arrow-like lines that omit module semantics", () => {
      const manifest = makeManifest([{
        id: "s1",
        background: { type: "solid", color: "#FFFFFF" },
        elements: [
          { type: "line", id: "flow-arrow", x: 1, y: 1, w: 2, h: 0, style: { endArrowType: "triangle" } }
        ]
      }]);
      const result = preflightLayout(manifest, { strict: true });
      expect(result.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "connector-detached", target: "flow-arrow", severity: "critical" })
      ]));
    });

    it("blocks a semantic connector without a target-facing end marker", () => {
      const manifest = makeManifest([{
        id: "s1",
        background: { type: "solid", color: "#FFFFFF" },
        elements: [
          { type: "shape", id: "source", x: 1, y: 1, w: 2, h: 1, shape: "rect" },
          { type: "shape", id: "target", x: 5, y: 1, w: 2, h: 1, shape: "rect" },
          { type: "line", role: "connector", id: "flow", x: 3, y: 1.5, w: 2, h: 0, connector: { sourceId: "source", targetId: "target", sourceAnchor: "auto", targetAnchor: "auto", route: "straight" }, style: {} }
        ]
      }]);
      const result = preflightLayout(manifest, { strict: true });
      expect(result.checks.find((check) => check.type === "connector-marker-missing")?.severity).toBe("critical");
    });

    it("blocks a straight connector that crosses an unrelated module", () => {
      const manifest = makeManifest([{
        id: "s1",
        background: { type: "solid", color: "#FFFFFF" },
        elements: [
          { type: "shape", id: "source", x: 1, y: 1, w: 1, h: 1, shape: "rect" },
          { type: "shape", id: "obstacle", x: 3, y: 1, w: 1, h: 1, shape: "rect" },
          { type: "shape", id: "target", x: 5, y: 1, w: 1, h: 1, shape: "rect" },
          { type: "line", role: "connector", id: "flow", x: 2, y: 1.5, w: 3, h: 0, connector: { sourceId: "source", targetId: "target", sourceAnchor: "auto", targetAnchor: "auto", route: "straight" }, style: { endArrowType: "triangle" } }
        ]
      }]);
      const result = preflightLayout(manifest, { strict: true });
      expect(result.checks.find((check) => check.type === "connector-obstructed")).toMatchObject({
        severity: "critical", target: "flow", relatedTarget: "obstacle"
      });
    });

    it("uses ray-intersection anchors for diagonal module connections", () => {
      const manifest = makeManifest([{
        id: "s1",
        background: { type: "solid", color: "#FFFFFF" },
        elements: [
          { type: "shape", id: "source", x: 0.5, y: 0.5, w: 2, h: 2, shape: "rect" },
          { type: "shape", id: "target", x: 4.5, y: 3.5, w: 2, h: 2, shape: "rect" },
          { type: "line", role: "connector", id: "diagonal", x: 2.5, y: 2.25, w: 2, h: 1.5, connector: { sourceId: "source", targetId: "target", sourceAnchor: "auto", targetAnchor: "auto", route: "straight" }, style: { endArrowType: "triangle" } }
        ]
      }]);
      const result = preflightLayout(manifest, { strict: true });
      expect(result.checks.find((check) => check.type.startsWith("connector-"))).toBeUndefined();
    });
  });

  describe("decorative grid policy", () => {
    const lattice = () => [
      ...[1, 2.5, 4, 5.5].map((y, index) => ({ type: "line", role: "decorative", id: `grid-h-${index}`, x: 0, y, w: DECK.width, h: 0, style: { width: 1, transparency: 70 } })),
      ...[2, 5, 8, 11].map((x, index) => ({ type: "line", role: "decorative", id: `grid-v-${index}`, x, y: 0, w: 0, h: DECK.height, style: { width: 1, transparency: 70 } }))
    ];

    it("blocks an unapproved full-slide orthogonal line lattice", () => {
      const manifest = makeManifest([{ id: "s1", background: { type: "solid", color: "#FFFFFF" }, elements: lattice() }]);
      const result = preflightLayout(manifest, { strict: true });
      const issue = result.checks.find((check) => check.type === "decorative-grid");
      expect(issue?.severity).toBe("critical");
      expect(result.summary.blocked).toBe(true);
    });

    it("blocks a repeated one-direction background ruling", () => {
      const manifest = makeManifest([{
        id: "s1", background: { type: "solid", color: "#FFFFFF" },
        elements: lattice().filter((line) => line.id.startsWith("grid-h-"))
      }]);
      expect(preflightLayout(manifest, { strict: true }).checks.find((check) => check.type === "decorative-grid")?.severity).toBe("critical");
    });

    it("allows the lattice only with explicit visibleGrid intent", () => {
      const manifest = makeManifest([{ id: "s1", background: { type: "solid", color: "#FFFFFF" }, elements: lattice() }]);
      manifest.metadata = { designIntent: { visibleGrid: true } };
      const result = preflightLayout(manifest, { strict: true });
      expect(result.checks.find((check) => check.type === "decorative-grid")).toBeUndefined();
    });

    it("does not mistake matrix axes or semantic connectors for a background grid", () => {
      const manifest = makeManifest([{
        id: "s1", background: { type: "solid", color: "#FFFFFF" },
        elements: [
          { type: "shape", id: "a", x: 1, y: 1, w: 1, h: 1 },
          { type: "shape", id: "b", x: 4, y: 1, w: 1, h: 1 },
          { type: "line", role: "axis", id: "axis-x", x: 1, y: 3.75, w: 10, h: 0, style: {} },
          { type: "line", role: "axis", id: "axis-y", x: 6.65, y: 1, w: 0, h: 5, style: {} },
          { type: "line", role: "connector", id: "connector-a-b", x: 2, y: 1.5, w: 2, h: 0, style: { sourceId: "a", targetId: "b" } }
        ]
      }]);
      expect(preflightLayout(manifest, { strict: true }).checks.find((check) => check.type === "decorative-grid")).toBeUndefined();
    });
  });

  describe("semantic containment and footer-safe band", () => {
    it("blocks a child that escapes its declared semantic container", () => {
      const manifest = makeManifest([{
        id: "s1",
        background: { type: "solid", color: "#FFFFFF" },
        elements: [
          { type: "shape", id: "panel", role: "container", x: 1, y: 1, w: 3, h: 3, shape: "rect" },
          { type: "text", id: "subtitle", semanticParentId: "panel", x: 1.2, y: 2, w: 4, h: 0.5, text: "Escapes", style: { fontSize: 14 } }
        ]
      }]);
      const result = preflightLayout(manifest, { strict: true });
      expect(result.checks.find((check) => check.type === "semantic-container-escape")).toMatchObject({
        severity: "critical", target: "subtitle", relatedTarget: "panel"
      });
      expect(result.summary.blocked).toBe(true);
    });

    it("accepts a child fully contained by its declared semantic parent", () => {
      const manifest = makeManifest([{
        id: "s1",
        background: { type: "solid", color: "#FFFFFF" },
        elements: [
          { type: "shape", id: "panel", role: "container", x: 1, y: 1, w: 3, h: 3, shape: "rect" },
          { type: "text", id: "subtitle", semanticParentId: "panel", x: 1.2, y: 2, w: 2.6, h: 0.5, text: "Contained", style: { fontSize: 14 } }
        ]
      }]);
      const result = preflightLayout(manifest, { strict: true });
      expect(result.checks.find((check) => check.type === "semantic-container-escape")).toBeUndefined();
    });

    it("blocks body content that extends into an explicitly marked footer region", () => {
      const manifest = makeManifest([{
        id: "s1",
        background: { type: "solid", color: "#FFFFFF" },
        elements: [
          { type: "text", id: "row-04", x: 2.6, y: 6.65, w: 6, h: 0.4, text: "Fourth row", style: { fontSize: 14 } },
          { type: "line", id: "footer-rule", role: "footer-decoration", layoutRegion: "footer", x: 0.7, y: 6.75, w: 2, h: 0, style: { width: 2 } },
          { type: "text", id: "slide-number", role: "slide-number", layoutRegion: "footer", x: 11.8, y: 6.8, w: 0.4, h: 0.2, text: "10", style: { fontSize: 10 } }
        ]
      }]);
      const result = preflightLayout(manifest, { strict: true });
      expect(result.checks.find((check) => check.type === "footer-safe-area-collision")).toMatchObject({
        severity: "critical", target: "row-04", relatedTarget: "footer-rule"
      });
    });

    it("keeps semantic containment and footer collisions warning-only in strict replica mode", () => {
      const manifest = makeManifest([{
        id: "s1",
        background: { type: "solid", color: "#FFFFFF" },
        elements: [
          { type: "shape", id: "panel", x: 1, y: 1, w: 3, h: 3, shape: "rect" },
          { type: "text", id: "child", semanticParentId: "panel", x: 1, y: 2, w: 4, h: 0.5, text: "Replica", style: { fontSize: 14 } },
          { type: "line", id: "footer-rule", role: "footer-decoration", layoutRegion: "footer", x: 0.7, y: 6.75, w: 2, h: 0, style: { width: 2 } },
          { type: "text", id: "row-04", x: 2.6, y: 6.65, w: 6, h: 0.4, text: "Fourth row", style: { fontSize: 14 } }
        ]
      }]);
      const result = preflightLayout(manifest, { strict: true, mode: "replica" });
      expect(result.checks.find((check) => check.type === "semantic-container-escape")?.severity).toBe("warning");
      expect(result.checks.find((check) => check.type === "footer-safe-area-collision")?.severity).toBe("warning");
      expect(result.summary.criticalCount).toBe(0);
      expect(result.summary.blocked).toBe(false);
    });
  });

  describe("title-band and rounded-container contracts", () => {
    it("blocks a 28pt two-line title in a 0.55in one-line title band", () => {
      const manifest = makeManifest([{
        id: "s1",
        background: { type: "solid", color: "#FFFFFF" },
        elements: [
          {
            type: "text", id: "slide-title", role: "title", maxLines: 1,
            x: 0.72, y: 0.66, w: 11.9, h: 0.55,
            text: "Kimi K3：极致性价比与 Agent 能力\nFable 5 and GPT-5.6 comparison",
            style: { fontSize: 28, lineHeight: 1.2 }
          },
          { type: "shape", id: "content-card", x: 0.72, y: 1.28, w: 11.9, h: 5.2, shape: "rect" }
        ]
      }]);
      const result = preflightLayout(manifest, { strict: true, inputType: "html", mode: "creative" });
      expect(result.checks.find((check) => check.type === "title-line-limit")).toMatchObject({ severity: "critical", target: "slide-title" });
      expect(result.checks.find((check) => check.type === "title-content-gap")).toMatchObject({ severity: "critical", relatedTarget: "content-card" });
      expect(result.summary.blocked).toBe(true);
    });

    it("accepts an explicit two-line title when measured height and content offset are reserved", () => {
      const manifest = makeManifest([{
        id: "s1",
        background: { type: "solid", color: "#FFFFFF" },
        elements: [
          {
            type: "text", id: "slide-title", role: "title", maxLines: 2,
            x: 0.72, y: 0.66, w: 11.9, h: 0.94,
            text: "Kimi K3：极致性价比与 Agent 能力\nFable 5 and GPT-5.6 comparison",
            style: { fontSize: 28, lineHeight: 1.2 }
          },
          { type: "shape", id: "content-card", x: 0.72, y: 1.74, w: 11.9, h: 4.7, shape: "rect" }
        ]
      }]);
      const result = preflightLayout(manifest, { strict: true, inputType: "html", mode: "creative" });
      expect(result.checks.find((check) => ["title-line-limit", "title-content-gap"].includes(check.type))).toBeUndefined();
    });

    it("blocks a chart label inside a rounded corner tangent zone", () => {
      const manifest = makeManifest([{
        id: "s1",
        background: { type: "solid", color: "#FFFFFF" },
        elements: [
          { type: "shape", id: "chart-panel", role: "container", x: 0.72, y: 1.35, w: 6, h: 4.8, shape: "roundRect", safeInset: 0.12 },
          { type: "text", id: "axis-label", semanticParentId: "chart-panel", x: 0.75, y: 1.45, w: 0.8, h: 0.3, text: "100%", style: { fontSize: 11 } }
        ]
      }]);
      const result = preflightLayout(manifest, { strict: true, inputType: "html", mode: "creative" });
      expect(result.checks.find((check) => check.type === "semantic-safe-inset")).toMatchObject({ severity: "critical", target: "axis-label" });
    });

    it("accepts a chart label inside the rounded container safe frame", () => {
      const manifest = makeManifest([{
        id: "s1",
        background: { type: "solid", color: "#FFFFFF" },
        elements: [
          { type: "shape", id: "chart-panel", role: "container", x: 0.72, y: 1.35, w: 6, h: 4.8, shape: "roundRect", safeInset: 0.12 },
          { type: "text", id: "axis-label", semanticParentId: "chart-panel", x: 0.88, y: 1.52, w: 0.8, h: 0.3, text: "100%", style: { fontSize: 11 } }
        ]
      }]);
      const result = preflightLayout(manifest, { strict: true, inputType: "html", mode: "creative" });
      expect(result.checks.find((check) => ["semantic-safe-inset", "semantic-container-escape"].includes(check.type))).toBeUndefined();
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
