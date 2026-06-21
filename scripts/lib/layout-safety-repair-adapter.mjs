/**
 * layout-safety-repair-adapter.mjs
 *
 * U6 adapter — translate wire-shape checks emitted by
 * `check-layout-safety.mjs` `formatReport()` into repair-patch operations
 * consumable by `applyRepairPatch()`.
 *
 * Mapping (kind → operation):
 *   bounds                  → move + resize (one or both, depending on
 *                             which suggestion fields the check carries)
 *   font-too-small          → updateStyle {style: {fontSize: 12}}
 *   card-spacing-tight      → increaseSpacing {padding: "spacing.md"}
 *   connector-detached      → move + resize to suggested endpoints
 *   text-overflow           → reduceDensity {}
 *   line-height-too-tight   → adjustStyle {style: {lineHeight: 1.4},
 *                                           suggestionKind: "..."}
 *   letter-spacing-too-tight → adjustStyle {style: {letterSpacing: 0}}
 *   contrast-fail           → adjustStyle {style: {color: "#000000"}}
 *
 * Every patch (where applicable) carries `suggestionKind` in its
 * `changes` so downstream consumers can discriminate the originating
 * check, even when the operation is shared (`adjustStyle`).
 *
 * Unknown kinds return `null` from `convertOne()`; `convertSuggestions()`
 * filters nulls and returns the surviving patch array.
 */

const SPACING_TOKEN_DEFAULTS = {
  "spacing.xs": 0.125,
  "spacing.sm": 0.25,
  "spacing.md": 0.5,
  "spacing.lg": 1.0,
  "spacing.xl": 1.5
};

function resolveSpacingToken(token) {
  if (typeof token !== "string") return 0.5;
  if (Object.prototype.hasOwnProperty.call(SPACING_TOKEN_DEFAULTS, token)) {
    return SPACING_TOKEN_DEFAULTS[token];
  }
  const numeric = parseFloat(token);
  return Number.isFinite(numeric) ? numeric : 0.5;
}

function boundsPatches(check) {
  const patches = [];
  const suggestion = check.suggestion || {};
  const elementId = check.elementId;
  if (!elementId) return patches;
  const hasX = typeof suggestion.x === "number";
  const hasY = typeof suggestion.y === "number";
  if (hasX || hasY) {
    const changes = {};
    if (hasX) changes.x = suggestion.x;
    if (hasY) changes.y = suggestion.y;
    patches.push({
      operation: "move",
      targetElementId: elementId,
      slideId: check.slideId,
      changes
    });
  }
  const hasW = typeof suggestion.w === "number";
  const hasH = typeof suggestion.h === "number";
  if (hasW || hasH) {
    const changes = {};
    if (hasW) changes.w = suggestion.w;
    if (hasH) changes.h = suggestion.h;
    patches.push({
      operation: "resize",
      targetElementId: elementId,
      slideId: check.slideId,
      changes
    });
  }
  return patches;
}

function adjustStylePatch(check, defaults) {
  const style = { ...(defaults.style || {}) };
  if (check.suggestion && typeof check.suggestion.style === "object") {
    Object.assign(style, check.suggestion.style);
  }
  return {
    operation: "adjustStyle",
    targetElementId: check.elementId,
    slideId: check.slideId,
    changes: { style, suggestionKind: check.kind }
  };
}

export function convertOne(check, slideId) {
  if (!check || typeof check !== "object") return null;
  const kind = check.kind;
  const elementId = check.elementId;
  const effectiveSlideId = check.slideId ?? slideId;
  switch (kind) {
    case "bounds": {
      const patches = boundsPatches({ ...check, slideId: effectiveSlideId });
      return patches.length > 0 ? patches : null;
    }
    case "connector-detached": {
      const patches = boundsPatches({ ...check, slideId: effectiveSlideId });
      return patches.length > 0 ? patches : null;
    }
    case "font-too-small": {
      if (!elementId) return null;
      return [{
        operation: "updateStyle",
        targetElementId: elementId,
        slideId: effectiveSlideId,
        changes: { style: { fontSize: 12 }, suggestionKind: kind }
      }];
    }
    case "card-spacing-tight": {
      if (!elementId) return null;
      const token = check.suggestion?.padding ?? "spacing.md";
      return [{
        operation: "increaseSpacing",
        targetElementId: elementId,
        slideId: effectiveSlideId,
        changes: { padding: token, suggestionKind: kind, _inches: resolveSpacingToken(token) }
      }];
    }
    case "text-overflow": {
      if (!elementId) return null;
      return [{
        operation: "reduceDensity",
        targetElementId: elementId,
        slideId: effectiveSlideId,
        changes: { suggestionKind: kind }
      }];
    }
    case "line-height-too-tight": {
      if (!elementId) return null;
      return [adjustStylePatch({ ...check, slideId: effectiveSlideId }, { style: { lineHeight: 1.4 } })];
    }
    case "letter-spacing-too-tight": {
      if (!elementId) return null;
      return [adjustStylePatch({ ...check, slideId: effectiveSlideId }, { style: { letterSpacing: 0 } })];
    }
    case "contrast-fail": {
      if (!elementId) return null;
      return [adjustStylePatch({ ...check, slideId: effectiveSlideId }, { style: { color: "#000000" } })];
    }
    default:
      return null;
  }
}

export function convertSuggestions(checks, slideId) {
  if (!Array.isArray(checks)) return [];
  const out = [];
  for (const check of checks) {
    const result = convertOne(check, slideId);
    if (result == null) continue;
    if (Array.isArray(result)) {
      for (const patch of result) out.push(patch);
    } else {
      out.push(result);
    }
  }
  return out;
}
