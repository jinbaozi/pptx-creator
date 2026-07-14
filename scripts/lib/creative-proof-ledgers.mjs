import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { canonicalTokenSnapshotHash } from "./semantic-slide-ir.mjs";
import { isSafeAssetRuntimePath } from "./registry.mjs";

const hashBytes = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function tokenDrift(field, expected, actual) {
  return { field, expected: expected ?? null, actual: actual ?? null };
}

export function buildTokenLedger({ ir, design, manifest } = {}) {
  const expectedSnapshotHash = ir?.designSystem?.tokenSnapshotHash ?? null;
  const actualSnapshotHash = design?.tokens ? canonicalTokenSnapshotHash(design.tokens) : null;
  const expectedName = ir?.designSystem?.name ?? null;
  const expectedSource = ir?.designSystem?.source ?? null;
  const actualName = manifest?.designSystem?.name ?? design?.name ?? null;
  const actualSource = manifest?.designSystem?.source ?? design?.source ?? null;
  const protectedNames = ir?.designIntent?.locks?.protectedTokens ?? [];
  const drift = [];
  if (!expectedSnapshotHash || !actualSnapshotHash) {
    return {
      version: "0.1.0",
      status: "unavailable",
      expectedSnapshotHash,
      actualSnapshotHash,
      designSystem: { name: actualName, source: actualSource },
      protectedTokens: protectedNames.map((name) => ({ name, status: "unavailable" })),
      drift: [tokenDrift("tokenSnapshotHash", expectedSnapshotHash, actualSnapshotHash)],
      lineage: "snapshot-only"
    };
  }
  if (expectedSnapshotHash !== actualSnapshotHash) drift.push(tokenDrift("tokenSnapshotHash", expectedSnapshotHash, actualSnapshotHash));
  if (expectedName !== actualName) drift.push(tokenDrift("designSystem.name", expectedName, actualName));
  if (expectedSource !== actualSource) drift.push(tokenDrift("designSystem.source", expectedSource, actualSource));
  const passed = drift.length === 0;
  return {
    version: "0.1.0",
    status: passed ? "passed" : "failed",
    expectedSnapshotHash,
    actualSnapshotHash,
    designSystem: { name: actualName, source: actualSource },
    protectedTokens: protectedNames.map((name) => ({ name, status: passed ? "snapshot-bound" : "drifted" })),
    drift,
    lineage: "snapshot-only"
  };
}

function assetDrift(assetId, field, expected, actual) {
  return { assetId, field, expected: expected ?? null, actual: actual ?? null };
}

function manifestUsage(manifest, assetId) {
  return (manifest?.slides ?? []).filter((slide) => (slide.elements ?? []).some((element) => element?.assetId === assetId)).map((slide) => slide.id);
}

function irUsage(ir, assetId) {
  return (ir?.slides ?? []).filter((slide) => (slide.assetRefs ?? []).includes(assetId)).map((slide) => slide.id);
}

function manifestAssetById(manifest, assetId) {
  return (manifest?.assets ?? []).find((asset) => asset?.id === assetId) ?? null;
}

function normalizedIrSource(asset) {
  const provenance = asset?.provenance ?? {};
  return {
    origin: provenance.origin,
    sourceRef: provenance.sourceRef,
    ...(provenance.sourceUrl ? { sourceUrl: provenance.sourceUrl } : {})
  };
}

async function actualAssetHash(outputDir, localPath) {
  if (!isSafeAssetRuntimePath(localPath)) return null;
  const root = resolve(outputDir);
  const target = resolve(root, ...localPath.split("/"));
  if (!target.startsWith(`${root}${sep}`)) return null;
  try {
    const entry = await lstat(target);
    if (!entry.isFile() || entry.isSymbolicLink()) return null;
    return hashBytes(await readFile(target));
  } catch {
    return null;
  }
}

export async function buildAssetLedger({ ir, registry, manifest, outputDir } = {}) {
  if (!ir || !registry || !manifest || !outputDir || registry.version !== "0.2.0" || !Array.isArray(registry.assets)) {
    return { version: "0.1.0", status: "unavailable", assets: [], drift: [assetDrift("*", "inputs", "complete IR/registry/manifest/outputDir", "missing")] };
  }
  const irAssets = new Map((ir.assets ?? []).map((asset) => [asset.id, asset]));
  const ledgerAssets = [];
  const drift = [];
  for (const registryAsset of registry.assets) {
    const id = registryAsset.id;
    const irAsset = irAssets.get(id) ?? null;
    const manifestAsset = manifestAssetById(manifest, id);
    const expectedHash = registryAsset.contentHash ?? null;
    const actualHash = await actualAssetHash(outputDir, registryAsset.localPath);
    const expectedUsage = registryAsset.usedInSlides ?? [];
    const semanticUsage = irUsage(ir, id);
    const renderedUsage = manifestUsage(manifest, id);
    const assetDriftEntries = [];
    if (!isSafeAssetRuntimePath(registryAsset.localPath)) assetDriftEntries.push(assetDrift(id, "localPath", "normalized path below assets/", registryAsset.localPath));
    if (actualHash !== expectedHash) assetDriftEntries.push(assetDrift(id, "contentHash", expectedHash, actualHash));
    if (!irAsset) assetDriftEntries.push(assetDrift(id, "ir.asset", "present", "missing"));
    if (!manifestAsset) assetDriftEntries.push(assetDrift(id, "manifest.asset", "present", "missing"));
    if (!same(expectedUsage, semanticUsage) || !same(expectedUsage, renderedUsage)) {
      assetDriftEntries.push(assetDrift(id, "usage", expectedUsage, { ir: semanticUsage, manifest: renderedUsage }));
    }
    if (["embedded", "recreated-locally"].includes(registryAsset.finalDeckUse) && registryAsset.rights?.status === "unknown") {
      assetDriftEntries.push(assetDrift(id, "rights.status", "known embedded-use authority", "unknown"));
    }
    if (irAsset) {
      const comparisons = [
        ["source", normalizedIrSource(irAsset), registryAsset.source],
        ["rights", irAsset.provenance?.rights, registryAsset.rights],
        ["generation", irAsset.provenance?.generation ?? null, registryAsset.generation ?? null],
        ["role", irAsset.role, registryAsset.role],
        ["altText", irAsset.altText, registryAsset.altText],
        ["focalPoint", irAsset.focalPoint, registryAsset.focalPoint],
        ["cropPolicy", irAsset.cropPolicy, registryAsset.cropPolicy],
        ["fallback", irAsset.fallback, registryAsset.fallback],
        ["runtimePath", irAsset.src, registryAsset.localPath]
      ];
      for (const [field, expected, actual] of comparisons) {
        if (!same(expected, actual)) assetDriftEntries.push(assetDrift(id, field, expected, actual));
      }
    }
    if (manifestAsset && irAsset) {
      for (const [field, expected, actual] of [
        ["manifest.altText", irAsset.altText, manifestAsset.altText],
        ["manifest.focalPoint", irAsset.focalPoint, manifestAsset.focalPoint],
        ["manifest.cropPolicy", irAsset.cropPolicy, manifestAsset.cropPolicy],
        ["manifest.runtimePath", registryAsset.localPath, manifestAsset.src]
      ]) {
        if (!same(expected, actual)) assetDriftEntries.push(assetDrift(id, field, expected, actual));
      }
    }
    drift.push(...assetDriftEntries);
    ledgerAssets.push({
      id,
      role: registryAsset.role,
      source: structuredClone(registryAsset.source),
      rights: structuredClone(registryAsset.rights),
      ...(registryAsset.generation ? { generation: structuredClone(registryAsset.generation) } : {}),
      localPath: registryAsset.localPath,
      expectedHash,
      actualHash,
      irUsage: semanticUsage,
      manifestUsage: renderedUsage,
      altText: registryAsset.altText,
      focalPoint: registryAsset.focalPoint,
      cropPolicy: registryAsset.cropPolicy,
      fallback: structuredClone(registryAsset.fallback),
      status: assetDriftEntries.length === 0 ? "passed" : "failed"
    });
  }
  for (const asset of ir.assets ?? []) {
    if (!(registry.assets ?? []).some((entry) => entry.id === asset.id)) drift.push(assetDrift(asset.id, "registry.asset", "present", "missing"));
  }
  return { version: "0.1.0", status: drift.length === 0 ? "passed" : "failed", assets: ledgerAssets, drift };
}
