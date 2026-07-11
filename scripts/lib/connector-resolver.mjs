const ANCHORS = new Set(["auto", "top", "right", "bottom", "left"]);
const LEGACY_KEYS = ["sourceId", "targetId", "sourceAnchor", "targetAnchor", "route"];

export function connectorMetadata(line) {
  const semantic = line?.connector ?? {};
  const legacy = line?.style ?? {};
  const sourceId = semantic.sourceId ?? legacy.sourceId;
  const targetId = semantic.targetId ?? legacy.targetId;
  if (!sourceId && !targetId) return null;
  return {
    sourceId,
    targetId,
    sourceAnchor: semantic.sourceAnchor ?? legacy.sourceAnchor ?? "auto",
    targetAnchor: semantic.targetAnchor ?? legacy.targetAnchor ?? "auto",
    route: semantic.route ?? legacy.route ?? "straight"
  };
}

function normalizeConnector(line) {
  const next = structuredClone(line);
  const connector = connectorMetadata(next);
  if (!connector) return next;
  next.connector = connector;
  next.style = Object.fromEntries(Object.entries(next.style ?? {}).filter(([key]) => !LEGACY_KEYS.includes(key)));
  return next;
}

export function boundaryAnchor(rect, toward, requested = "auto") {
  const anchor = ANCHORS.has(requested) ? requested : "auto";
  const center = { x: Number(rect.x) + Number(rect.w) / 2, y: Number(rect.y) + Number(rect.h) / 2 };
  if (anchor === "top") return { x: center.x, y: Number(rect.y) };
  if (anchor === "right") return { x: Number(rect.x) + Number(rect.w), y: center.y };
  if (anchor === "bottom") return { x: center.x, y: Number(rect.y) + Number(rect.h) };
  if (anchor === "left") return { x: Number(rect.x), y: center.y };
  const targetCenter = { x: Number(toward.x) + Number(toward.w) / 2, y: Number(toward.y) + Number(toward.h) / 2 };
  const dx = targetCenter.x - center.x;
  const dy = targetCenter.y - center.y;
  if (Math.abs(dx) > Math.abs(dy)) return { x: dx >= 0 ? Number(rect.x) + Number(rect.w) : Number(rect.x), y: center.y };
  return { x: center.x, y: dy >= 0 ? Number(rect.y) + Number(rect.h) : Number(rect.y) };
}

export function pointTouchesBoundary(point, rect, tolerance = 0.08) {
  const insideX = point.x >= rect.x - tolerance && point.x <= rect.x + rect.w + tolerance;
  const insideY = point.y >= rect.y - tolerance && point.y <= rect.y + rect.h + tolerance;
  if (!insideX || !insideY) return false;
  return Math.min(
    Math.abs(point.x - rect.x),
    Math.abs(point.x - (rect.x + rect.w)),
    Math.abs(point.y - rect.y),
    Math.abs(point.y - (rect.y + rect.h))
  ) <= tolerance;
}

export function resolveConnectorGeometry(line, byId) {
  const next = normalizeConnector(line);
  const connector = connectorMetadata(next);
  const source = byId.get(connector?.sourceId);
  const target = byId.get(connector?.targetId);
  if (!source || !target) return next;
  const start = boundaryAnchor(source, target, connector.sourceAnchor);
  const end = boundaryAnchor(target, source, connector.targetAnchor);
  return {
    ...next,
    x: start.x,
    y: start.y,
    w: end.x - start.x,
    h: end.y - start.y
  };
}

export function resolveSemanticConnectors(elements = []) {
  const cloned = elements.map((element) => structuredClone(element));
  const byId = new Map(cloned.filter((element) => element?.id && element.type !== "line").map((element) => [element.id, element]));
  return cloned.map((element) => element?.type === "line" && connectorMetadata(element)
    ? resolveConnectorGeometry(element, byId)
    : element);
}
