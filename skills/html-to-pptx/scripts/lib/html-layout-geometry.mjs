export function rectOverlapRatio(a, b) {
  const width = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  if (width === 0 || height === 0) return 0;
  return (width * height) / Math.max(1e-9, Math.min(a.w * a.h, b.w * b.h));
}

export function hasBoxOverflow({ scrollWidth, scrollHeight, clientWidth, clientHeight }, tolerance = 2) {
  return scrollWidth > clientWidth + tolerance || scrollHeight > clientHeight + tolerance;
}

export function pointTouchesRectBoundary(point, rect, tolerance = 8) {
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

export function connectorDirectionDot(start, end, targetCenter) {
  return (end.x - start.x) * (targetCenter.x - end.x)
    + (end.y - start.y) * (targetCenter.y - end.y);
}
