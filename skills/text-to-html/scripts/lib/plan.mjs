import { basename, dirname, extname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { fail } from "./errors.mjs";
import { assertRegularFileInside, normalizeRelativePath, readJson, sha256File, slugify } from "./utils.mjs";

export const PLAN_VERSION = "1.0.0";
export const SLIDE_TYPES = new Set([
  "cover",
  "statement",
  "bullets",
  "comparison",
  "metrics",
  "process",
  "timeline",
  "quote",
  "image",
  "closing"
]);
export const FACT_STATUSES = new Set(["provided", "verified", "inferred", "unverified", "placeholder"]);
const SOURCE_KINDS = new Set(["user-input", "file", "url", "assumption", "placeholder"]);
const RIGHTS = new Set(["user-provided", "project-owned", "licensed", "public-domain", "unknown"]);
const REVIEW_CHECKS = ["positioning", "sourceIntegrity", "narrative", "oneMessagePerSlide", "visualIntent"];

function requireObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("E_PLAN_SCHEMA", `${path} must be an object`, { path });
  }
  return value;
}

function requireArray(value, path, options = {}) {
  if (!Array.isArray(value)) fail("E_PLAN_SCHEMA", `${path} must be an array`, { path });
  if (options.min !== undefined && value.length < options.min) {
    fail("E_PLAN_SCHEMA", `${path} must contain at least ${options.min} item(s)`, { path });
  }
  if (options.max !== undefined && value.length > options.max) {
    fail("E_PLAN_SCHEMA", `${path} must contain at most ${options.max} item(s)`, { path });
  }
  return value;
}

function requireString(value, path, options = {}) {
  if (typeof value !== "string" || value.trim().length < (options.min ?? 1)) {
    fail("E_PLAN_SCHEMA", `${path} must be a non-empty string`, { path });
  }
  if (options.max && value.length > options.max) {
    fail("E_PLAN_SCHEMA", `${path} exceeds ${options.max} characters`, { path });
  }
  return value;
}

function requireUnique(items, select, path) {
  const seen = new Set();
  for (const [index, item] of items.entries()) {
    const value = select(item);
    if (seen.has(value)) fail("E_DUPLICATE_ID", `${path} contains duplicate value ${value}`, { path: `${path}[${index}]` });
    seen.add(value);
  }
}

function validateClaim(claim, path, sourceIds) {
  requireObject(claim, path);
  requireString(claim.text, `${path}.text`, { max: 240 });
  if (!FACT_STATUSES.has(claim.factStatus)) {
    fail("E_FACT_LABEL", `${path}.factStatus must be one of ${[...FACT_STATUSES].join(", ")}`, { path: `${path}.factStatus` });
  }
  const refs = requireArray(claim.sourceRefs ?? [], `${path}.sourceRefs`, { max: 8 });
  for (const [index, sourceRef] of refs.entries()) {
    if (!sourceIds.has(sourceRef)) fail("E_SOURCE_REF", `Unknown source ${sourceRef}`, { path: `${path}.sourceRefs[${index}]` });
  }
  if (["provided", "verified"].includes(claim.factStatus) && refs.length === 0) {
    fail("E_SOURCE_REF", `${path} requires a source reference for ${claim.factStatus} content`, { path: `${path}.sourceRefs` });
  }
}

function validateClaims(items, path, sourceIds, options = {}) {
  const claims = requireArray(items, path, options);
  for (const [index, claim] of claims.entries()) validateClaim(claim, `${path}[${index}]`, sourceIds);
  return claims;
}

function validateSlideContent(slide, path, sourceIds, assetIds) {
  const content = requireObject(slide.content, `${path}.content`);
  switch (slide.type) {
    case "cover":
      if (content.subtitle !== undefined) requireString(content.subtitle, `${path}.content.subtitle`, { max: 220 });
      break;
    case "statement":
      validateClaim(content.statement, `${path}.content.statement`, sourceIds);
      break;
    case "bullets":
      validateClaims(content.points, `${path}.content.points`, sourceIds, { min: 1, max: 3 });
      break;
    case "comparison":
      for (const side of ["left", "right"]) {
        const group = requireObject(content[side], `${path}.content.${side}`);
        requireString(group.label, `${path}.content.${side}.label`, { max: 80 });
        validateClaims(group.points, `${path}.content.${side}.points`, sourceIds, { min: 1, max: 3 });
      }
      break;
    case "metrics": {
      const metrics = requireArray(content.metrics, `${path}.content.metrics`, { min: 1, max: 3 });
      for (const [index, metric] of metrics.entries()) {
        const metricPath = `${path}.content.metrics[${index}]`;
        requireObject(metric, metricPath);
        requireString(metric.value, `${metricPath}.value`, { max: 28 });
        requireString(metric.label, `${metricPath}.label`, { max: 70 });
        if (metric.detail !== undefined) requireString(metric.detail, `${metricPath}.detail`, { max: 130 });
        validateClaim(metric.claim, `${metricPath}.claim`, sourceIds);
      }
      break;
    }
    case "process": {
      const steps = requireArray(content.steps, `${path}.content.steps`, { min: 2, max: 5 });
      for (const [index, step] of steps.entries()) {
        const stepPath = `${path}.content.steps[${index}]`;
        requireObject(step, stepPath);
        requireString(step.label, `${stepPath}.label`, { max: 50 });
        validateClaim(step.claim, `${stepPath}.claim`, sourceIds);
      }
      break;
    }
    case "timeline": {
      const milestones = requireArray(content.milestones, `${path}.content.milestones`, { min: 2, max: 5 });
      for (const [index, milestone] of milestones.entries()) {
        const itemPath = `${path}.content.milestones[${index}]`;
        requireObject(milestone, itemPath);
        requireString(milestone.when, `${itemPath}.when`, { max: 40 });
        requireString(milestone.label, `${itemPath}.label`, { max: 60 });
        validateClaim(milestone.claim, `${itemPath}.claim`, sourceIds);
      }
      break;
    }
    case "quote":
      validateClaim(content.quote, `${path}.content.quote`, sourceIds);
      requireString(content.attribution, `${path}.content.attribution`, { max: 120 });
      break;
    case "image":
      requireString(content.assetId, `${path}.content.assetId`);
      if (!assetIds.has(content.assetId)) fail("E_LAYOUT_CONTENT", `Unknown image asset ${content.assetId}`, { path: `${path}.content.assetId` });
      validateClaim(content.caption, `${path}.content.caption`, sourceIds);
      break;
    case "closing":
      validateClaim(content.action, `${path}.content.action`, sourceIds);
      if (content.summary !== undefined) validateClaims(content.summary, `${path}.content.summary`, sourceIds, { max: 3 });
      break;
    default:
      fail("E_LAYOUT_CONTENT", `Unsupported slide type ${slide.type}`, { path: `${path}.type` });
  }
}

export async function validatePlan(value, options = {}) {
  const plan = requireObject(value, "$");
  if (plan.version !== PLAN_VERSION) {
    fail("E_PLAN_VERSION", `Unsupported plan version ${plan.version ?? "missing"}; supported=${PLAN_VERSION}`, { path: "$.version" });
  }
  const deck = requireObject(plan.deck, "$.deck");
  requireString(deck.id, "$.deck.id", { max: 128 });
  requireString(deck.title, "$.deck.title", { max: 180 });
  requireString(deck.language, "$.deck.language", { max: 20 });
  const size = requireObject(deck.size, "$.deck.size");
  if (size.width !== 1280 || size.height !== 720 || size.unit !== "px") {
    fail("E_PLAN_SCHEMA", "$.deck.size must be exactly 1280×720 px", { path: "$.deck.size" });
  }

  const positioning = requireObject(plan.positioning, "$.positioning");
  for (const key of ["statement", "goal", "audience", "scenario", "coreConclusion", "desiredAction", "deliveryMode"]) {
    requireString(positioning[key], `$.positioning.${key}`, { max: key === "statement" ? 360 : 180 });
  }
  if (!Number.isFinite(positioning.durationMinutes) || positioning.durationMinutes <= 0) {
    fail("E_PLAN_SCHEMA", "$.positioning.durationMinutes must be positive", { path: "$.positioning.durationMinutes" });
  }
  if (!Number.isInteger(positioning.targetSlideCount) || positioning.targetSlideCount <= 0) {
    fail("E_PLAN_SCHEMA", "$.positioning.targetSlideCount must be a positive integer", { path: "$.positioning.targetSlideCount" });
  }

  const assumptions = requireArray(plan.assumptions, "$.assumptions");
  requireUnique(assumptions, (item) => item?.id, "$.assumptions");
  for (const [index, assumption] of assumptions.entries()) {
    const path = `$.assumptions[${index}]`;
    requireObject(assumption, path);
    requireString(assumption.id, `${path}.id`);
    requireString(assumption.text, `${path}.text`, { max: 240 });
    if (!["low", "medium", "high"].includes(assumption.impact)) {
      fail("E_PLAN_SCHEMA", `${path}.impact must be low|medium|high`, { path: `${path}.impact` });
    }
    if (!["inferred", "confirmed", "rejected"].includes(assumption.status)) {
      fail("E_PLAN_SCHEMA", `${path}.status must be inferred|confirmed|rejected`, { path: `${path}.status` });
    }
    if (assumption.status === "rejected" || (assumption.status === "inferred" && assumption.impact === "high")) {
      fail("E_HOST_REVIEW_REQUIRED", `${path} must be resolved before approval`, { path });
    }
  }

  const sources = requireArray(plan.sources, "$.sources", { min: 1 });
  requireUnique(sources, (item) => item?.id, "$.sources");
  const sourceIds = new Set();
  for (const [index, source] of sources.entries()) {
    const path = `$.sources[${index}]`;
    requireObject(source, path);
    requireString(source.id, `${path}.id`);
    requireString(source.label, `${path}.label`, { max: 200 });
    if (!SOURCE_KINDS.has(source.kind)) fail("E_PLAN_SCHEMA", `Invalid source kind ${source.kind}`, { path: `${path}.kind` });
    if (!FACT_STATUSES.has(source.factStatus)) fail("E_PLAN_SCHEMA", `Invalid source factStatus ${source.factStatus}`, { path: `${path}.factStatus` });
    if (source.locator !== undefined) requireString(source.locator, `${path}.locator`, { max: 1000 });
    sourceIds.add(source.id);
  }

  const assets = requireArray(plan.assets, "$.assets");
  requireUnique(assets, (item) => item?.id, "$.assets");
  const assetIds = new Set();
  for (const [index, asset] of assets.entries()) {
    const path = `$.assets[${index}]`;
    requireObject(asset, path);
    requireString(asset.id, `${path}.id`);
    asset.path = normalizeRelativePath(asset.path, `${path}.path`);
    requireString(asset.mime, `${path}.mime`);
    requireString(asset.alt, `${path}.alt`, { max: 240 });
    if (!RIGHTS.has(asset.rights)) fail("E_PLAN_SCHEMA", `Invalid asset rights ${asset.rights}`, { path: `${path}.rights` });
    if (asset.sourceRef !== undefined && !sourceIds.has(asset.sourceRef)) {
      fail("E_SOURCE_REF", `Unknown asset source ${asset.sourceRef}`, { path: `${path}.sourceRef` });
    }
    if (options.planDirectory) {
      await assertRegularFileInside(options.planDirectory, asset.path, `${path}.path`);
    }
    assetIds.add(asset.id);
  }

  const narrative = requireObject(plan.narrative, "$.narrative");
  requireString(narrative.framework, "$.narrative.framework", { max: 100 });
  const chapters = requireArray(narrative.chapters, "$.narrative.chapters", { min: 1 });
  requireUnique(chapters, (item) => item?.id, "$.narrative.chapters");

  const slides = requireArray(plan.slides, "$.slides", { min: 1 });
  requireUnique(slides, (item) => item?.id, "$.slides");
  requireUnique(slides, (item) => item?.order, "$.slides");
  if (positioning.targetSlideCount !== slides.length) {
    fail("E_PLAN_SCHEMA", "$.positioning.targetSlideCount must equal the slide count", { path: "$.positioning.targetSlideCount" });
  }
  const slideIds = new Set(slides.map((slide) => slide?.id));
  for (const [index, slide] of slides.entries()) {
    const path = `$.slides[${index}]`;
    requireObject(slide, path);
    requireString(slide.id, `${path}.id`);
    if (slide.order !== index + 1) fail("E_SLIDE_ORDER", `${path}.order must be ${index + 1}`, { path: `${path}.order` });
    if (!SLIDE_TYPES.has(slide.type)) fail("E_LAYOUT_CONTENT", `Unsupported slide type ${slide.type}`, { path: `${path}.type` });
    requireString(slide.title, `${path}.title`, { max: 120 });
    requireString(slide.coreMessage, `${path}.coreMessage`, { max: 260 });
    requireString(slide.visual, `${path}.visual`, { max: 240 });
    requireString(slide.transition, `${path}.transition`, { max: 240 });
    requireString(slide.notes, `${path}.notes`, { max: 2000 });
    const refs = requireArray(slide.sourceRefs, `${path}.sourceRefs`, { max: 12 });
    for (const [sourceIndex, sourceRef] of refs.entries()) {
      if (!sourceIds.has(sourceRef)) fail("E_SOURCE_REF", `Unknown source ${sourceRef}`, { path: `${path}.sourceRefs[${sourceIndex}]` });
    }
    validateSlideContent(slide, path, sourceIds, assetIds);
  }

  for (const [index, chapter] of chapters.entries()) {
    const path = `$.narrative.chapters[${index}]`;
    requireObject(chapter, path);
    requireString(chapter.id, `${path}.id`);
    requireString(chapter.title, `${path}.title`, { max: 100 });
    const refs = requireArray(chapter.slideIds, `${path}.slideIds`, { min: 1 });
    for (const [slideIndex, slideId] of refs.entries()) {
      if (!slideIds.has(slideId)) fail("E_PLAN_SCHEMA", `Unknown chapter slide ${slideId}`, { path: `${path}.slideIds[${slideIndex}]` });
    }
  }
  const chapterSlideIds = chapters.flatMap((chapter) => chapter.slideIds);
  if (chapterSlideIds.length !== slides.length
      || new Set(chapterSlideIds).size !== slides.length
      || chapterSlideIds.some((slideId, index) => slideId !== slides[index].id)) {
    fail("E_PLAN_SCHEMA", "$.narrative.chapters must cover every slide exactly once and preserve slide order", {
      path: "$.narrative.chapters"
    });
  }
  const titleSet = new Set(slides.map((slide) => slide.title.trim()));
  const messageSet = new Set(slides.map((slide) => slide.coreMessage.trim()));
  if (titleSet.size !== slides.length) fail("E_PLAN_SCHEMA", "Slide titles must be unique", { path: "$.slides" });
  if (messageSet.size !== slides.length) fail("E_PLAN_SCHEMA", "Each slide must have a unique core message", { path: "$.slides" });

  if (!options.allowUnreviewed) {
    const review = requireObject(plan.hostReview, "$.hostReview");
    if (review.status !== "approved") {
      fail("E_HOST_REVIEW_REQUIRED", "$.hostReview.status must be approved", { path: "$.hostReview.status" });
    }
    requireString(review.reviewedAt, "$.hostReview.reviewedAt");
    if (!Number.isFinite(Date.parse(review.reviewedAt))) {
      fail("E_PLAN_SCHEMA", "$.hostReview.reviewedAt must be an ISO date-time", { path: "$.hostReview.reviewedAt" });
    }
    const checks = requireObject(review.checks, "$.hostReview.checks");
    for (const key of REVIEW_CHECKS) {
      if (checks[key] !== true) fail("E_HOST_REVIEW_REQUIRED", `$.hostReview.checks.${key} must be true`, { path: `$.hostReview.checks.${key}` });
    }
  }

  return {
    version: plan.version,
    deckId: deck.id,
    slideCount: slides.length,
    sourceCount: sources.length,
    assetCount: assets.length,
    approved: plan.hostReview?.status === "approved"
  };
}

export async function validatePlanFile(planPath, options = {}) {
  const resolved = resolve(planPath);
  const plan = await readJson(resolved);
  const summary = await validatePlan(plan, { ...options, planDirectory: dirname(resolved) });
  return { plan, summary, planPath: resolved, planDirectory: dirname(resolved) };
}

function parseMarkdown(source) {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  let title = "";
  const sections = [];
  let current = { title: "内容", items: [] };
  const flush = () => {
    if (current.items.length > 0) sections.push(current);
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!title && /^#\s+/.test(line)) {
      title = line.replace(/^#\s+/, "").trim();
      continue;
    }
    if (/^#{2,3}\s+/.test(line)) {
      flush();
      current = { title: line.replace(/^#{2,3}\s+/, "").trim(), items: [] };
      continue;
    }
    const item = line.replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
    if (item) current.items.push(item);
  }
  flush();
  if (!title) title = "待命名演示";
  if (sections.length === 0) sections.push({ title: "核心内容", items: ["[待确认] 请补充核心内容"] });
  return { title, sections };
}

export async function scaffoldPlanFromSource(inputPath) {
  const resolved = resolve(inputPath);
  const source = await readFile(resolved, "utf8");
  const { title, sections } = parseMarkdown(source);
  const deckId = slugify(title);
  const sourceId = "source-input";
  const slides = [
    {
      id: "slide-cover",
      order: 1,
      type: "cover",
      title,
      coreMessage: title,
      visual: "克制的标题页",
      transition: "建立主题",
      notes: "由 Host 补充开场。",
      sourceRefs: [sourceId],
      content: { subtitle: "[待确认] 补充面向受众的副标题" }
    }
  ];
  for (const section of sections) {
    const chunks = [];
    for (let index = 0; index < section.items.length; index += 3) chunks.push(section.items.slice(index, index + 3));
    for (const [chunkIndex, chunk] of chunks.entries()) {
      slides.push({
        id: `slide-${slides.length + 1}`,
        order: slides.length + 1,
        type: "bullets",
        title: chunkIndex === 0 ? section.title : `${section.title}（续）`,
        coreMessage: chunkIndex === 0 ? section.title : `${section.title}的后续要点 ${chunkIndex + 1}`,
        visual: "编号支撑点",
        transition: "承接原文顺序",
        notes: "脚手架仅保留原文结构；Host 必须重写为结论标题并核对一页一观点。",
        sourceRefs: [sourceId],
        content: {
          points: chunk.map((text) => ({ text, factStatus: "provided", sourceRefs: [sourceId] }))
        }
      });
    }
  }
  slides.push({
    id: "slide-closing",
    order: slides.length + 1,
    type: "closing",
    title: "下一步",
    coreMessage: "[待确认] 明确希望受众采取的行动",
    visual: "行动号召",
    transition: "收束并行动",
    notes: "Host 必须替换占位行动。",
    sourceRefs: [sourceId],
    content: {
      action: { text: "[待确认] 明确希望受众采取的行动", factStatus: "placeholder", sourceRefs: [] }
    }
  });
  for (const key of ["title", "coreMessage"]) {
    const counts = new Map();
    for (const slide of slides) {
      const count = (counts.get(slide[key]) ?? 0) + 1;
      counts.set(slide[key], count);
      if (count > 1) slide[key] = `${slide[key]}（${count}）`;
    }
  }
  return {
    version: PLAN_VERSION,
    deck: { id: deckId, title, language: "zh-CN", size: { width: 1280, height: 720, unit: "px" } },
    positioning: {
      statement: "让待确认受众在待确认场景下理解待确认结论，并采取待确认行动。",
      goal: "待确认",
      audience: "待确认受众",
      scenario: "待确认场景",
      coreConclusion: "待确认结论",
      desiredAction: "待确认行动",
      deliveryMode: "现场演讲",
      durationMinutes: Math.max(5, slides.length * 2),
      targetSlideCount: slides.length
    },
    assumptions: [
      { id: "assumption-audience", text: "受众与使用场景尚未明确。", impact: "medium", status: "inferred" },
      { id: "assumption-delivery", text: "暂按现场演讲处理。", impact: "low", status: "inferred" }
    ],
    narrative: {
      framework: "保留原文顺序的待审脚手架",
      chapters: [{ id: "chapter-main", title: "原文结构", slideIds: slides.map((slide) => slide.id) }]
    },
    design: { tokenOverrides: {} },
    sources: [{
      id: sourceId,
      kind: extname(resolved).toLowerCase() === ".md" ? "file" : "user-input",
      label: basename(resolved),
      locator: basename(resolved),
      sha256: await sha256File(resolved),
      factStatus: "provided"
    }],
    assets: [],
    slides,
    hostReview: {
      status: "required",
      checks: {
        positioning: false,
        sourceIntegrity: false,
        narrative: false,
        oneMessagePerSlide: false,
        visualIntent: false
      }
    }
  };
}
