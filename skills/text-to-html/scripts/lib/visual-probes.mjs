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
function longestRun(slides, key) {
  let longest = 0;
  let currentValue = null;
  let current = 0;
  for (const slide of slides) {
    const value = slide[key] ?? slide.family ?? "unknown";
    if (value === currentValue) current += 1;
    else {
      currentValue = value;
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
  const titleOrphanCount = snapshots.filter((slide) => slide.titleOrphan).length;
  const familyRun = longestRun(snapshots, "family");
  const silhouetteRun = longestRun(snapshots, "silhouette");
  const probes = [
    probe({
      passed: familyRun <= maxConsecutiveFamily,
      code: "W_LAYOUT_FAMILY_STREAK",
      scope: "deck",
      measured: { longestRun: familyRun },
      expected: { maximum: maxConsecutiveFamily }
    }),
    probe({
      passed: silhouetteRun <= maxConsecutiveFamily,
      code: "W_LAYOUT_SILHOUETTE_STREAK",
      scope: "deck",
      measured: { longestRun: silhouetteRun },
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
      passed: titleOrphanCount === 0,
      code: "W_TITLE_ORPHAN",
      scope: "deck",
      measured: { titleOrphanCount },
      expected: { titleOrphanCount: 0 },
      repairClass: "title-wrap"
    })
  ];
  return {
    version: "1.0.0",
    metrics: { decoratedSlides, decorationRatio, nestedCardCount, sourceTruncationCount, titleOrphanCount, familyRun, silhouetteRun },
    probes
  };
}
