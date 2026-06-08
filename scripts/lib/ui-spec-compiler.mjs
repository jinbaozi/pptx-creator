const ROLE_TO_LAYOUT = {
  cover: "hero",
  architecture: "architecture-layered",
  process: "process-flow",
  metrics: "metrics-dashboard",
  comparison: "comparison-matrix",
  roadmap: "roadmap",
  summary: "executive-summary"
};

function inferRole(slide) {
  if (slide.slideRole) return slide.slideRole;
  if (slide.role) return slide.role;
  return "summary";
}

function defaultRegionsForLayout(layoutPattern) {
  if (layoutPattern === "hero") {
    return [
      { id: "headline", role: "headline", priority: 1 },
      { id: "supporting", role: "supporting", priority: 2 }
    ];
  }
  if (layoutPattern === "architecture-layered") {
    return [
      { id: "diagram", role: "diagram", priority: 1 },
      { id: "caption", role: "headline", priority: 2 }
    ];
  }
  return [{ id: "headline", role: "headline", priority: 1 }];
}

export function compileUiSpec({ storyboard, designDirection = {} } = {}) {
  if (!storyboard || !Array.isArray(storyboard.slides)) {
    throw new Error("storyboard.slides is required");
  }
  const palette = designDirection.palette || {};

  const slides = storyboard.slides.map((slide) => {
    const role = inferRole(slide);
    const layoutPattern = ROLE_TO_LAYOUT[role] || "executive-summary";
    const regions = (Array.isArray(slide.regions) && slide.regions.length > 0)
      ? slide.regions
      : defaultRegionsForLayout(layoutPattern);
    return {
      id: slide.id,
      title: slide.title || "",
      slideRole: role,
      visualIntent: slide.visualIntent || "",
      layoutPattern,
      palette,
      regions
    };
  });

  return {
    version: "1.0",
    designDirection: { palette },
    slides
  };
}
