// Generates static, deterministic HTML/CSS/React/data preview artifacts from
// a UI spec, component specs, and design tokens. No bundler or runtime deps.

function safe(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return value;
  return String(value);
}

function buildIndexHtml() {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    "    <title>Preview</title>",
    '    <link rel="stylesheet" href="./styles.css" />',
    "  </head>",
    "  <body>",
    '    <div id="slides-root"></div>',
    '    <script type="module" src="./components.jsx"></script>',
    "  </body>",
    "</html>",
    ""
  ].join("\n");
}

function buildStylesCss(designTokens) {
  const color = (designTokens && designTokens.color) || {};
  const typography = (designTokens && designTokens.typography) || {};
  const spacing = (designTokens && designTokens.spacing) || {};
  return [
    ":root {",
    `  --color-background: ${safe(color.background, "#FFFFFF")};`,
    `  --color-text: ${safe(color.text, "#111827")};`,
    `  --color-primary: ${safe(color.primary, "#155EEF")};`,
    `  --color-accent: ${safe(color.accent, color.primary, "#155EEF")};`,
    `  --color-surface: ${safe(color.surface, color.background, "#FFFFFF")};`,
    `  --font-heading: ${safe(typography.heading, "Aptos Display")}, sans-serif;`,
    `  --font-body: ${safe(typography.body, "Aptos")}, sans-serif;`,
    `  --slide-padding: ${safe(spacing.slidePadding, 48)}px;`,
    "}",
    "",
    "#slides-root {",
    "  background: var(--color-background);",
    "  color: var(--color-text);",
    "  font-family: var(--font-body);",
    "  padding: var(--slide-padding);",
    "}",
    "",
    ".slide {",
    "  font-family: var(--font-body);",
    "  color: var(--color-text);",
    "}",
    "",
    ".slide h1, .slide h2, .slide h3 {",
    "  font-family: var(--font-heading);",
    "  color: var(--color-primary);",
    "}",
    ""
  ].join("\n");
}

function buildComponentsJsx() {
  return [
    "import React from 'react';",
    "import { slides } from './data.jsx';",
    "",
    "export function Slide({ slide }) {",
    "  return (",
    '    <section className="slide" data-id={slide.id} data-layout={slide.layoutPattern}>',
    "      {slide.regions.map((region) => (",
    '        <div key={region.id} className={`region region-${region.role}`} data-priority={region.priority}>',
    "          {region.id}",
    "        </div>",
    "      ))}",
    "    </section>",
    "  );",
    "}",
    "",
    "export function Slides() {",
    "  return (",
    '    <div className="slides">',
    "      {slides.map((slide) => <Slide key={slide.id} slide={slide} />)}",
    "    </div>",
    "  );",
    "}",
    "",
    "export default Slides;",
    ""
  ].join("\n");
}

function buildDataJsx(uiSpec, componentSpecs) {
  const slides = (uiSpec && Array.isArray(uiSpec.slides)) ? uiSpec.slides : [];
  const componentsBySlide = new Map();
  if (componentSpecs && Array.isArray(componentSpecs.slides)) {
    for (const s of componentSpecs.slides) componentsBySlide.set(s.id, s.components || []);
  }
  const lines = ["export const slides = ["];
  slides.forEach((slide, index) => {
    const components = componentsBySlide.get(slide.id) || [];
    lines.push("  {");
    lines.push(`    id: ${JSON.stringify(safe(slide.id, `slide-${index + 1}`))},`);
    lines.push(`    layoutPattern: ${JSON.stringify(safe(slide.layoutPattern, "default"))},`);
    lines.push(`    regions: ${JSON.stringify(slide.regions || [])},`);
    lines.push(`    components: ${JSON.stringify(components)}`);
    lines.push("  },");
  });
  lines.push("];");
  lines.push("");
  lines.push("export default slides;");
  lines.push("");
  return lines.join("\n");
}

export function generatePreviewArtifacts(input) {
  const uiSpec = (input && input.uiSpec) || { version: "1.0", slides: [] };
  const componentSpecs = (input && input.componentSpecs) || { version: "1.0", slides: [] };
  const designTokens = (input && input.designTokens) || {
    version: "1.0",
    color: { background: "#FFFFFF", text: "#111827", primary: "#155EEF" },
    typography: { heading: "Aptos Display", body: "Aptos" },
    spacing: { slidePadding: 48 }
  };

  return {
    version: "1.0",
    generatedFrom: ["ui-spec", "component-specs", "design-tokens"],
    files: {
      "index.html": buildIndexHtml(),
      "styles.css": buildStylesCss(designTokens),
      "components.jsx": buildComponentsJsx(),
      "data.jsx": buildDataJsx(uiSpec, componentSpecs)
    }
  };
}

export default generatePreviewArtifacts;
