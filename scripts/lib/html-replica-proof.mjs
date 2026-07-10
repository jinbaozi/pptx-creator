import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runPython } from "./python-utils.mjs";
import { bindReplicaMeasurementReceipt, evaluateMeasuredReplicaEvidence, replicaThresholds } from "./replica-evidence.mjs";

const available = (value) => ({ status: "available", value });
const unavailable = (reason) => ({ status: "unavailable", value: null, reason });

function percentile95(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1)];
}

function mappingMetrics(measurements, manifest) {
  const byId = new Map((manifest.slides ?? []).flatMap((slide) => slide.elements ?? []).map((item) => [item.id, item]));
  const viewport = measurements.viewport;
  const size = manifest.deck.size;
  const drifts = [];
  let fonts = 0; let fontsMapped = 0; let colors = 0; let colorsMapped = 0;
  for (const source of measurements.elements ?? []) {
    const target = byId.get(source.id) ?? byId.get(`${source.id}-box`);
    if (!target) continue;
    const expected = source.px;
    const actual = { x: target.x / size.width * viewport.width, y: target.y / size.height * viewport.height, w: target.w / size.width * viewport.width, h: target.h / size.height * viewport.height };
    drifts.push(Math.max(...["x", "y", "w", "h"].map((key) => Math.abs(Number(expected[key]) - Number(actual[key])))));
    if (source.kind === "text" && source.style?.fontFamily) {
      fonts += 1;
      const sourceFamily = String(source.style.fontFamily).split(",")[0].replace(/["']/g, "").trim().toLowerCase();
      const targetFamily = String(target.style?.fontFamily ?? target.style?.fontFace ?? "").split(",")[0].replace(/["']/g, "").trim().toLowerCase();
      if (sourceFamily && sourceFamily === targetFamily) fontsMapped += 1;
    }
    const sourceColors = [];
    if (source.kind === "text" && source.style?.color) sourceColors.push(source.style.color);
    if (source.style?.backgroundColor && source.style?.backgroundTransparency !== 100) sourceColors.push(source.style.backgroundColor);
    if ((source.style?.borderWidth ?? 0) > 0 && source.style?.borderColor) sourceColors.push(source.style.borderColor);
    if (source.style?.backgroundImage) sourceColors.push(...String(source.style.backgroundImage).match(/#[0-9a-f]{6}/gi) ?? []);
    if (sourceColors.length) {
      colors += sourceColors.length;
      const encoded = JSON.stringify(target.style ?? {}).toLowerCase();
      colorsMapped += sourceColors.filter((color) => encoded.includes(String(color).replace("#", "").toLowerCase())).length;
    }
  }
  return {
    bboxP95Drift: drifts.length ? available(Number(percentile95(drifts).toFixed(4))) : unavailable("no-mapped-boxes"),
    fontMapping: fonts ? available(fontsMapped / fonts) : unavailable("no-font-bearing-elements"),
    colorMapping: colors ? available(colorsMapped / colors) : unavailable("no-color-bearing-elements")
  };
}

export async function renderAndMeasureHtmlReplica({ root, outputDir, sourcePaths, manifest, measurements, coverage, intermediate, buildBaseEvidence }) {
  const previewDir = join(outputDir, "preview");
  await mkdir(previewDir, { recursive: true });
  const renderReport = JSON.parse((await runPython([join(root, "scripts/render-preview.py"), join(outputDir, "final.pptx"), previewDir], { cwd: root })).stdout);
  if (renderReport.status !== "ok" || !renderReport.previews?.length) throw new Error(`LibreOffice replica render unavailable: ${renderReport.note}`);
  const renderPath = resolve(renderReport.previews[0]);
  const sourcePath = resolve(sourcePaths[0]);
  const normalizedRender = join(previewDir, "slide-001.png");
  const pixel = JSON.parse((await runPython([join(root, "scripts/measure-replica.py"), sourcePath, renderPath, "--normalized-render", normalizedRender], { cwd: root })).stdout);
  const mapped = mappingMetrics(measurements, manifest);
  const fidelity = { ssim: available(pixel.ssim), normalizedMae: available(pixel.normalizedMae), ...mapped };
  const base = await buildBaseEvidence({ renderPath: normalizedRender, retryCount: 0 });
  const page = {
    slideIndex: 0,
    fidelity,
    nativeCoverage: available(Number(coverage.nativeCoverage ?? coverage.coverage)),
    editability: base.perSlide[0].editability,
    fallbacks: base.perSlide[0].fallbacks
  };
  const raw = {
    ...base,
    paths: { source: { status: "available", path: sourcePath }, render: { status: "available", path: normalizedRender } },
    capabilities: { ...base.capabilities, sourceRenderComparison: true },
    thresholds: replicaThresholds("html"),
    retry: { status: "available", attempts: [{ iteration: 0, ssim: pixel.ssim, normalizedMae: pixel.normalizedMae, outcome: "measured" }] },
    source: { pageCount: 1, size: { width: pixel.sourceSize.width, height: pixel.sourceSize.height } },
    render: { pageCount: 1, size: { width: pixel.renderSize.width, height: pixel.renderSize.height } },
    perSlide: [page], aggregate: { ...page, slideIndex: undefined },
    blockingFindings: (base.blockingFindings ?? []).filter((item) => item.includes("structural-proof"))
  };
  delete raw.aggregate.slideIndex;
  const receipt = await bindReplicaMeasurementReceipt(sourcePath, normalizedRender, { perSlide: raw.perSlide, aggregate: raw.aggregate });
  return evaluateMeasuredReplicaEvidence(raw, receipt);
}
