import {
  ADVERTISED_ARCHETYPES,
  buildPlanFromBriefFixture,
  compileLegacyDeckPlan,
  geometrySignature,
  getArchetypeRegistry,
  validateDeckPlan
} from "./deck-plan-core.mjs";
import { compileDeckPlanToIr, compileSemanticDeckIr } from "./semantic-slide-ir.mjs";
import { resolvedDeckPlanDesign } from "./deck-plan-core.mjs";

export {
  ADVERTISED_ARCHETYPES,
  buildPlanFromBriefFixture,
  geometrySignature,
  getArchetypeRegistry,
  validateDeckPlan
};

export function compileDeckPlanArtifacts(plan, options = {}) {
  const ir = compileDeckPlanToIr(plan, options);
  return {
    ir,
    manifest: compileSemanticDeckIr(ir, { design: resolvedDeckPlanDesign(options) })
  };
}

export function compileDeckPlan(plan, options = {}) {
  return compileDeckPlanArtifacts(plan, options).manifest;
}
