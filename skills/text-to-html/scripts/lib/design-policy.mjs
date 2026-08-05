import { sha256Text } from "./utils.mjs";

const DIVERSITY_RULES = Object.freeze({
  low: Object.freeze({ variantPool: 1, maxConsecutiveFamily: 3 }),
  medium: Object.freeze({ variantPool: 2, maxConsecutiveFamily: 2 }),
  high: Object.freeze({ variantPool: 3, maxConsecutiveFamily: 1 })
});

const DENSITY_RULES = Object.freeze({
  sparse: Object.freeze({ spacingClass: "density-sparse", maxTextLines: 2 }),
  balanced: Object.freeze({ spacingClass: "density-balanced", maxTextLines: 3 }),
  dense: Object.freeze({ spacingClass: "density-dense", maxTextLines: 4 })
});

const MOTION_RULES = Object.freeze({
  none: Object.freeze({ dataMotion: "none", runtimeAnimation: false }),
  subtle: Object.freeze({ dataMotion: "subtle", runtimeAnimation: false }),
  expressive: Object.freeze({ dataMotion: "expressive", runtimeAnimation: false })
});

function pickRule(table, value, fallback) {
  return table[value] ?? table[fallback];
}
/**
 * Compiles the finite design controls in designIntent into renderer-safe policy.
 * Free-text creative direction remains host-owned and is preserved as advisory
 * metadata rather than being guessed by the deterministic renderer.
 */
export function compileDesignPolicy(designIntent = {}) {
  const diversity = designIntent.compositionDiversity ?? "medium";
  const density = designIntent.informationDensity ?? "balanced";
  const motion = designIntent.motionIntensity ?? "none";
  const diversityRule = pickRule(DIVERSITY_RULES, diversity, "medium");
  const densityRule = pickRule(DENSITY_RULES, density, "balanced");
  const motionRule = pickRule(MOTION_RULES, motion, "none");
  const policy = {
    version: "1.0.0",
    renderControls: {
      themeId: designIntent.themeId,
      compositionDiversity: diversity,
      informationDensity: density,
      motionIntensity: motion,
      variantPool: diversityRule.variantPool,
      maxConsecutiveFamily: diversityRule.maxConsecutiveFamily,
      spacingClass: densityRule.spacingClass,
      maxTextLines: densityRule.maxTextLines,
      dataMotion: motionRule.dataMotion,
      runtimeAnimation: motionRule.runtimeAnimation,
      tokenOverrides: structuredClone(designIntent.tokenOverrides ?? {})
    },
    hostAdvisory: {
      proposition: designIntent.proposition ?? null,
      counterProposition: designIntent.counterProposition ?? null,
      mood: structuredClone(designIntent.mood ?? []),
      referenceSignals: structuredClone(designIntent.referenceSignals ?? []),
      imageryStrategy: designIntent.imageryStrategy ?? null,
      allowedTechniques: structuredClone(designIntent.allowedTechniques ?? []),
      forbiddenTechniques: structuredClone(designIntent.forbiddenTechniques ?? [])
    },
    coverage: {
      proposition: "host-reviewed-only",
      counterProposition: "host-reviewed-only",
      mood: "host-reviewed-only",
      referenceSignals: "host-reviewed-only",
      imageryStrategy: "host-reviewed-only",
      allowedTechniques: "host-reviewed-only",
      forbiddenTechniques: "host-reviewed-only",
      themeId: "rendered",
      compositionDiversity: "rendered",
      informationDensity: "rendered",
      motionIntensity: "rendered",
      tokenOverrides: "rendered"
    }
  };
  return {
    ...policy,
    sha256: sha256Text(JSON.stringify(policy))
  };
}
