const ANCHORS = new Set(["auto", "top", "right", "bottom", "left"]);

export function connectorMetadata(line) {
  const connector = line?.connector;
  if (!connector || typeof connector !== "object") return null;
  const { sourceId, targetId } = connector;
  if (!sourceId && !targetId) return null;
  return {
    sourceId,
    targetId,
    sourceAnchor: connector.sourceAnchor ?? "auto",
    targetAnchor: connector.targetAnchor ?? "auto",
    route: connector.route ?? "straight"
  };
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
  if (Math.abs(dx) < Number.EPSILON && Math.abs(dy) < Number.EPSILON) return center;

  // Auto anchors follow the centre-to-centre ray until it intersects the
  // rectangle. Side-centre snapping made diagonal connectors look detached
  // even when their endpoints technically touched a module boundary.
  const halfWidth = Math.max(Number(rect.w) / 2, Number.EPSILON);
  const halfHeight = Math.max(Number(rect.h) / 2, Number.EPSILON);
  const scaleX = Math.abs(dx) < Number.EPSILON ? Infinity : halfWidth / Math.abs(dx);
  const scaleY = Math.abs(dy) < Number.EPSILON ? Infinity : halfHeight / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);
  return { x: center.x + dx * scale, y: center.y + dy * scale };
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

export function pointDistance(a, b) {
  return Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y));
}

export function connectorDirectionDot(start, end, target) {
  const targetCenter = {
    x: Number(target.x) + Number(target.w) / 2,
    y: Number(target.y) + Number(target.h) / 2
  };
  return (Number(end.x) - Number(start.x)) * (targetCenter.x - Number(end.x))
    + (Number(end.y) - Number(start.y)) * (targetCenter.y - Number(end.y));
}

/**
 * Return true when a straight connector crosses the interior of a module.
 * A small inset makes tangential edge contact legal while still blocking
 * visually misleading paths that run through unrelated cards or nodes.
 */
export function segmentIntersectsRectInterior(start, end, rect, inset = 0.02) {
  const left = Number(rect.x) + inset;
  const right = Number(rect.x) + Number(rect.w) - inset;
  const top = Number(rect.y) + inset;
  const bottom = Number(rect.y) + Number(rect.h) - inset;
  if (!(right > left && bottom > top)) return false;
  const dx = Number(end.x) - Number(start.x);
  const dy = Number(end.y) - Number(start.y);
  let tMin = 0;
  let tMax = 1;
  for (const [p, q] of [
    [-dx, Number(start.x) - left],
    [dx, right - Number(start.x)],
    [-dy, Number(start.y) - top],
    [dy, bottom - Number(start.y)]
  ]) {
    if (Math.abs(p) < Number.EPSILON) {
      if (q < 0) return false;
      continue;
    }
    const ratio = q / p;
    if (p < 0) tMin = Math.max(tMin, ratio);
    else tMax = Math.min(tMax, ratio);
    if (tMin > tMax) return false;
  }
  return tMax > 1e-6 && tMin < 1 - 1e-6;
}

export function resolveConnectorGeometry(line, byId) {
  const next = structuredClone(line);
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
