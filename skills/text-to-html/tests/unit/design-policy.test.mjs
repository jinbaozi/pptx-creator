import assert from "node:assert/strict";
import test from "node:test";
import { compileDesignPolicy } from "../../scripts/lib/design-policy.mjs";

test("design policy renders finite controls and preserves free-text advisory metadata", () => {
  const policy = compileDesignPolicy({
    proposition: "把复杂问题讲清楚",
    counterProposition: "不要堆砌模块",
    mood: ["克制"],
    referenceSignals: ["editorial"],
    themeId: "editorial-magazine",
    compositionDiversity: "high",
    motionIntensity: "subtle",
    informationDensity: "sparse",
    imageryStrategy: "本地素材",
    allowedTechniques: ["结构化排版"],
    forbiddenTechniques: ["整页栅格替代"],
    tokenOverrides: {}
  });

  assert.equal(policy.renderControls.variantPool, 3);
  assert.equal(policy.renderControls.maxConsecutiveFamily, 1);
  assert.equal(policy.renderControls.spacingClass, "density-sparse");
  assert.equal(policy.renderControls.dataMotion, "subtle");
  assert.equal(policy.renderControls.runtimeAnimation, false);
  assert.equal(policy.hostAdvisory.proposition, "把复杂问题讲清楚");
  assert.equal(policy.coverage.proposition, "host-reviewed-only");
  assert.match(policy.sha256, /^[a-f0-9]{64}$/);
});
test("unknown or omitted controls use deterministic safe defaults", () => {
  const policy = compileDesignPolicy({ themeId: "legacy-default", tokenOverrides: {} });
  assert.equal(policy.renderControls.compositionDiversity, "medium");
  assert.equal(policy.renderControls.informationDensity, "balanced");
  assert.equal(policy.renderControls.motionIntensity, "none");
  assert.equal(policy.renderControls.runtimeAnimation, false);
});
