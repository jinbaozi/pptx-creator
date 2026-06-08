const DEFAULT_SIZE = { width: 13.333, height: 7.5 };

function number(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function addIssue(issues, issue) {
  issues.push(issue);
}

function scoreSlide(slide, deckSize) {
  const issues = [];
  const repairs = [];
  const elements = slide.elements || [];
  for (const el of elements) {
    const x = number(el.x);
    const y = number(el.y);
    const w = number(el.w);
    const h = number(el.h);
    if (x < 0 || y < 0 || x + w > deckSize.width || y + h > deckSize.height) {
      addIssue(issues, {
        severity: "high",
        type: "bounds",
        message: `Element ${el.id} exceeds slide bounds.`,
        target: el.id
      });
      repairs.push({
        action: "resize",
        target: el.id,
        params: { fitToSlide: true }
      });
    }
    if (el.type === "text") {
      const fontSize = number(el.style?.fontSize, 16);
      if (fontSize < 11) {
        addIssue(issues, {
          severity: "medium",
          type: "font-size",
          message: `Element ${el.id} uses font size below 11pt.`,
          target: el.id
        });
        repairs.push({
          action: "updateStyle",
          target: el.id,
          params: { fontSize: 11 }
        });
      }
    }
    if (el.type === "chart") {
      const data = Array.isArray(el.data) ? el.data : [];
      const labelBudget = Math.max(1, Math.floor(w / 0.45));
      if (data.length > labelBudget) {
        addIssue(issues, {
          severity: "medium",
          type: "chart-label-density",
          message: `Chart ${el.id} has more labels than the available width supports.`,
          target: el.id
        });
      }
      if (!el.description) {
        addIssue(issues, {
          severity: "medium",
          type: "chart-description",
          message: `Chart ${el.id} is missing a plain-language description.`,
          target: el.id
        });
      }
    }
    if (el.type === "diagram") {
      if (!el.description) {
        addIssue(issues, {
          severity: "medium",
          type: "diagram-description",
          message: `Diagram ${el.id} is missing a plain-language description.`,
          target: el.id
        });
      }
      const layers = el.layers ?? el.lanes;
      if (["layeredArchitecture", "compilerPipeline", "capabilityStack", "swimlane"].includes(el.kind) && (!Array.isArray(layers) || layers.length === 0)) {
        addIssue(issues, {
          severity: "high",
          type: "diagram-empty-layers",
          message: `Diagram ${el.id} has no layers or lanes.`,
          target: el.id
        });
      }
    }
  }
  if (!elements.some((el) => el.type === "text")) {
    addIssue(issues, {
      severity: "medium",
      type: "hierarchy",
      message: "Slide has no native text element.",
      target: slide.id
    });
  }
  const penalty = issues.reduce((sum, issue) => sum + (issue.severity === "high" ? 18 : 10), 0);
  const score = Math.max(0, 100 - penalty);
  return {
    id: slide.id,
    score,
    scores: {
      hierarchy: elements.some((el) => el.type === "text") ? 85 : 45,
      alignment: issues.some((issue) => issue.type === "bounds") ? 55 : 88,
      density: elements.length > 14 ? 65 : 85,
      contrast: 82,
      variety: 80,
      editability: elements.some((el) => el.type === "image") ? 78 : 95,
      designSystemFit: 82
    },
    issues,
    recommendedRepairs: repairs
  };
}

export function reviewManifest(manifest, options = {}) {
  const deckSize = manifest.deck?.size || DEFAULT_SIZE;
  const slides = (manifest.slides || []).map((slide) => scoreSlide(slide, deckSize));
  const deckScore = slides.length
    ? Math.round(slides.reduce((sum, slide) => sum + slide.score, 0) / slides.length)
    : 0;
  return {
    mode: options.mode || "creative",
    deckScore,
    slides
  };
}
