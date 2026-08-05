function probe({ passed, code, scope, measured, expected, severity = "warning", repairClass = "composition" }) {
  return {
    passed,
    code,
    dimension: "visual",
    severity,
    scope,
    measured,
    expected,
    repairClass,
    owner: "renderer"
  };
}
function longestFamilyRun(slides) {
  let longest = 0;
  let currentFamily = null;
  let current = 0;
  for (const slide of slides) {
    if (slide.family === currentFamily) current += 1;
    else {
      currentFamily = slide.family;
      current = 1;
    }
    longest = Math.max(longest, current);
  }
  return longest;
}

/**
 * Converts browser-collected slide snapshots into explicit, slide-safe probes.
 * These are evidence and warnings; they do not make aesthetic decisions for
 * the Host and do not mutate the generated deck.
 */
export function buildVisualProbes(slides = [], policy = {}) {
  const snapshots = Array.isArray(slides) ? slides : [];
  const maxConsecutiveFamily = policy.renderControls?.maxConsecutiveFamily ?? 2;
  const decoratedSlides = snapshots.filter((slide) => slide.decorationCount > 0).length;
  const decorationRatio = snapshots.length === 0 ? 0 : decoratedSlides / snapshots.length;
  const nestedCardCount = snapshots.reduce((total, slide) => total + (slide.nestedCardCount ?? 0), 0);
  const sourceTruncationCount = snapshots.filter((slide) => slide.sourceTruncated).length;
  const familyRun = longestFamilyRun(snapshots);
  const probes = [
    probe({
      passed: familyRun <= maxConsecutiveFamily,
      code: "W_LAYOUT_FAMILY_STREAK",
      scope: "deck",
      measured: { longestRun: familyRun },
      expected: { maximum: maxConsecutiveFamily }
    }),
    probe({
      passed: decorationRatio <= 0.75,
      code: "W_DECORATION_SATURATION",
      scope: "deck",
      measured: { decoratedSlides, slideCount: snapshots.length, ratio: Number(decorationRatio.toFixed(3)) },
      expected: { maximumRatio: 0.75 }
    }),
    probe({
      passed: nestedCardCount === 0,
      code: "W_NESTED_CARD",
      scope: "deck",
      measured: { nestedCardCount },
      expected: { nestedCardCount: 0 }
    }),
    probe({
      passed: sourceTruncationCount === 0,
      code: "W_SOURCE_TRUNCATION",
      scope: "deck",
      measured: { sourceTruncationCount },
      expected: { sourceTruncationCount: 0 },
      repairClass: "source-wrap"
    })
  ];
  return {
    version: "1.0.0",
    metrics: { decoratedSlides, decorationRatio, nestedCardCount, sourceTruncationCount, familyRun },
    probes
  };
}
