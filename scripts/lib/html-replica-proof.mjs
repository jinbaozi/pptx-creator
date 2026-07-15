import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runPython } from "./python-utils.mjs";
import { measureHtmlReplicaEvidence, replicaThresholds } from "./replica-evidence.mjs";

export async function renderAndMeasureHtmlReplica({ root, outputDir, sourcePaths, sourceArtifactPath, manifest, measurements, coverage, buildBaseEvidence, policyRoute="html", pptxPath=join(outputDir,"final.pptx"), renderDir=join(outputDir,"evidence","render"), retryCount=0 }) {
  await mkdir(renderDir, { recursive: true });
  const renderReport = JSON.parse((await runPython([join(root, "scripts/render-preview.py"), pptxPath, renderDir], { cwd: root })).stdout);
  if (renderReport.status !== "ok" || renderReport.previews?.length !== sourcePaths.length) {
    throw new Error(`LibreOffice replica render page mismatch: source=${sourcePaths.length}, render=${renderReport.previews?.length ?? 0}; ${renderReport.note}`);
  }
  const renderPaths = renderReport.previews.map((item) => resolve(item));
  const base = await buildBaseEvidence({ renderPath: renderDir, retryCount });
  const raw = {
    ...base,
    route: policyRoute,
    paths: { source: { status: "available", path: sourceArtifactPath }, render: { status: "available", path: renderDir } },
    capabilities: { ...base.capabilities, sourceRenderComparison: true },
    thresholds: replicaThresholds(policyRoute),
    retry: { status: "available", attempts: Array.from({length:retryCount},(_,index)=>({iteration:index+1,outcome:"measured"})) },
    perSlide: base.perSlide.map((page, index) => ({
      ...page, slideIndex: index,
      nativeCoverage: { status: "available", value: Number(coverage.slides?.[index]?.nativeCoverage ?? coverage.nativeCoverage ?? coverage.coverage) }
    })),
    blockingFindings: (base.blockingFindings ?? []).filter((item) => item.includes("structural-proof"))
  };
  return measureHtmlReplicaEvidence(raw, {
    sourceArtifactPath, renderArtifactPath: renderDir,
    pptxPath, manifest, measurements
  });
}
