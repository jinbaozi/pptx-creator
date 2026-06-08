const ROLE_TO_COMPONENT_TYPE = {
  headline: "textBlock",
  metric: "metric",
  diagram: "semanticDiagram",
  chart: "nativeChart"
};

export function compileComponentSpecs({ uiSpec } = {}) {
  if (!uiSpec || !Array.isArray(uiSpec.slides)) {
    throw new Error("uiSpec.slides is required");
  }
  const version = uiSpec.version || "1.0";

  const slides = uiSpec.slides.map((slide) => {
    const regions = Array.isArray(slide.regions) ? slide.regions : [];
    const components = regions.map((region) => {
      const type = ROLE_TO_COMPONENT_TYPE[region.role] || "card";
      return {
        id: `${slide.id}-${region.id}`,
        type,
        editability: "native",
        region: region.id,
        role: region.role || ""
      };
    });
    return {
      id: slide.id,
      layoutPattern: slide.layoutPattern || "executive-summary",
      components
    };
  });

  return { version, slides };
}
