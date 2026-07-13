import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { compileLegacyDeckPlan, resolvedDeckPlanDesign, validateDeckPlan } from "./deck-plan-core.mjs";
import { resolveSemanticConnectors } from "./connector-resolver.mjs";
import { validateJsonSchema } from "./schema-utils.mjs";

const SCHEMA = JSON.parse(readFileSync(new URL("../../schemas/semantic-slide-ir.schema.json", import.meta.url), "utf8"));
const VISUAL_KINDS = new Set(["photo", "illustration", "icon", "logo", "texture"]);
const GAP = "{spacing.md}";

const ref = (nodeRef) => ({ nodeRef });
const node = (id, kind, role, payload, tokenRefs = {}, assetRefs = []) => ({
  id, kind, role, tokenRefs, assetRefs, payload
});
const textNode = (id, role, text, typography = "body") => node(id, "text", role, { text }, {
  typography: `{typography.${typography}}`, foreground: "{colors.text}"
});
const dividerNode = (id, role, payload) => node(id, "divider", role, payload, {
  foreground: "{colors.primary}"
});

function familyNodes(slide) {
  const data = slide.contentModel.data;
  switch (slide.contentModel.kind) {
    case "cover": return [
      textNode("headline", "headline", data.headline, "title"),
      textNode("subtitle", "subtitle", data.subtitle, "subtitle"),
      dividerNode("cover-accent", "accent", { type: "rule" })
    ];
    case "architecture": return [
      textNode("headline", "headline", data.headline, "title"),
      ...data.layers.map((label, index) => node(`layer-${index}`, "diagram", "architecture-layer", {
        type: "architecture-layer", label
      }, { background: "{colors.surface}", border: "{colors.primary}" }))
    ];
    case "comparison": return [
      textNode("headline", "headline", data.headline, "title"),
      node("left-panel", "table", "comparison-primary", { headers: [data.primary.title], rows: data.primary.items.map((item) => [item]) }, {
        background: "{colors.surfaceAlt}", border: "{colors.border}"
      }),
      node("right-panel", "table", "comparison-secondary", { headers: [data.secondary.title], rows: data.secondary.items.map((item) => [item]) }, {
        background: "{colors.surface}", border: "{colors.border}"
      })
    ];
    case "process": return [
      textNode("headline", "headline", data.headline, "title"),
      ...data.steps.map((label, index) => node(`step-${index}`, "diagram", "process-step", {
        type: "process-step", label
      }, { background: "{colors.surface}", border: "{colors.primary}" })),
      ...data.steps.slice(0, -1).map((_, index) => dividerNode(`connector-${index}`, "connector", {
        type: "connector", sourceId: `step-${index}`, targetId: `step-${index + 1}`,
        sourceAnchor: "auto", targetAnchor: "auto", route: "straight", arrow: "triangle"
      }))
    ];
    case "dashboard": return [
      textNode("headline", "headline", data.headline, "title"),
      ...data.metrics.map((metric, index) => node(`kpi-card-${index}`, "metric", "kpi", {
        label: metric.label, value: metric.value
      }, { typography: "{typography.metric}", foreground: "{colors.primary}", background: "{colors.surface}" }))
    ];
    case "quote": return [node("quote", "quote", "quotation", {
      text: data.quote, attribution: data.attribution
    }, { typography: "{typography.title}", foreground: "{colors.text}" })];
    case "matrix": return [
      textNode("headline", "headline", data.headline, "title"),
      node("axis-x", "diagram", "quadrant-matrix", {
        type: "quadrant-matrix", xAxis: data.xAxis, yAxis: data.yAxis, quadrants: structuredClone(data.quadrants)
      }, { background: "{colors.surface}", border: "{colors.border}" })
    ];
    case "closing": return [
      textNode("headline", "headline", data.headline, "title"),
      textNode("call-to-action", "call-to-action", data.callToAction, "subtitle"),
      dividerNode("closing-accent", "accent", { type: "rule" })
    ];
    default: throw new Error(`unsupported deck-plan family: ${slide.contentModel.kind}`);
  }
}

function familyLayout(slide, nodes) {
  const family = slide.contentModel.kind;
  const ids = new Set(nodes.map((entry) => entry.id));
  const indexed = (prefix) => nodes.filter((entry) => entry.id.startsWith(prefix))
    .sort((a, b) => Number(a.id.split("-").at(-1)) - Number(b.id.split("-").at(-1)));
  if (family === "comparison") return {
    id: "family-layout", primitive: "stack", direction: "vertical", gap: GAP, align: "stretch",
    children: [ref("headline"), { id: "comparison-split", primitive: "split", direction: "horizontal", ratios: [1, 1], gap: GAP, children: [ref("left-panel"), ref("right-panel")] }]
  };
  if (family === "process") return {
    id: "family-layout", primitive: "stack", direction: "vertical", gap: GAP, align: "stretch",
    children: [ref("headline"), {
      id: "process-flow", primitive: "flow", direction: "horizontal", gap: GAP, wrap: false,
      children: indexed("step-").map((entry) => ref(entry.id)),
      links: indexed("connector-").map((entry) => ({ connectorRef: entry.id }))
    }]
  };
  if (family === "dashboard") return {
    id: "family-layout", primitive: "stack", direction: "vertical", gap: GAP, align: "stretch",
    children: [ref("headline"), { id: "metric-grid", primitive: "grid", columns: Math.min(4, indexed("kpi-card-").length), columnGap: GAP, rowGap: GAP, children: indexed("kpi-card-").map((entry) => ref(entry.id)) }]
  };
  if (family === "quote") return { id: "family-layout", primitive: "fit-content", axis: "block", padding: GAP, child: ref("quote") };
  const ordered = family === "architecture"
    ? ["headline", ...indexed("layer-").map((entry) => entry.id)]
    : family === "matrix" ? ["headline", "axis-x"]
      : family === "cover" ? ["headline", "subtitle", "cover-accent"]
        : ["headline", "call-to-action", "closing-accent"];
  return { id: "family-layout", primitive: "stack", direction: "vertical", gap: GAP, align: "start", children: ordered.filter((id) => ids.has(id)).map(ref) };
}

function derivedNodes(plan, slide, assets) {
  const result = [dividerNode("role-marker", "page-role-marker", { type: "marker", marker: "page-role", value: slide.pageRole })];
  const section = plan.story.sections.find((entry) => entry.slideIds[0] === slide.id);
  if (section) result.push(dividerNode("section-eyebrow", "section-marker", { type: "marker", marker: "section", value: section.title }));
  const decisionIndex = plan.story.decisionPath.indexOf(slide.id);
  if (decisionIndex >= 0) result.push(dividerNode("decision-marker", "decision-marker", { type: "marker", marker: "decision", value: decisionIndex }));
  const visual = slide.assetIds.map((id) => assets.find((asset) => asset.id === id)).filter((asset) => asset && VISUAL_KINDS.has(asset.kind));
  const heroId = slide.attentionTarget.kind === "asset" ? slide.attentionTarget.ref : visual[0]?.id;
  for (const asset of visual) result.push(node(`asset-${asset.id}`, "media", "visual-asset", {
    placement: asset.id === heroId ? "hero" : "supporting",
    fit: ["contain", "none"].includes(asset.cropPolicy) ? "contain" : "cover",
    focalPoint: asset.focalPoint,
    alt: asset.altText
  }, {}, [asset.id]));
  return result;
}

function slideLayout(slide, nodes) {
  const family = familyLayout(slide, nodes);
  const children = [family];
  for (const id of ["role-marker", "section-eyebrow", "decision-marker"]) {
    if (nodes.some((entry) => entry.id === id)) children.push({ id: `${id}-anchor`, primitive: "anchor", anchor: "top-left", inset: "{spacing.sm}", child: ref(id) });
  }
  const media = nodes.filter((entry) => entry.kind === "media");
  if (media.length) children.push({
    id: "media-anchor", primitive: "anchor", anchor: "right", inset: "{spacing.sm}",
    child: { id: "media-grid", primitive: "grid", columns: media.length === 1 ? 1 : 2, columnGap: "{spacing.sm}", rowGap: "{spacing.sm}", children: media.map((entry) => ref(entry.id)) }
  });
  return {
    id: "safe-area", primitive: "safe-area",
    insets: { blockStart: GAP, inlineEnd: GAP, blockEnd: GAP, inlineStart: GAP },
    child: { id: "slide-overlay", primitive: "overlay", children }
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export function canonicalTokenSnapshotHash(tokens) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(tokens ?? {}))).digest("hex")}`;
}

export function compileDeckPlanToIr(plan, options = {}) {
  const validation = validateDeckPlan(plan);
  if (!validation.valid) throw new Error(`deck.plan invalid: ${validation.errors.join("; ")}`);
  const design = resolvedDeckPlanDesign(options);
  return {
    version: "0.1.0",
    source: { kind: "deck-plan", version: plan.version },
    context: structuredClone(plan.context),
    designIntent: structuredClone(plan.designIntent),
    story: structuredClone(plan.story),
    designSystem: {
      name: design.name,
      source: design.source,
      selection: {
        ...structuredClone(design.selection),
        provided: Object.prototype.hasOwnProperty.call(options, "designSystemSelection")
      },
      tokenSnapshotHash: canonicalTokenSnapshotHash(design.tokens)
    },
    assets: plan.assets.map((asset) => ({
      ...structuredClone(asset),
      src: options.assetSourceById instanceof Map
        ? (options.assetSourceById.get(asset.id) ?? asset.provenance.sourceRef)
        : (options.assetSourceById?.[asset.id] ?? asset.provenance.sourceRef)
    })),
    slides: plan.slides.map((slide) => {
      const base = familyNodes(slide);
      const derived = derivedNodes(plan, slide, plan.assets);
      const nodes = [...base, ...derived];
      return {
        id: slide.id,
        family: slide.contentModel.kind,
        pageRole: slide.pageRole,
        message: slide.message,
        attentionTarget: structuredClone(slide.attentionTarget),
        compositionIntent: structuredClone(slide.compositionIntent),
        assetRefs: [...slide.assetIds],
        routePolicy: structuredClone(slide.routePolicy),
        nodes,
        layout: slideLayout(slide, nodes)
      };
    })
  };
}

function tokenValue(tokens, reference) {
  const match = typeof reference === "string" && reference.match(/^\{([^}]+)\}$/);
  if (!match) return undefined;
  return match[1].split(".").reduce((value, key) => value?.[key], tokens);
}

function collectLayout(layout, state) {
  if (!layout || typeof layout !== "object") return;
  if (typeof layout.id === "string") state.layoutIds.push(layout.id);
  if (typeof layout.nodeRef === "string") state.nodeRefs.push(layout.nodeRef);
  for (const link of layout.links ?? []) if (typeof link.connectorRef === "string") state.connectorRefs.push(link.connectorRef);
  if (layout.child) collectLayout(layout.child, state);
  for (const child of layout.children ?? []) collectLayout(child, state);
}

function findBannedKey(value, path = "$") {
  const banned = new Set(["x", "y", "w", "h", "left", "top", "right", "bottom", "width", "height", "elements"]);
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (banned.has(key)) return `${path}.${key}`;
    const nested = findBannedKey(child, `${path}.${key}`);
    if (nested) return nested;
  }
  return null;
}

function duplicates(values) {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

const LAYOUT_SPACING_KEYS = new Set([
  "gap", "columnGap", "rowGap", "inset", "padding",
  "blockStart", "inlineEnd", "blockEnd", "inlineStart"
]);

function sameValues(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function sameSet(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function collectLayoutSpacing(value, output, path = "layout") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectLayoutSpacing(entry, output, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (LAYOUT_SPACING_KEYS.has(key)) output.push({ path: `${path}.${key}`, reference: child });
    if (child && typeof child === "object") collectLayoutSpacing(child, output, `${path}.${key}`);
  }
}

function primaryContract(id, kind, role, payloadType = null, payload = null) {
  return { id, kind, role, payloadType, payload, assetRefs: [] };
}

function indexedContractNodes(slide, prefix, kind, role, min, max, errors) {
  const pattern = new RegExp(`^${prefix}-(0|[1-9]\\d*)$`);
  const entries = (slide.nodes ?? []).filter((entry) => pattern.test(entry.id));
  const indexes = entries.map((entry) => Number(entry.id.slice(prefix.length + 1))).sort((a, b) => a - b);
  const continuous = indexes.every((value, index) => value === index);
  if (entries.length < min || entries.length > max || !continuous) {
    errors.push(`${slide.id} ${slide.family} ${prefix} cardinality/canonical indexes invalid`);
  }
  return entries.map((entry) => primaryContract(entry.id, kind, role));
}

function expectedFamilyContracts(slide, errors) {
  switch (slide.family) {
    case "cover": return [
      primaryContract("headline", "text", "headline"),
      primaryContract("subtitle", "text", "subtitle"),
      primaryContract("cover-accent", "divider", "accent", "rule", { type: "rule" })
    ];
    case "architecture": return [
      primaryContract("headline", "text", "headline"),
      ...indexedContractNodes(slide, "layer", "diagram", "architecture-layer", 2, 4, errors)
        .map((entry) => ({ ...entry, payloadType: "architecture-layer" }))
    ];
    case "comparison": return [
      primaryContract("headline", "text", "headline"),
      primaryContract("left-panel", "table", "comparison-primary"),
      primaryContract("right-panel", "table", "comparison-secondary")
    ];
    case "process": {
      const steps = indexedContractNodes(slide, "step", "diagram", "process-step", 2, 5, errors)
        .map((entry) => ({ ...entry, payloadType: "process-step" }));
      return [
        primaryContract("headline", "text", "headline"),
        ...steps,
        ...steps.slice(0, -1).map((_, index) => primaryContract(`connector-${index}`, "divider", "connector", "connector"))
      ];
    }
    case "dashboard": return [
      primaryContract("headline", "text", "headline"),
      ...indexedContractNodes(slide, "kpi-card", "metric", "kpi", 1, 4, errors)
    ];
    case "quote": return [primaryContract("quote", "quote", "quotation")];
    case "matrix": return [
      primaryContract("headline", "text", "headline"),
      primaryContract("axis-x", "diagram", "quadrant-matrix", "quadrant-matrix")
    ];
    case "closing": return [
      primaryContract("headline", "text", "headline"),
      primaryContract("call-to-action", "text", "call-to-action"),
      primaryContract("closing-accent", "divider", "accent", "rule", { type: "rule" })
    ];
    default: return [];
  }
}

function expectedDerivedContracts(ir, slide, assets) {
  const expected = [dividerNode("role-marker", "page-role-marker", {
    type: "marker", marker: "page-role", value: slide.pageRole
  })];
  const section = (ir.story?.sections ?? []).find((entry) => entry.slideIds?.[0] === slide.id);
  if (section) expected.push(dividerNode("section-eyebrow", "section-marker", {
    type: "marker", marker: "section", value: section.title
  }));
  const decisionIndex = (ir.story?.decisionPath ?? []).indexOf(slide.id);
  if (decisionIndex >= 0) expected.push(dividerNode("decision-marker", "decision-marker", {
    type: "marker", marker: "decision", value: decisionIndex
  }));
  const visual = (slide.assetRefs ?? []).map((id) => assets.get(id)).filter((asset) => asset && VISUAL_KINDS.has(asset.kind));
  const heroId = slide.attentionTarget?.kind === "asset" ? slide.attentionTarget.ref : visual[0]?.id;
  for (const asset of visual) expected.push(node(`asset-${asset.id}`, "media", "visual-asset", {
    placement: asset.id === heroId ? "hero" : "supporting",
    fit: ["contain", "none"].includes(asset.cropPolicy) ? "contain" : "cover",
    focalPoint: asset.focalPoint,
    alt: asset.altText
  }, {}, [asset.id]));
  return expected;
}

function validateNodeAuthority(ir, slide, assets, errors) {
  const expectedPrimary = expectedFamilyContracts(slide, errors);
  const expectedDerived = expectedDerivedContracts(ir, slide, assets);
  const expectedIds = [...expectedPrimary, ...expectedDerived].map((entry) => entry.id);
  const actualIds = (slide.nodes ?? []).map((entry) => entry.id);
  for (const id of expectedIds.filter((id) => !actualIds.includes(id))) {
    errors.push(`${slide.id} ${slide.family} family/derived contract missing node ${id}`);
  }
  for (const id of actualIds.filter((id) => !expectedIds.includes(id))) {
    errors.push(`${slide.id} ${slide.family} family/derived contract has unexpected node ${id}`);
  }
  const byId = new Map((slide.nodes ?? []).map((entry) => [entry.id, entry]));
  for (const contract of expectedPrimary) {
    const entry = byId.get(contract.id);
    if (!entry) continue;
    if (entry.kind !== contract.kind || entry.role !== contract.role) {
      errors.push(`${slide.id}/${entry.id} family contract expected kind ${contract.kind} and role ${contract.role}`);
    }
    if (!sameValues(entry.assetRefs ?? [], contract.assetRefs)) {
      errors.push(`${slide.id}/${entry.id} family contract does not allow ignored assetRefs`);
    }
    if (contract.payloadType && entry.payload?.type !== contract.payloadType) {
      errors.push(`${slide.id}/${entry.id} family contract expected payload type ${contract.payloadType}`);
    }
    if (contract.payload && !sameValues(entry.payload, contract.payload)) {
      errors.push(`${slide.id}/${entry.id} family contract payload drift`);
    }
  }
  for (const contract of expectedDerived) {
    const entry = byId.get(contract.id);
    if (entry && !sameValues(entry, contract)) {
      errors.push(`${slide.id}/${entry.id} derived contract payload or identity drift`);
    }
  }
  return { expectedPrimary, expectedDerived, byId };
}

function nodeRefIds(children = []) {
  return children.map((entry) => entry?.nodeRef).filter((id) => typeof id === "string");
}

function validateFamilyLayout(slide, family, byId, errors) {
  if (!family) {
    errors.push(`${slide.id} family layout is missing`);
    return;
  }
  const fail = (message) => errors.push(`${slide.id} ${slide.family} family layout contract ${message}`);
  if (family.id !== "family-layout") fail("requires id family-layout");
  const canonicalIds = (prefix) => [...byId.keys()].filter((id) => new RegExp(`^${prefix}-(0|[1-9]\\d*)$`).test(id));
  if (["cover", "architecture", "matrix", "closing"].includes(slide.family)) {
    if (family.primitive !== "stack" || family.direction !== "vertical") fail("requires a vertical stack");
    const fixed = {
      cover: ["headline", "subtitle", "cover-accent"],
      matrix: ["headline", "axis-x"],
      closing: ["headline", "call-to-action", "closing-accent"]
    }[slide.family];
    const refs = nodeRefIds(family.children);
    if (slide.family === "architecture") {
      const layers = canonicalIds("layer");
      if (refs[0] !== "headline" || !sameSet(refs.slice(1), layers)) fail("must place headline then every architecture layer exactly once");
    } else if (!sameValues(refs, fixed)) fail(`must place ${fixed.join(", ")} in canonical order`);
    return;
  }
  if (slide.family === "comparison") {
    const split = family.children?.[1];
    if (family.primitive !== "stack" || nodeRefIds(family.children)[0] !== "headline"
      || split?.id !== "comparison-split" || split?.primitive !== "split"
      || !sameValues(nodeRefIds(split.children), ["left-panel", "right-panel"])) {
      fail("must be headline plus the canonical comparison split");
    }
    return;
  }
  if (slide.family === "process") {
    const flow = family.children?.[1];
    const steps = canonicalIds("step");
    if (family.primitive !== "stack" || nodeRefIds(family.children)[0] !== "headline"
      || flow?.id !== "process-flow" || flow?.primitive !== "flow"
      || !sameSet(nodeRefIds(flow?.children), steps)) {
      fail("must be headline plus a flow containing every process step exactly once");
      return;
    }
    const links = flow.links ?? [];
    if (links.length !== Math.max(0, steps.length - 1)) fail("must contain one connector link per adjacent step pair");
    links.forEach((link, index) => {
      const connector = byId.get(link.connectorRef);
      if (connector?.kind !== "divider" || connector?.role !== "connector" || connector?.payload?.type !== "connector") {
        fail(`flow link ${link.connectorRef ?? "(missing)"} must resolve to a connector divider`);
        return;
      }
      const source = byId.get(connector.payload.sourceId);
      const target = byId.get(connector.payload.targetId);
      if (source?.role !== "process-step" || target?.role !== "process-step") {
        fail(`connector ${connector.id} source/target must resolve to process-step nodes`);
      }
      const ordered = nodeRefIds(flow.children);
      if (connector.payload.sourceId !== ordered[index] || connector.payload.targetId !== ordered[index + 1]) {
        fail(`connector ${connector.id} endpoints must follow adjacent layout step order`);
      }
      if (connector.payload.arrow !== "triangle") fail(`connector ${connector.id} requires triangle arrow`);
    });
    return;
  }
  if (slide.family === "dashboard") {
    const grid = family.children?.[1];
    const metrics = canonicalIds("kpi-card");
    if (family.primitive !== "stack" || nodeRefIds(family.children)[0] !== "headline"
      || grid?.id !== "metric-grid" || grid?.primitive !== "grid"
      || !sameSet(nodeRefIds(grid?.children), metrics)) {
      fail("must be headline plus a grid containing every metric exactly once");
    }
    return;
  }
  if (slide.family === "quote" && (family.primitive !== "fit-content" || family.child?.nodeRef !== "quote")) {
    fail("must be a fit-content quote");
  }
}

function validateLayoutAuthority(slide, expectedDerived, byId, errors) {
  const root = slide.layout;
  const overlay = root?.child;
  if (root?.id !== "safe-area" || root?.primitive !== "safe-area" || overlay?.id !== "slide-overlay" || overlay?.primitive !== "overlay") {
    errors.push(`${slide.id} derived layout contract requires safe-area > slide-overlay`);
    return;
  }
  const children = overlay.children ?? [];
  const family = children.find((entry) => entry?.id === "family-layout");
  validateFamilyLayout(slide, family, byId, errors);

  const derivedIds = expectedDerived.map((entry) => entry.id);
  const markerIds = derivedIds.filter((id) => ["role-marker", "section-eyebrow", "decision-marker"].includes(id));
  const mediaIds = derivedIds.filter((id) => id.startsWith("asset-"));
  const expectedChildIds = ["family-layout", ...markerIds.map((id) => `${id}-anchor`), ...(mediaIds.length ? ["media-anchor"] : [])];
  const actualChildIds = children.map((entry) => entry?.id).filter(Boolean);
  if (!sameSet(actualChildIds, expectedChildIds)) {
    errors.push(`${slide.id} derived layout contract expected children ${expectedChildIds.join(", ")}`);
  }
  for (const id of markerIds) {
    const actual = children.find((entry) => entry?.id === `${id}-anchor`);
    const expected = { id: `${id}-anchor`, primitive: "anchor", anchor: "top-left", inset: "{spacing.sm}", child: ref(id) };
    if (!sameValues(actual, expected)) errors.push(`${slide.id}/${id} derived marker layout contract drift`);
  }
  if (mediaIds.length) {
    const actual = children.find((entry) => entry?.id === "media-anchor");
    const expected = {
      id: "media-anchor", primitive: "anchor", anchor: "right", inset: "{spacing.sm}",
      child: {
        id: "media-grid", primitive: "grid", columns: mediaIds.length === 1 ? 1 : 2,
        columnGap: "{spacing.sm}", rowGap: "{spacing.sm}", children: mediaIds.map((id) => ref(id))
      }
    };
    if (!sameValues(actual, expected)) errors.push(`${slide.id} derived media layout contract drift`);
  }
}

export function validateSemanticDeckIr(ir, { design } = {}) {
  const schema = validateJsonSchema(ir, SCHEMA);
  const errors = schema.errors.map((entry) => `${entry.path}: ${entry.message}`);
  const banned = findBannedKey(ir);
  if (banned) errors.push(`coordinate/elements key is forbidden at ${banned}`);
  const assets = new Map();
  for (const asset of ir?.assets ?? []) {
    if (assets.has(asset.id)) errors.push(`duplicate asset id ${asset.id}`);
    assets.set(asset.id, asset);
    if (typeof asset.src !== "string" || asset.src.length === 0) errors.push(`asset ${asset.id} missing portable src`);
  }
  const slideIds = (ir?.slides ?? []).map((slide) => slide.id);
  for (const id of duplicates(slideIds)) errors.push(`duplicate slide id ${id}`);
  for (const slide of ir?.slides ?? []) {
    const nodeIds = slide.nodes?.map((entry) => entry.id) ?? [];
    for (const id of duplicates(nodeIds)) errors.push(`${slide.id} duplicate node id ${id}`);
    const byId = new Map((slide.nodes ?? []).map((entry) => [entry.id, entry]));
    const state = { layoutIds: [], nodeRefs: [], connectorRefs: [] };
    collectLayout(slide.layout, state);
    const authority = validateNodeAuthority(ir, slide, assets, errors);
    validateLayoutAuthority(slide, authority.expectedDerived, authority.byId, errors);
    const layoutSpacing = [];
    collectLayoutSpacing(slide.layout, layoutSpacing);
    for (const { path, reference } of layoutSpacing) {
      if (!design?.tokens || tokenValue(design.tokens, reference) === undefined) {
        errors.push(`${slide.id} layout spacing token ${reference} at ${path} cannot resolve or is missing`);
      }
    }
    for (const id of duplicates(state.layoutIds)) errors.push(`${slide.id} duplicate layout id ${id}`);
    if (slide.layout?.primitive !== "safe-area") errors.push(`${slide.id} layout root must be safe-area`);
    for (const id of [...state.nodeRefs, ...state.connectorRefs]) if (!byId.has(id)) errors.push(`${slide.id} layout reference ${id} cannot resolve to a node`);
    for (const entry of slide.nodes ?? []) {
      const connector = entry.kind === "divider" && entry.payload?.type === "connector";
      const count = (connector ? state.connectorRefs : state.nodeRefs).filter((id) => id === entry.id).length;
      if (count === 0) errors.push(`${slide.id}/${entry.id} is an orphan; every node must be referenced exactly once`);
      if (count > 1) errors.push(`${slide.id}/${entry.id} is referenced multiple times; expected exactly once`);
      for (const assetId of entry.assetRefs ?? []) if (!assets.has(assetId)) errors.push(`${slide.id}/${entry.id} references unknown asset ${assetId}`);
      if (entry.kind === "media") {
        if ((entry.assetRefs ?? []).length !== 1) errors.push(`${slide.id}/${entry.id} media must reference exactly one asset`);
        const asset = assets.get(entry.assetRefs?.[0]);
        if (asset && !VISUAL_KINDS.has(asset.kind)) errors.push(`${slide.id}/${entry.id} media asset must be visual`);
      }
      for (const reference of Object.values(entry.tokenRefs ?? {})) {
        if (!design?.tokens || tokenValue(design.tokens, reference) === undefined) errors.push(`${slide.id}/${entry.id} token reference ${reference} cannot resolve or is missing`);
      }
    }
    for (const id of duplicates(slide.assetRefs ?? [])) errors.push(`${slide.id} assetRefs must be unique; duplicate ${id}`);
    for (const id of slide.assetRefs ?? []) if (!assets.has(id)) errors.push(`${slide.id} references unknown asset ${id}`);
    if (slide.attentionTarget?.kind === "asset") {
      const asset = assets.get(slide.attentionTarget.ref);
      if (!asset || !(slide.assetRefs ?? []).includes(slide.attentionTarget.ref) || !VISUAL_KINDS.has(asset.kind)) {
        errors.push(`${slide.id} attention asset must be a same-slide visual asset member`);
      }
    }
    if (slide.routePolicy?.fullSlideRaster !== false) errors.push(`${slide.id} route fullSlideRaster must be false`);
    const indexed = (prefix) => nodeIds.filter((id) => id.startsWith(prefix)).map((id) => Number(id.split("-").at(-1))).sort((a, b) => a - b);
    const continuous = (values) => values.every((value, index) => value === index);
    if (slide.family === "architecture" && (indexed("layer-").length < 2 || !continuous(indexed("layer-")))) errors.push(`${slide.id} architecture layer cardinality/indexes invalid`);
    if (slide.family === "process" && (indexed("step-").length < 2 || !continuous(indexed("step-")))) errors.push(`${slide.id} process step cardinality/indexes invalid`);
    if (slide.family === "dashboard" && (indexed("kpi-card-").length < 1 || !continuous(indexed("kpi-card-")))) errors.push(`${slide.id} dashboard metric cardinality/indexes invalid`);
  }
  return { valid: errors.length === 0, errors };
}

function traversalIds(layout, output = []) {
  if (!layout || typeof layout !== "object") return output;
  if (typeof layout.nodeRef === "string") output.push(layout.nodeRef);
  if (layout.child) traversalIds(layout.child, output);
  for (const child of layout.children ?? []) traversalIds(child, output);
  return output;
}

function contentFromSlide(slide) {
  const byId = new Map(slide.nodes.map((entry) => [entry.id, entry]));
  const ordered = traversalIds(slide.layout).map((id) => byId.get(id)).filter(Boolean);
  const first = (id) => byId.get(id)?.payload;
  const matching = (role) => ordered.filter((entry) => entry.role === role);
  switch (slide.family) {
    case "cover": return { headline: first("headline").text, subtitle: first("subtitle").text };
    case "architecture": return { headline: first("headline").text, layers: matching("architecture-layer").map((entry) => entry.payload.label) };
    case "comparison": {
      const panel = (id) => ({ title: first(id).headers[0], items: first(id).rows.map((row) => row[0]) });
      return { headline: first("headline").text, primary: panel("left-panel"), secondary: panel("right-panel") };
    }
    case "process": return { headline: first("headline").text, steps: matching("process-step").map((entry) => entry.payload.label) };
    case "dashboard": return { headline: first("headline").text, metrics: matching("kpi").map((entry) => ({ label: entry.payload.label, value: entry.payload.value })) };
    case "quote": return { quote: first("quote").text, attribution: first("quote").attribution };
    case "matrix": return { headline: first("headline").text, xAxis: first("axis-x").xAxis, yAxis: first("axis-x").yAxis, quadrants: structuredClone(first("axis-x").quadrants) };
    case "closing": return { headline: first("headline").text, callToAction: first("call-to-action").text };
    default: throw new Error(`unsupported semantic IR family: ${slide.family}`);
  }
}

function planFromIr(ir) {
  return {
    version: "0.2.0",
    context: structuredClone(ir.context),
    designIntent: structuredClone(ir.designIntent),
    story: structuredClone(ir.story),
    assets: ir.assets.map(({ src: _src, ...asset }) => structuredClone(asset)),
    slides: ir.slides.map((slide) => ({
      id: slide.id,
      pageRole: slide.pageRole,
      message: slide.message,
      contentModel: { kind: slide.family, data: contentFromSlide(slide) },
      attentionTarget: structuredClone(slide.attentionTarget),
      compositionIntent: structuredClone(slide.compositionIntent),
      assetIds: [...slide.assetRefs],
      routePolicy: structuredClone(slide.routePolicy)
    }))
  };
}

function findLayoutById(layout, id) {
  if (!layout || typeof layout !== "object") return null;
  if (layout.id === id) return layout;
  if (layout.child) {
    const found = findLayoutById(layout.child, id);
    if (found) return found;
  }
  for (const child of layout.children ?? []) {
    const found = findLayoutById(child, id);
    if (found) return found;
  }
  return null;
}

function orderedNodeIds(slide, role) {
  const byId = new Map(slide.nodes.map((entry) => [entry.id, entry]));
  return traversalIds(slide.layout).filter((id) => byId.get(id)?.role === role);
}

function fixedSemanticParent(family, id) {
  const comparison = family === "comparison" ? id.match(/^(left|right)-(?:title|items)$/) : null;
  if (comparison) return `${comparison[1]}-panel`;
  if (family === "quote" && ["quote-mark", "attribution"].includes(id)) return "quote";
  if (family === "matrix" && (id === "axis-y" || id === "x-label" || id === "y-label" || /^quadrant-\d+$/.test(id))) return "axis-x";
  return null;
}

function attachSemanticIdentity(manifest, ir) {
  const next = structuredClone(manifest);
  const irById = new Map(ir.slides.map((slide) => [slide.id, slide]));
  for (const slide of next.slides) {
    const source = irById.get(slide.id);
    if (!source) continue;
    const architecture = source.family === "architecture" ? orderedNodeIds(source, "architecture-layer") : [];
    const process = source.family === "process" ? orderedNodeIds(source, "process-step") : [];
    const dashboard = source.family === "dashboard" ? orderedNodeIds(source, "kpi") : [];
    const flow = source.family === "process" ? findLayoutById(source.layout, "process-flow") : null;
    slide.elements = slide.elements.map((element) => {
      const result = structuredClone(element);
      const originalId = result.id;
      const architecturePrimary = source.family === "architecture" ? originalId.match(/^layer-(\d+)$/) : null;
      const architectureDerived = source.family === "architecture" ? originalId.match(/^layer-label-(\d+)$/) : null;
      const processPrimary = source.family === "process" ? originalId.match(/^step-(\d+)$/) : null;
      const processDerived = source.family === "process" ? originalId.match(/^step-label-(\d+)$/) : null;
      const processConnector = source.family === "process" ? originalId.match(/^connector-(\d+)$/) : null;
      const dashboardPrimary = source.family === "dashboard" ? originalId.match(/^kpi-card-(\d+)$/) : null;
      const dashboardDerived = source.family === "dashboard" ? originalId.match(/^(?:value|label)-(\d+)$/) : null;
      if (architecturePrimary && architecture[Number(architecturePrimary[1])]) {
        result.id = architecture[Number(architecturePrimary[1])];
      } else if (architectureDerived && architecture[Number(architectureDerived[1])]) {
        const parentId = architecture[Number(architectureDerived[1])];
        result.id = `layer-label-${parentId.match(/(\d+)$/)[1]}`;
        result.semanticParentId = parentId;
      } else if (processPrimary && process[Number(processPrimary[1])]) {
        result.id = process[Number(processPrimary[1])];
      } else if (processDerived && process[Number(processDerived[1])]) {
        const parentId = process[Number(processDerived[1])];
        result.id = `step-label-${parentId.match(/(\d+)$/)[1]}`;
        result.semanticParentId = parentId;
      } else if (dashboardPrimary && dashboard[Number(dashboardPrimary[1])]) {
        result.id = dashboard[Number(dashboardPrimary[1])];
      } else if (dashboardDerived && dashboard[Number(dashboardDerived[1])]) {
        const parentId = dashboard[Number(dashboardDerived[1])];
        result.id = `${originalId.startsWith("value-") ? "value" : "label"}-${parentId.match(/(\d+)$/)[1]}`;
        result.semanticParentId = parentId;
      } else if (processConnector) {
        const link = flow?.links?.[Number(processConnector[1])];
        const connectorNode = source.nodes.find((entry) => entry.id === link?.connectorRef);
        if (connectorNode) {
          result.id = connectorNode.id;
          result.role = "connector";
          result.connector = {
            sourceId: connectorNode.payload.sourceId,
            targetId: connectorNode.payload.targetId,
            sourceAnchor: connectorNode.payload.sourceAnchor,
            targetAnchor: connectorNode.payload.targetAnchor,
            route: connectorNode.payload.route
          };
          result.style = { ...(result.style ?? {}), endArrowType: connectorNode.payload.arrow };
        }
      }
      const fixedParent = fixedSemanticParent(source.family, originalId);
      if (fixedParent) result.semanticParentId = fixedParent;
      return result;
    });
    slide.elements = resolveSemanticConnectors(slide.elements);
  }
  return next;
}

export function compileSemanticDeckIr(ir, { design } = {}) {
  const validation = validateSemanticDeckIr(ir, { design });
  if (!validation.valid) throw new Error(`semantic slide IR invalid: ${validation.errors.join("; ")}`);
  if (!design?.tokens) throw new Error("semantic slide IR compilation requires design tokens");
  if (canonicalTokenSnapshotHash(design.tokens) !== ir.designSystem.tokenSnapshotHash) {
    throw new Error("semantic slide IR token snapshot hash does not match supplied design");
  }
  const plan = planFromIr(ir);
  const { provided: selectionProvided, ...selectionValue } = ir.designSystem.selection ?? {};
  const selection = selectionProvided ? { designSystemSelection: selectionValue } : {};
  return attachSemanticIdentity(compileLegacyDeckPlan(plan, {
    designTokens: design.tokens,
    designSystemName: ir.designSystem.name,
    designSystemSource: ir.designSystem.source,
    ...selection,
    assetSourceById: Object.fromEntries(ir.assets.map((asset) => [asset.id, asset.src]))
  }), ir);
}

export function compileIrCompatibilityFixture(plan, options = {}) {
  return compileLegacyDeckPlan(plan, options);
}
