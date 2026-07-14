import { readFileSync } from "node:fs";
import { validateJsonSchema } from "./schema-utils.mjs";
import { resolveSemanticConnectors } from "./connector-resolver.mjs";
import { assertSafeAssetRuntimePath } from "./registry.mjs";

const W = 13.333;
const H = 7.5;
const DECK_PLAN_SCHEMA = JSON.parse(readFileSync(new URL("../../schemas/deck-plan.schema.json", import.meta.url), "utf8"));
const DEFAULT_DESIGN_TOKENS = Object.freeze({
  colors: {
    primary: "#2563EB", secondary: "#475569", accent: "#0EA5E9", background: "#FFFFFF",
    surface: "#F8FAFC", surfaceAlt: "#EFF6FF", text: "#111827", textMuted: "#64748B", border: "#E2E8F0"
  },
  typography: {
    title: { fontFamily: "Microsoft YaHei", fontSize: 32, fontWeight: 700, lineHeight: 1.18 },
    subtitle: { fontFamily: "Microsoft YaHei", fontSize: 20, fontWeight: 500, lineHeight: 1.35 },
    heading: { fontFamily: "Microsoft YaHei", fontSize: 22, fontWeight: 700, lineHeight: 1.25 },
    body: { fontFamily: "Microsoft YaHei", fontSize: 15, fontWeight: 400, lineHeight: 1.55 },
    caption: { fontFamily: "Microsoft YaHei", fontSize: 11, fontWeight: 400, lineHeight: 1.35 },
    metric: { fontFamily: "Arial", fontSize: 42, fontWeight: 700, lineHeight: 1 }
  },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 36 }
});
const VISUAL_ASSET_KINDS = new Set(["photo", "illustration", "icon", "logo", "texture"]);
const MAX_VISUAL_ASSETS_PER_SLIDE = 5;

const text = (id, value, x, y, w, h, style = {}) => ({
  type: "text", id, x, y, w, h, text: Array.isArray(value) ? value.join("\n") : String(value ?? ""), style
});
const shape = (id, x, y, w, h, fill = "#EEF2FF", line = "#2563EB") => ({
  type: "shape", id, shape: "roundRect", x, y, w, h, style: { fill, line }
});
const line = (id, x, y, w, h, color = "#2563EB", connector = null) => ({
  type: "line", id, x, y, w, h,
  ...(connector ? { role: "connector" } : {}),
  ...(connector ? { connector: {
    sourceId: connector.sourceId,
    targetId: connector.targetId,
    sourceAnchor: connector.sourceAnchor ?? "auto",
    targetAnchor: connector.targetAnchor ?? "auto",
    route: connector.route ?? "straight"
  } } : {}),
  style: { color, width: 2, ...(connector?.endArrowType ? { endArrowType: connector.endArrowType } : {}) }
});
const title = (value) => text("headline", value, 0.72, 0.42, 11.9, 0.62, { fontSize: 28, bold: true, color: "#111827" });
const itemText = (item) => typeof item === "string" ? item : item?.label ?? item?.title ?? item?.name ?? JSON.stringify(item);
const PAGE_ROLE_MAP = Object.freeze({
  "single-point": "point",
  decision: "evidence",
  appendix: "section"
});

function applyCompositionStrategy(elements, strategy) {
  if (!strategy) return elements;
  return elements.map((element, index) => {
    const next = structuredClone(element);
    if (strategy === "asymmetric") {
      next.x = Math.max(0, Math.min(W - next.w, next.x + (index % 2 ? 0.22 : -0.08)));
      next.y = Math.max(0, Math.min(H - next.h, next.y + index * 0.015));
    } else if (strategy === "split") {
      next.x = Math.max(0, Math.min(W - next.w, next.x + (index % 2 ? 0.14 : -0.14)));
    } else if (strategy === "focus" && index === 0) {
      next.w = Math.min(W - next.x, next.w + 0.35);
      if (next.type === "text") next.style.fontSize = Number(next.style?.fontSize ?? 24) + 4;
    } else if (strategy === "editorial" && next.type === "text") {
      next.y = Math.max(0, Math.min(H - next.h, next.y + (index % 3) * 0.08));
    } else if (strategy === "immersive" && next.type === "shape") {
      next.x = Math.max(0, next.x - 0.08); next.w = Math.min(W - next.x, next.w + 0.16);
    } else if (strategy === "data-led") {
      next.y = Math.max(0, Math.min(H - next.h, next.y + (index % 2) * 0.05));
    } else if (strategy === "structural") {
      next.x = Math.max(0, Math.min(W - next.w, next.x + (index % 3 - 1) * 0.06));
    } else if (strategy === "minimal-whitespace") {
      const delta = next.w * 0.06; next.x += delta; next.w -= delta * 2;
    }
    return next;
  });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function boundedElement(element) {
  const next = structuredClone(element);
  next.x = clamp(next.x, 0, W);
  next.y = clamp(next.y, 0, H);
  next.w = clamp(next.w, 0, W - next.x);
  next.h = clamp(next.h, 0, H - next.y);
  return next;
}

function normalizedDesignTokens(tokens = {}) {
  return {
    ...DEFAULT_DESIGN_TOKENS,
    ...structuredClone(tokens),
    colors: { ...DEFAULT_DESIGN_TOKENS.colors, ...(tokens.colors ?? {}) },
    spacing: { ...DEFAULT_DESIGN_TOKENS.spacing, ...(tokens.spacing ?? {}) },
    typography: Object.fromEntries(Object.entries(DEFAULT_DESIGN_TOKENS.typography).map(([role, fallback]) => [
      role,
      { ...fallback, ...(tokens.typography?.[role] ?? {}) }
    ]))
  };
}

export function resolvedDeckPlanDesign(options = {}) {
  const design = options.design ?? {};
  const source = design.source ?? options.designSystemSource ?? "design-systems/business-neutral/DESIGN.md";
  return {
    name: design.name ?? options.designSystemName ?? "Business Neutral",
    source,
    selection: structuredClone(options.designSystemSelection ?? { request: null, resolvedSource: source }),
    tokens: normalizedDesignTokens(design.tokens ?? options.designTokens ?? {})
  };
}

function typographyRole(element) {
  const id = String(element.id ?? "").toLowerCase();
  if (id === "headline" || id === "quote") return "title";
  if (id === "subtitle" || id === "call-to-action") return "subtitle";
  if (/^(?:value|metric|kpi)/.test(id)) return "metric";
  if (/attribution|x-label|y-label|caption|source/.test(id)) return "caption";
  if (/title|quadrant/.test(id)) return "heading";
  return "body";
}

function typographyScale(family, element, role) {
  if (role !== "title") return 1;
  if (element.id === "quote") return 1.05;
  if (element.id !== "headline") return 1;
  if (family === "cover") return 1.3;
  if (family === "closing") return 1.2;
  return 0.9;
}

function mixHexColor(base, tint, tintRatio) {
  const parse = (value) => /^#[0-9A-F]{6}$/i.test(String(value ?? ""))
    ? [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16))
    : null;
  const baseChannels = parse(base);
  const tintChannels = parse(tint);
  if (!baseChannels || !tintChannels) return base;
  return `#${baseChannels.map((channel, index) => Math.round(channel * (1 - tintRatio) + tintChannels[index] * tintRatio)
    .toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function semanticTextColors(tokens) {
  return {
    body: mixHexColor(tokens.colors.text, tokens.colors.primary, 0.15),
    muted: mixHexColor(tokens.colors.textMuted, tokens.colors.primary, 0.25)
  };
}

function resolveMetricFont(tokens, locks = {}) {
  const requested = tokens.typography.metric.fontFamily;
  const genericMetricFaces = new Set(["arial", "helvetica", "inter", "system-ui", "-apple-system", "sans-serif"]);
  const locked = locks.brandLocked === true
    || locks.sourceLocked === true
    || (locks.protectedTokens ?? []).some((token) => token === "typography.metric" || token.startsWith("typography.metric."));
  if (!genericMetricFaces.has(String(requested).trim().toLowerCase())) {
    return { requested, resolved: requested, fallbackApplied: false, reason: "design-token-accepted" };
  }
  if (locked) return { requested, resolved: requested, fallbackApplied: false, reason: "design-token-locked" };
  return {
    requested,
    resolved: tokens.typography.title.fontFamily,
    fallbackApplied: true,
    reason: "quality-fallback-generic-metric-face"
  };
}

function typographyForRole(tokens, role, metricFont) {
  const typography = tokens.typography[role] ?? tokens.typography.body;
  if (role !== "metric") return typography;
  return { ...typography, fontFamily: metricFont.resolved };
}

function resolveDesignToken(value, tokens) {
  if (typeof value !== "string") return value;
  const match = value.match(/^\{([^}]+)\}$/);
  if (!match) return value;
  let cursor = tokens;
  for (const segment of match[1].split(".")) cursor = cursor?.[segment];
  return cursor ?? value;
}

function resolvedComponent(tokens, name) {
  const source = tokens.components?.[name];
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, resolveDesignToken(value, tokens)]));
}

function componentForShape(element) {
  if (["left-panel", "layer-0", "step-0", "kpi-card-0"].includes(element.id)) return "hero-card";
  if (element.id === "right-panel" || /^(?:layer|step|kpi-card)-\d+$/.test(element.id)) return "content-card";
  return null;
}

function applyDesignTokens(elements, tokens, family, metricFont) {
  const semanticColors = semanticTextColors(tokens);
  return elements.map((element, index) => {
    const next = structuredClone(element);
    next.style = { ...(next.style ?? {}) };
    if (next.type === "text") {
      const role = typographyRole(next);
      const typography = typographyForRole(tokens, role, metricFont);
      next.style = {
        ...next.style,
        fontFamily: typography.fontFamily,
        fontFace: typography.fontFamily,
        fontSize: Number((Number(typography.fontSize) * typographyScale(family, next, role)).toFixed(2)),
        fontWeight: Number(typography.fontWeight),
        lineHeight: Number(typography.lineHeight),
        bold: Number(typography.fontWeight) >= 600,
        color: ["title", "heading", "metric"].includes(role)
          ? tokens.colors.primary
          : role === "caption" || next.id === "subtitle"
            ? semanticColors.muted
            : semanticColors.body
      };
      if (role === "metric") next.style.fontResolution = structuredClone(metricFont);
    } else if (next.type === "shape") {
      const numericIndex = Number(String(next.id).match(/(\d+)$/)?.[1] ?? index);
      const decorative = /accent|quote-mark/.test(next.id);
      const diagramNode = /^(?:layer|step)-/.test(next.id);
      const alternate = numericIndex % 2 === 0;
      const componentName = componentForShape(next);
      const component = componentName ? resolvedComponent(tokens, componentName) : {};
      const fallbackFill = alternate ? tokens.colors.surfaceAlt : tokens.colors.surface;
      const fallbackLine = diagramNode ? tokens.colors.primary : tokens.colors.border;
      next.style.fill = decorative
        ? tokens.colors.primary
        : component.backgroundColor ?? fallbackFill;
      next.style.line = decorative ? tokens.colors.primary : component.borderColor ?? fallbackLine;
      next.style.backgroundColor = next.style.fill;
      next.style.borderColor = next.style.line;
      if (componentName) {
        next.style.component = `{components.${componentName}}`;
        if (component.padding !== undefined) next.style.padding = component.padding;
        if (component.rounded !== undefined) next.style.rounded = component.rounded;
      }
    } else if (next.type === "line") {
      next.style.color = tokens.colors.primary;
    }
    return next;
  });
}

function pageRoleColor(pageRole, colors) {
  const roles = {
    cover: colors.primary,
    section: colors.secondary,
    "single-point": colors.accent,
    evidence: colors.secondary,
    data: colors.primary,
    comparison: colors.accent,
    process: colors.primary,
    architecture: colors.secondary,
    "case-study": colors.accent,
    quote: colors.secondary,
    decision: colors.accent,
    closing: colors.primary,
    appendix: colors.border
  };
  return roles[pageRole] ?? colors.primary;
}

const PAGE_ROLE_PROFILES = Object.freeze({
  cover: { headlineScale: 1.04, contentScale: 0.98, contentShift: 0 },
  section: { headlineScale: 1.08, contentScale: 0.94, contentShift: 0.1 },
  "single-point": { headlineScale: 1.1, contentScale: 0.92, contentShift: 0.14 },
  evidence: { headlineScale: 0.98, contentScale: 1.02, contentShift: 0 },
  data: { headlineScale: 0.94, contentScale: 1.04, contentShift: 0.04 },
  comparison: { headlineScale: 0.98, contentScale: 1, contentShift: 0.04 },
  process: { headlineScale: 0.98, contentScale: 1.01, contentShift: 0.02 },
  architecture: { headlineScale: 0.98, contentScale: 1.02, contentShift: 0.03 },
  "case-study": { headlineScale: 1.02, contentScale: 0.98, contentShift: 0.08 },
  quote: { headlineScale: 1.06, contentScale: 0.96, contentShift: 0.1 },
  decision: { headlineScale: 1.06, contentScale: 0.96, contentShift: 0.12 },
  closing: { headlineScale: 1.03, contentScale: 0.97, contentShift: 0 },
  appendix: { headlineScale: 0.92, contentScale: 1.04, contentShift: 0 }
});

function applySemanticIntent(elements, slide, plan, slideIndex, tokens) {
  const variance = Number(plan.designIntent.dials.compositionVariance);
  const density = Number(plan.designIntent.dials.visualDensity);
  const energy = Number(plan.designIntent.dials.visualEnergy);
  const ambition = Number(plan.context.visualAmbition);
  const roleProfile = PAGE_ROLE_PROFILES[slide.pageRole] ?? PAGE_ROLE_PROFILES.evidence;
  const varianceAmplitude = ((variance - 50) / 50) * 0.055;
  const densityScale = 0.98 + density * 0.0004;
  const ambitionDelta = (ambition - 50) / 50;
  const ambitionScale = 1 + ambitionDelta * 0.025;
  const whitespaceScale = { compact: 1.02, balanced: 1, spacious: 0.97 }[slide.compositionIntent.whitespace] ?? 1;
  const next = elements.map((element, elementIndex) => {
    const result = structuredClone(element);
    if (result.role !== "connector") {
      const centerX = result.x + result.w / 2;
      const centerY = result.y + result.h / 2;
      const factor = densityScale * whitespaceScale * ambitionScale;
      result.w *= factor;
      result.h *= factor;
      const ambitionOffset = ambitionDelta * 0.07 * (((slideIndex + elementIndex) % 3) - 1);
      result.x = centerX - result.w / 2 + varianceAmplitude * (((slideIndex + elementIndex) % 3) - 1) + ambitionOffset;
      result.y = centerY - result.h / 2 + varianceAmplitude * (slideIndex % 2 ? 0.35 : -0.35);
      if (result.id === "headline") {
        result.style.fontSize = Number((Number(result.style.fontSize ?? tokens.typography.title.fontSize) * roleProfile.headlineScale).toFixed(2));
        result.w *= 1 + (roleProfile.headlineScale - 1) * 0.3;
      } else {
        result.x += roleProfile.contentShift;
        result.w *= roleProfile.contentScale;
      }
      if (result.type === "shape") {
        result.style.borderWidth = Number((0.7 + energy * 0.014).toFixed(2));
      } else if (result.type === "line") {
        result.style.width = Number((1.2 + energy * 0.018).toFixed(2));
      } else if (result.type === "text" && (result.id === "headline" || typographyRole(result) === "metric")) {
        result.style.fontSize = Number((Number(result.style.fontSize) + energy * 0.01).toFixed(2));
        result.style.fontWeight = Math.max(Number(result.style.fontWeight ?? 400), Math.round(580 + energy * 1.2));
        result.style.bold = result.style.fontWeight >= 600;
      }
    }
    return result;
  });

  const attentionKind = slide.attentionTarget.kind;
  for (const element of next) {
    element.style = { ...(element.style ?? {}) };
    if (attentionKind === "message" && element.id === "headline") {
      element.style.color = tokens.colors.primary;
      element.style.fontSize = Number(element.style.fontSize ?? tokens.typography.title.fontSize) + 2;
      element.style.fontWeight = Math.max(700, Number(element.style.fontWeight ?? 700));
      element.style.bold = true;
    } else if (attentionKind === "content" && element.type === "text" && !["headline", "section-eyebrow"].includes(element.id)) {
      element.style.color = tokens.colors.primary;
      element.style.fontWeight = Math.max(500, Number(element.style.fontWeight ?? 400));
    } else if (attentionKind === "data" && (element.type === "chart" || /^(?:value|metric|kpi|quadrant)/.test(element.id))) {
      element.style.color = tokens.colors.primary;
      if (element.type === "text") element.style.fontSize = Number(element.style.fontSize ?? tokens.typography.metric.fontSize) + 2;
    } else if (attentionKind === "diagram" && ["shape", "line", "diagram"].includes(element.type)) {
      if (element.type === "line") element.style.width = Number(element.style.width ?? 1) + 0.8;
      else {
        element.style.borderColor = tokens.colors.primary;
        element.style.line = tokens.colors.primary;
        element.style.borderWidth = Number(element.style.borderWidth ?? 1) + 0.8;
      }
    }
  }

  const emphasis = slide.compositionIntent.emphasis;
  if (emphasis === "message") {
    const headline = next.find((element) => element.id === "headline");
    if (headline) headline.w *= 1.02;
  } else if (emphasis === "evidence") {
    for (const element of next.filter((candidate) => candidate.type === "shape")) {
      element.style.borderWidth = Number(element.style.borderWidth ?? 1) + 0.35;
    }
  } else if (emphasis === "data") {
    for (const element of next.filter((candidate) => /^(?:value|metric|kpi|quadrant)/.test(candidate.id))) {
      element.style.fontWeight = Math.max(700, Number(element.style.fontWeight ?? 400));
      if (element.type === "text") element.style.fontSize = Number(element.style.fontSize ?? tokens.typography.metric.fontSize) + 1.5;
    }
  }

  const roleColor = pageRoleColor(slide.pageRole, tokens.colors);
  next.push(shape("role-marker", 6.45, 0.18, 0.45 + ambition * 0.012, 0.045 + energy * 0.00045, roleColor, roleColor));
  const roleMarker = next.at(-1);
  roleMarker.style = {
    fill: roleColor,
    line: energy >= 50 ? tokens.colors.accent : roleColor,
    backgroundColor: roleColor,
    borderColor: energy >= 50 ? tokens.colors.accent : roleColor,
    borderWidth: 0.5 + energy * 0.012
  };

  const section = plan.story.sections.find((candidate) => candidate.slideIds[0] === slide.id);
  if (section) {
    const typography = tokens.typography.caption;
    const semanticColors = semanticTextColors(tokens);
    next.push(text("section-eyebrow", section.title, 0.76, 0.14, 5.4, 0.24, {
      fontFamily: typography.fontFamily,
      fontFace: typography.fontFamily,
      fontSize: Number(typography.fontSize),
      fontWeight: 600,
      bold: true,
      color: semanticColors.muted,
      lineHeight: Number(typography.lineHeight)
    }));
  }

  const decisionIndex = plan.story.decisionPath.indexOf(slide.id);
  if (decisionIndex >= 0) {
    const marker = shape("decision-marker", 12.85 - decisionIndex * 0.28, 0.1, 0.16, 0.16, tokens.colors.accent, tokens.colors.accent);
    marker.shape = "ellipse";
    marker.style = {
      fill: tokens.colors.accent,
      line: tokens.colors.accent,
      backgroundColor: tokens.colors.accent,
      borderColor: tokens.colors.accent,
      borderWidth: 0
    };
    next.push(marker);
  }
  return next.map(boundedElement);
}

function assetSource(options, asset) {
  const source = options.assetSourceById instanceof Map
    ? options.assetSourceById.get(asset.id) ?? asset.provenance.sourceRef
    : options.assetSourceById?.[asset.id] ?? asset.provenance.sourceRef;
  return assertSafeAssetRuntimePath(source, `asset ${asset.id} runtime source`);
}

const MEDIA_ZONE = Object.freeze({ x: 8.25, y: 0.75, w: 4.38, h: 6 });
const MEDIA_GAP = 0.16;

function mediaImageElement(asset, options, geometry) {
  const sizingType = ["contain", "none"].includes(asset.cropPolicy) ? "contain" : "cover";
  return boundedElement({
    type: "image",
    id: `asset-${asset.id}`,
    assetId: asset.id,
    src: assetSource(options, asset),
    ...geometry,
    focalPoint: asset.focalPoint,
    cropPolicy: asset.cropPolicy,
    alt: asset.altText,
    altText: asset.altText,
    sizing: { type: sizingType }
  });
}

function applyVisualAssets(elements, slide, assets, options, assetIntensity) {
  const visualAssets = slide.assetIds
    .map((assetId) => assets.find((asset) => asset.id === assetId))
    .filter((asset) => asset && VISUAL_ASSET_KINDS.has(asset.kind));
  if (visualAssets.length === 0) return elements;

  const heroId = slide.attentionTarget.kind === "asset" ? slide.attentionTarget.ref : visualAssets[0].id;
  const hero = visualAssets.find((asset) => asset.id === heroId) ?? visualAssets[0];
  const supports = visualAssets.filter((asset) => asset.id !== hero.id);
  const intensity = clamp(assetIntensity, 0, 100);
  const zonePadding = 0.18 - intensity * 0.0012;
  const frame = {
    x: MEDIA_ZONE.x + zonePadding,
    y: MEDIA_ZONE.y + zonePadding,
    w: MEDIA_ZONE.w - zonePadding * 2,
    h: MEDIA_ZONE.h - zonePadding * 2
  };
  const contentLeft = 0.55;
  const contentRight = MEDIA_ZONE.x - 0.32;
  const reflowElements = elements.filter((element) => element.role !== "connector"
    && !["role-marker", "section-eyebrow", "decision-marker"].includes(element.id));
  const sourceLeft = Math.min(...reflowElements.map((element) => element.x));
  const sourceRight = Math.max(...reflowElements.map((element) => element.x + element.w));
  const contentScale = Math.min(1, (contentRight - contentLeft) / Math.max(0.01, sourceRight - sourceLeft));
  const native = elements.map((element) => {
    if (element.role === "connector" || ["role-marker", "section-eyebrow", "decision-marker"].includes(element.id)) return element;
    const next = structuredClone(element);
    next.x = contentLeft + (next.x - sourceLeft) * contentScale;
    next.w *= contentScale;
    return boundedElement(next);
  });

  if (supports.length === 0) {
    return [...native, mediaImageElement(hero, options, frame)];
  }

  const heroRatio = 0.55 + intensity * 0.0008;
  const heroHeight = (frame.h - MEDIA_GAP) * heroRatio;
  const supportY = frame.y + heroHeight + MEDIA_GAP;
  const supportHeight = frame.h - heroHeight - MEDIA_GAP;
  const columns = supports.length === 1 ? 1 : 2;
  const rows = Math.ceil(supports.length / columns);
  const cellWidth = (frame.w - MEDIA_GAP * (columns - 1)) / columns;
  const cellHeight = (supportHeight - MEDIA_GAP * (rows - 1)) / rows;
  const imageElements = [mediaImageElement(hero, options, {
    x: frame.x,
    y: frame.y,
    w: frame.w,
    h: heroHeight
  })];
  supports.forEach((asset, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    imageElements.push(mediaImageElement(asset, options, {
      x: frame.x + column * (cellWidth + MEDIA_GAP),
      y: supportY + row * (cellHeight + MEDIA_GAP),
      w: cellWidth,
      h: cellHeight
    }));
  });
  return [...native, ...imageElements];
}

function compileCover(content) {
  return [
    text("headline", content.headline, 0.82, 1.25, 8.5, 1.25, { fontSize: 42, bold: true, color: "#111827" }),
    text("subtitle", content.subtitle, 0.86, 2.72, 7.2, 0.64, { fontSize: 18, color: "#374151" }),
    shape("cover-accent", 0.86, 6.45, 3.35, 0.09, "#2563EB", "#2563EB")
  ];
}

function compileArchitecture(content) {
  const layers = content.layers.slice(0, 4);
  return [title(content.headline), ...layers.flatMap((entry, index) => {
    const x = 1.3 + index * 0.32;
    const y = 1.42 + index * 1.16;
    const w = 10.6 - index * 0.64;
    return [shape(`layer-${index}`, x, y, 0.12, 0.82, index % 2 ? "#60A5FA" : "#2563EB"), text(`layer-label-${index}`, itemText(entry), x + 0.38, y + 0.2, w - 0.5, 0.36, { fontSize: 16, bold: true, color: "#1E3A8A" })];
  })];
}

function compileComparison(content) {
  return [title(content.headline), shape("left-panel", 0.76, 1.35, 5.55, 4.9, "#EFF6FF"), shape("right-panel", 7.02, 1.35, 5.55, 4.9, "#FFF7ED", "#EA580C"),
    text("left-title", content.primary.title, 1.05, 1.72, 4.9, 0.5, { fontSize: 21, bold: true }),
    text("left-items", content.primary.items, 1.05, 2.42, 4.9, 2.9, { fontSize: 16 }),
    text("right-title", content.secondary.title, 7.32, 1.72, 4.9, 0.5, { fontSize: 21, bold: true }),
    text("right-items", content.secondary.items, 7.32, 2.42, 4.9, 2.9, { fontSize: 16 })];
}

function compileProcess(content) {
  const steps = content.steps.slice(0, 5);
  return [title(content.headline), ...steps.flatMap((entry, index) => {
    const x = 0.72 + index * 2.5;
    return [shape(`step-${index}`, x + 0.5, 2.08, 0.86, 0.86, "#EEF2FF"), text(`step-label-${index}`, itemText(entry), x + 0.08, 3.35, 1.7, 0.72, { fontSize: 15, bold: true, align: "center" }), ...(index < steps.length - 1 ? [line(`connector-${index}`, x + 1.36, 2.5, 1.14, 0.01, "#2563EB", { sourceId: `step-${index}`, targetId: `step-${index + 1}`, sourceAnchor: "auto", targetAnchor: "auto", route: "straight", endArrowType: "triangle" })] : [])];
  })];
}

function compileDashboard(content) {
  const metrics = content.metrics.slice(0, 4);
  return [title(content.headline), ...metrics.flatMap((entry, index) => {
    const x = 0.78 + (index % 2) * 6.2;
    const y = 1.36 + Math.floor(index / 2) * 2.55;
    return [shape(`kpi-card-${index}`, x, y, 5.55, 2.0, index % 2 ? "#ECFDF5" : "#EFF6FF"), text(`value-${index}`, entry.value, x + 0.3, y + 0.32, 2.1, 0.66, { fontSize: 30, bold: true, color: "#1D4ED8" }), text(`label-${index}`, entry.label, x + 2.42, y + 0.4, 2.7, 0.5, { fontSize: 16, bold: true })];
  })];
}

function compileQuote(content) {
  return [shape("quote-mark", 0.9, 1.25, 0.2, 4.5, "#2563EB", "#2563EB"), text("quote", `“${content.quote}”`, 1.55, 1.36, 10.25, 3.35, { fontSize: 31, bold: true, color: "#111827", italic: true }), text("attribution", `— ${content.attribution}`, 7.2, 5.25, 4.6, 0.5, { fontSize: 16, color: "#4B5563", align: "right" })];
}

function compileMatrix(content) {
  const labels = content.quadrants.slice(0, 4);
  return [title(content.headline), line("axis-x", 2.0, 3.75, 9.3, 0.01, "#111827"), line("axis-y", 6.65, 1.36, 0.01, 4.8, "#111827"),
    ...labels.map((entry, index) => text(`quadrant-${index}`, itemText(entry), index % 2 ? 7.2 : 2.6, index < 2 ? 2.0 : 4.45, 3.2, 0.65, { fontSize: 18, bold: true, align: "center" })),
    text("x-label", content.xAxis, 9.6, 6.32, 2.2, 0.36, { fontSize: 12 }), text("y-label", content.yAxis, 0.8, 1.25, 1.2, 0.36, { fontSize: 12 })];
}

function compileClosing(content) {
  return [text("headline", content.headline, 1.25, 1.75, 10.85, 1.25, { fontSize: 39, bold: true, color: "#FFFFFF", align: "center" }), text("call-to-action", content.callToAction, 2.3, 3.4, 8.75, 0.72, { fontSize: 20, color: "#BFDBFE", align: "center" }), shape("closing-accent", 5.2, 5.28, 2.9, 0.1, "#60A5FA", "#60A5FA")];
}

function schemaValidator(family) {
  const schema = {
    $defs: DECK_PLAN_SCHEMA.$defs,
    $ref: `#/$defs/${family}Content`
  };
  return (content = {}) => {
    const result = validateJsonSchema(content, schema);
    return result.valid ? null : `${family} schema: ${result.errors.map((error) => `${error.path} ${error.message}`).join("; ")}`;
  };
}

const REGISTRY = Object.freeze({
  cover: { schema: DECK_PLAN_SCHEMA.$defs.coverContent, validate: schemaValidator("cover"), compile: compileCover },
  architecture: { schema: DECK_PLAN_SCHEMA.$defs.architectureContent, validate: schemaValidator("architecture"), compile: compileArchitecture },
  comparison: { schema: DECK_PLAN_SCHEMA.$defs.comparisonContent, validate: schemaValidator("comparison"), compile: compileComparison },
  process: { schema: DECK_PLAN_SCHEMA.$defs.processContent, validate: schemaValidator("process"), compile: compileProcess },
  dashboard: { schema: DECK_PLAN_SCHEMA.$defs.dashboardContent, validate: schemaValidator("dashboard"), compile: compileDashboard },
  quote: { schema: DECK_PLAN_SCHEMA.$defs.quoteContent, validate: schemaValidator("quote"), compile: compileQuote },
  matrix: { schema: DECK_PLAN_SCHEMA.$defs.matrixContent, validate: schemaValidator("matrix"), compile: compileMatrix },
  closing: { schema: DECK_PLAN_SCHEMA.$defs.closingContent, validate: schemaValidator("closing"), compile: compileClosing }
});

export const ADVERTISED_ARCHETYPES = Object.freeze(Object.keys(REGISTRY));
export const getArchetypeRegistry = () => ({ ...REGISTRY });

function duplicateIdErrors(items, label) {
  const seen = new Set();
  const errors = [];
  for (const item of items) {
    if (seen.has(item.id)) errors.push(`${label} id "${item.id}" must be unique`);
    seen.add(item.id);
  }
  return errors;
}

function validateSemanticRules(plan) {
  const errors = [
    ...duplicateIdErrors(plan.slides, "slide"),
    ...duplicateIdErrors(plan.assets, "asset")
  ];
  const slideIds = new Set(plan.slides.map((slide) => slide.id));
  const assetIds = new Set(plan.assets.map((asset) => asset.id));
  const assetsById = new Map(plan.assets.map((asset) => [asset.id, asset]));
  const suites = new Set();

  for (const asset of plan.assets) {
    const provenance = asset.provenance;
    if (provenance.rights.status === "allowed-with-attribution"
      && (typeof provenance.rights.attribution !== "string" || provenance.rights.attribution.trim() === "")) {
      errors.push(`asset ${asset.id} rights attribution is required for allowed-with-attribution`);
    }
    if (provenance.origin === "generated") {
      if (!provenance.generation
        || typeof provenance.generation.model !== "string" || provenance.generation.model.trim() === ""
        || typeof provenance.generation.promptSummary !== "string" || provenance.generation.promptSummary.trim() === "") {
        errors.push(`asset ${asset.id} generated provenance requires generation model and promptSummary`);
      }
    } else if (provenance.generation !== undefined) {
      errors.push(`asset ${asset.id} non-generated provenance must not include generation`);
    }
    if (provenance.sourceUrl !== undefined && !/^https?:\/\/\S+$/i.test(provenance.sourceUrl)) {
      errors.push(`asset ${asset.id} provenance sourceUrl must be an http(s) URL`);
    }
  }

  for (const target of plan.context.targetSuites) {
    if (suites.has(target.suite)) errors.push(`context.targetSuites suite "${target.suite}" must be unique`);
    suites.add(target.suite);
  }
  if (!plan.context.targetSuites.some((target) => target.suite === "libreoffice" && target.required === true)) {
    errors.push("context.targetSuites must include libreoffice with required true");
  }

  plan.story.sections.forEach((section, sectionIndex) => {
    section.slideIds.forEach((slideId) => {
      if (!slideIds.has(slideId)) errors.push(`story.sections[${sectionIndex}] references unknown slide "${slideId}"`);
    });
  });
  plan.story.decisionPath.forEach((slideId) => {
    if (!slideIds.has(slideId)) errors.push(`story.decisionPath references unknown slide "${slideId}"`);
  });

  plan.slides.forEach((slide, slideIndex) => {
    const seenSlideAssets = new Set();
    for (const assetId of slide.assetIds) {
      if (seenSlideAssets.has(assetId)) errors.push(`slides[${slideIndex}].assetIds must be unique; duplicate "${assetId}"`);
      seenSlideAssets.add(assetId);
    }
    const visualAssets = slide.assetIds
      .map((assetId) => assetsById.get(assetId))
      .filter((asset) => asset && VISUAL_ASSET_KINDS.has(asset.kind));
    if (visualAssets.length > MAX_VISUAL_ASSETS_PER_SLIDE) {
      errors.push(`slides[${slideIndex}].assetIds must reference at most ${MAX_VISUAL_ASSETS_PER_SLIDE} visual assets`);
    }
    if (slide.attentionTarget.kind === "asset") {
      const attentionAsset = assetsById.get(slide.attentionTarget.ref);
      if (!attentionAsset) {
        errors.push(`slides[${slideIndex}].attentionTarget references unknown asset "${slide.attentionTarget.ref}"`);
      } else if (!slide.assetIds.includes(attentionAsset.id)) {
        errors.push(`slides[${slideIndex}].attentionTarget asset "${attentionAsset.id}" must belong to slide.assetIds`);
      } else if (!VISUAL_ASSET_KINDS.has(attentionAsset.kind)) {
        errors.push(`slides[${slideIndex}].attentionTarget asset "${attentionAsset.id}" must reference a visual renderable asset`);
      }
    }
    if (slide.compositionIntent.emphasis === "asset" && visualAssets.length === 0) {
      errors.push(`slides[${slideIndex}].compositionIntent emphasis "asset" requires at least one visual asset`);
    }
    slide.assetIds.forEach((assetId) => {
      if (!assetIds.has(assetId)) errors.push(`slides[${slideIndex}].assetIds references unknown asset "${assetId}"`);
    });
    if (!slide.routePolicy.allowed.includes(slide.routePolicy.preferred)) {
      errors.push(`slides[${slideIndex}].routePolicy preferred must belong to allowed`);
    }
    if (!slide.routePolicy.allowed.includes("native")) {
      errors.push(`slides[${slideIndex}].routePolicy.allowed must include native`);
    }
  });

  for (let index = 2; index < plan.slides.length; index += 1) {
    const strategy = plan.slides[index].compositionIntent.strategy;
    if (strategy === plan.slides[index - 1].compositionIntent.strategy
      && strategy === plan.slides[index - 2].compositionIntent.strategy) {
      errors.push(`slides[${index - 2}..${index}] repeat the same composition strategy for three consecutive slides`);
    }
  }
  return errors;
}

export function validateDeckPlan(plan) {
  if (plan?.version === "0.1.0") {
    return { valid: false, errors: ["deck.plan 0.1.0 is retired; expected 0.2.0"] };
  }
  const structural = validateJsonSchema(plan, DECK_PLAN_SCHEMA);
  if (!structural.valid) {
    return {
      valid: false,
      errors: structural.errors.map((error) => `${error.path} ${error.message}`)
    };
  }
  const errors = validateSemanticRules(plan);
  return { valid: errors.length === 0, errors };
}

export function compileLegacyDeckPlan(plan, options = {}) {
  const validation = validateDeckPlan(plan);
  if (!validation.valid) throw new Error(`deck.plan invalid: ${validation.errors.join("; ")}`);
  const resolvedDesign = resolvedDeckPlanDesign(options);
  const designTokens = resolvedDesign.tokens;
  const metricFont = resolveMetricFont(designTokens, plan.designIntent.locks);
  return {
    version: "0.2.0",
    metadata: {
      mode: "creative",
      inputType: "text",
      qualityProfile: "creative",
      designIntent: {
        source: "deck.plan",
        ...structuredClone(plan.designIntent),
        read: plan.designIntent.designRead,
        visibleGrid: plan.designIntent.composition.visibleGrid,
        intentOverride: structuredClone(plan.designIntent.locks),
        qualityProfile: plan.context.qualityProfile,
        context: structuredClone(plan.context),
        story: structuredClone(plan.story),
        typographyResolution: { metricFont: structuredClone(metricFont) },
        ...(options.designSystemSelection ? { designSystemSelection: structuredClone(options.designSystemSelection) } : {})
      },
      generator: { name: "deck-plan.mjs" }
    },
    designSystem: { source: resolvedDesign.source, name: resolvedDesign.name },
    deck: {
      title: plan.context.title,
      language: plan.context.language,
      editabilityFloor: plan.context.editabilityFloor,
      size: { preset: "wide", width: W, height: H, unit: "in" }
    },
    assets: plan.assets.map((asset) => ({
      ...structuredClone(asset),
      src: assetSource(options, asset),
      ...structuredClone(asset.provenance)
    })),
    slides: plan.slides.map((slide, slideIndex) => {
      const family = slide.contentModel.kind;
      const strategy = slide.compositionIntent.strategy;
      const baseElements = applyCompositionStrategy(REGISTRY[family].compile(slide.contentModel.data), strategy);
      const themedElements = applyDesignTokens(baseElements, designTokens, family, metricFont);
      const semanticElements = applySemanticIntent(themedElements, slide, plan, slideIndex, designTokens);
      const visualElements = applyVisualAssets(semanticElements, slide, plan.assets, options, plan.context.assetIntensity);
      return {
        id: slide.id,
        type: family,
        pageRole: PAGE_ROLE_MAP[slide.pageRole] ?? slide.pageRole,
        semanticPageRole: slide.pageRole,
        compositionStrategy: strategy,
        attentionTarget: structuredClone(slide.attentionTarget),
        compositionIntent: structuredClone(slide.compositionIntent),
        routePolicy: structuredClone(slide.routePolicy),
        title: slide.message,
        notes: slide.message,
        background: { type: "solid", color: designTokens.colors.background },
        elements: resolveSemanticConnectors(visualElements.map(boundedElement))
      };
    })
  };
}

const BRIEF_DOMAIN_INTENT = Object.freeze({
  business: { designRead: "Confident business decision story with disciplined hierarchy.", dials: { compositionVariance: 50, visualDensity: 55, visualEnergy: 55 } },
  editorial: { designRead: "Editorial narrative with expressive hierarchy and measured pacing.", dials: { compositionVariance: 60, visualDensity: 45, visualEnergy: 50 } },
  technical: { designRead: "Structured technical explanation with visible system logic.", dials: { compositionVariance: 50, visualDensity: 60, visualEnergy: 45 } },
  "public-sector": { designRead: "Accessible civic communication with clear evidence and sequence.", dials: { compositionVariance: 40, visualDensity: 50, visualEnergy: 35 } },
  data: { designRead: "Dense data-led analysis with explicit comparison and hierarchy.", dials: { compositionVariance: 50, visualDensity: 80, visualEnergy: 50 } },
  narrative: { designRead: "High-energy narrative with a decisive opening or close.", dials: { compositionVariance: 70, visualDensity: 40, visualEnergy: 80 } }
});

function fixtureContent(family, brief) {
  const headline = brief;
  const content = {
    cover: { headline, subtitle: "A concise evidence-led briefing" },
    architecture: { headline, layers: ["Intent", "System", "Execution"] },
    comparison: { headline, primary: { title: "Option A", items: ["Benefit", "Constraint"] }, secondary: { title: "Option B", items: ["Benefit", "Constraint"] } },
    process: { headline, steps: ["Frame", "Decide", "Deliver"] },
    dashboard: { headline, metrics: [{ label: "Current", value: "72" }, { label: "Target", value: "85" }, { label: "Delta", value: "+13" }] },
    quote: { quote: brief, attribution: "Briefing evidence" },
    matrix: { headline, xAxis: "Effort", yAxis: "Impact", quadrants: ["Maintain", "Prioritize", "Explore", "Accelerate"] },
    closing: { headline, callToAction: "Align on the next decision." }
  };
  return content[family];
}

function familyFromIntent(intent) {
  const normalized = String(intent ?? "").trim().toLowerCase();
  const rules = [
    [/metric/, "dashboard"],
    [/compar|option/, "comparison"],
    [/quot/, "quote"],
    [/architect/, "architecture"],
    [/process|roadmap/, "process"],
    [/matrix|prioriti/, "matrix"],
    [/call to action|clos/, "closing"],
    [/opening|story/, "cover"]
  ];
  return rules.find(([pattern]) => pattern.test(normalized))?.[1] ?? null;
}

const FIXTURE_SLIDE_INTENT = Object.freeze({
  cover: { pageRole: "cover", strategy: "focus", whitespace: "spacious", emphasis: "message" },
  architecture: { pageRole: "architecture", strategy: "structural", whitespace: "balanced", emphasis: "evidence" },
  comparison: { pageRole: "comparison", strategy: "split", whitespace: "balanced", emphasis: "evidence" },
  process: { pageRole: "process", strategy: "editorial", whitespace: "balanced", emphasis: "evidence" },
  dashboard: { pageRole: "data", strategy: "data-led", whitespace: "compact", emphasis: "data" },
  quote: { pageRole: "quote", strategy: "minimal-whitespace", whitespace: "spacious", emphasis: "message" },
  matrix: { pageRole: "comparison", strategy: "asymmetric", whitespace: "balanced", emphasis: "data" },
  closing: { pageRole: "closing", strategy: "immersive", whitespace: "spacious", emphasis: "message" }
});

export function buildPlanFromBriefFixture(fixture) {
  const intent = BRIEF_DOMAIN_INTENT[fixture?.domain];
  const family = familyFromIntent(fixture?.input?.intent);
  if (!intent || !REGISTRY[family]) throw new Error(`unsupported brief fixture ${fixture?.id ?? "(unknown)"}`);
  const slideId = `slide-${fixture.id}-1`;
  const slideIntent = FIXTURE_SLIDE_INTENT[family];
  return {
    version: "0.2.0",
    context: {
      title: fixture.brief,
      language: fixture.language,
      audience: { primary: fixture.input.audience || `${fixture.domain} decision makers`, knowledgeLevel: "mixed" },
      decisionGoal: fixture.brief,
      durationMinutes: 5,
      environment: { viewingMode: "desktop", presentedOrReadAlone: "read-alone" },
      tone: "Clear, concise, and evidence-led",
      mustRemember: [fixture.brief],
      brand: { references: [], antiReferences: [] },
      qualityProfile: "standard",
      targetSuites: [{ suite: "libreoffice", required: true }],
      editabilityFloor: 4,
      assetIntensity: 0,
      visualAmbition: intent.dials.visualEnergy
    },
    designIntent: {
      designRead: intent.designRead,
      typography: "Clear sans-serif hierarchy",
      palette: "Neutral foundation with one contextual accent",
      material: "Flat native PowerPoint geometry",
      imagery: "No external imagery required",
      composition: { direction: "One decisive native composition", visibleGrid: false },
      dials: { ...intent.dials },
      locks: { sourceLocked: false, brandLocked: false, protectedTokens: [], protectedAssets: [] }
    },
    story: {
      narrativeBeats: ["Frame", "Explain", "Decide"],
      sections: [{ id: `section-${fixture.id}`, title: fixture.brief, slideIds: [slideId] }],
      decisionPath: [slideId]
    },
    assets: [],
    slides: [{
      id: slideId,
      pageRole: slideIntent.pageRole,
      message: fixture.brief,
      contentModel: { kind: family, data: fixtureContent(family, fixture.brief) },
      attentionTarget: { kind: "message", ref: `brief:${fixture.id}` },
      compositionIntent: {
        strategy: slideIntent.strategy,
        whitespace: slideIntent.whitespace,
        emphasis: slideIntent.emphasis
      },
      assetIds: [],
      routePolicy: { preferred: "native", allowed: ["native"], fullSlideRaster: false }
    }]
  };
}

export function geometrySignature(slide) {
  return slide.elements.map((element) => `${element.type}:${Number(element.x).toFixed(2)},${Number(element.y).toFixed(2)},${Number(element.w).toFixed(2)},${Number(element.h).toFixed(2)}`).join("|");
}
