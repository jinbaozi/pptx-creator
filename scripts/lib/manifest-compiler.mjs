import { resolveArchetypeForSlide } from "./archetype-resolver.mjs";

const SLIDE = { width: 13.333, height: 7.5 };

function slotContent(slideSpec, slotName, fallback = "") {
  const slot = slideSpec.contentSlots.find((item) => item.slot === slotName);
  return slot?.content ?? fallback;
}

function textElement(id, text, x, y, w, h, style = {}) {
  return {
    type: "text",
    id,
    x,
    y,
    w,
    h,
    text: Array.isArray(text) ? text.join("\n") : String(text),
    style
  };
}

function shapeElement(id, x, y, w, h, style = {}) {
  return {
    type: "shape",
    id,
    shape: "roundRect",
    x,
    y,
    w,
    h,
    style
  };
}

function compileGenericSlide(slideSpec, index, designDirection) {
  const headline = slotContent(slideSpec, "headline", slideSpec.mainIdea);
  const background = designDirection.palette.background || "#FFFFFF";
  const text = designDirection.palette.text || "#111827";
  const primary = designDirection.palette.primary || "#2563EB";
  const elements = [
    textElement("headline", headline, 0.7, 0.5, 11.8, 0.7, {
      fontSize: index === 0 ? 38 : 28,
      bold: true,
      color: text
    })
  ];

  if (slideSpec.layoutType === "cover") {
    elements.push(textElement("subtitle", slotContent(slideSpec, "subtitle", slideSpec.intent), 0.75, 1.35, 7.2, 0.45, {
      fontSize: 17,
      color: text
    }));
    elements.push(shapeElement("accent-bar", 0.75, 6.45, 3.4, 0.08, { fill: primary, line: primary }));
  } else {
    elements.push(textElement("main-idea", slideSpec.mainIdea, 0.75, 1.25, 5.1, 1.1, {
      fontSize: 16,
      color: text
    }));
    elements.push(shapeElement("content-panel", 6.2, 1.25, 6.0, 4.9, {
      fill: designDirection.palette.surface || "#F3F4F6",
      line: primary,
      radius: 0.12
    }));
  }

  return {
    id: slideSpec.id,
    type: slideSpec.layoutType,
    title: Array.isArray(headline) ? headline.join(" ") : String(headline),
    notes: slideSpec.intent,
    background: { type: "solid", color: background },
    elements
  };
}

export function compileDesignFirstManifest(artifacts, options = {}) {
  const { storyboard, designDirection, slideDesignSpecs } = artifacts;
  const archetypeRoot = options.archetypeRoot || "layout-archetypes";
  const slides = slideDesignSpecs.slides.map((slideSpec, index) => {
    resolveArchetypeForSlide(slideSpec, archetypeRoot);
    return compileGenericSlide(slideSpec, index, designDirection);
  });
  return {
    version: "0.1.1",
    designSystem: {
      source: options.designSystemSource || "design-systems/business-neutral/DESIGN.md",
      name: options.designSystemName || "Business Neutral",
      mode: options.designSystemMode || "creative"
    },
    deck: {
      title: storyboard.title,
      language: storyboard.language,
      size: { preset: "wide", width: SLIDE.width, height: SLIDE.height, unit: "in" }
    },
    assets: [],
    slides
  };
}
