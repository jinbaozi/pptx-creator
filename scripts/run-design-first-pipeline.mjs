import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { compileDeckPlanArtifacts, validateDeckPlan } from "./lib/deck-plan.mjs";
import { loadCompositionBlockRegistry } from "./lib/composition-blocks.mjs";
import { resolveDesignSystem } from "./lib/design-system-resolver.mjs";
import { createFontMetricsCatalog } from "./lib/font-preflight.mjs";
import {
  CREATIVE_ASSET_OWNER,
  CREATIVE_ASSET_OWNERSHIP_VERSION,
  assertNoSymlinkBelowTrustedAnchor,
  canonicalAssetRegistryText,
  isSafeAssetRuntimePath,
  validateAssetRegistry,
  verifiedCreativeOwnedAssetPaths
} from "./lib/registry.mjs";
import { buildRunIndex, contentDerivedRunId } from "./lib/run-index.mjs";
import { fitManifestText, materializeTextFonts } from "./lib/text-fit.mjs";
import { invalidatePublishedOutputs, runDeckPipeline } from "./run-deck-pipeline.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compositionBlockRegistry = loadCompositionBlockRegistry(path.join(projectRoot, "composition-blocks"));
const remoteReference = /^[a-z][a-z0-9+.-]*:/i;
const CREATIVE_ASSET_REGISTRY = ".pptx-generated-assets.json";

function parseArgs(argv) {
  const [inputDir, outputDir, ...rest] = argv;
  if (!inputDir || !outputDir) {
    throw new Error("Usage: node scripts/run-design-first-pipeline.mjs <deck.plan.json|input-dir> <output-dir> [--design-system <path-or-name>]");
  }
  const options = { mode: "creative" };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--design-system") {
      const value = rest[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--design-system requires a value");
      options.designSystem = value;
      i += 1;
    } else if (rest[i] === "--mode") {
      const value = rest[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--mode requires a value");
      options.mode = value;
      i += 1;
      if (options.mode !== "creative") throw new Error("deck.plan pipeline supports creative mode only");
    } else throw new Error(`unknown option: ${rest[i]}`);
  }
  return { inputDir, outputDir, options };
}

function localizedAssetName(asset, bytes, sourcePath) {
  const safeId = String(asset.id).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "asset";
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  const extension = path.extname(sourcePath).toLowerCase() || ".bin";
  return `${safeId}-${digest}${extension}`;
}

function assertRealCreativeOutputDirectory(outputDir, { create = false } = {}) {
  const outputRoot = path.resolve(outputDir);
  assertNoSymlinkBelowTrustedAnchor(outputRoot, { allowMissing: true });
  if (create) fs.mkdirSync(outputRoot, { recursive: true });
  assertNoSymlinkBelowTrustedAnchor(outputRoot, { allowMissing: false });
  let entry;
  try { entry = fs.lstatSync(outputRoot); } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`creative output must be an existing real directory: ${outputRoot}`);
    throw error;
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`creative output must be a real directory, not a symbolic link: ${outputRoot}`);
  }
  return outputRoot;
}

function assertSafeCreativePublicationTarget(outputRoot, target, { allowTargetSymlink = false } = {}) {
  assertRealCreativeOutputDirectory(outputRoot);
  const relativeTarget = path.relative(outputRoot, target);
  if (relativeTarget === "" || relativeTarget === ".." || relativeTarget.startsWith(`..${path.sep}`)) {
    throw new Error(`creative authoring target escapes output directory: ${target}`);
  }
  let cursor = outputRoot;
  for (const segment of path.dirname(relativeTarget).split(path.sep).filter((part) => part && part !== ".")) {
    cursor = path.join(cursor, segment);
    let entry;
    try { entry = fs.lstatSync(cursor); } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`creative authoring path must not traverse a symbolic link: ${cursor}`);
    }
  }
  try {
    if (!allowTargetSymlink && fs.lstatSync(target).isSymbolicLink()) {
      throw new Error(`creative authoring target must not be a symbolic link: ${target}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function unlinkCreativePublicationLeaf(outputRoot, target) {
  assertSafeCreativePublicationTarget(outputRoot, target, { allowTargetSymlink: true });
  let entry;
  try { entry = await fs.promises.lstat(target); } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!entry.isFile() && !entry.isSymbolicLink()) {
    throw new Error(`creative rollback target must be a regular file or leaf symlink: ${target}`);
  }
  await fs.promises.unlink(target);
}

async function atomicPublishCreativeBytes(outputRoot, target, bytes, {
  allowExistingTargetSymlink = false
} = {}) {
  const targetGuard = () => assertSafeCreativePublicationTarget(outputRoot, target, {
    allowTargetSymlink: allowExistingTargetSymlink
  });
  targetGuard();
  const parent = path.dirname(target);
  await fs.promises.mkdir(parent, { recursive: true });
  targetGuard();
  const stageDir = await fs.promises.mkdtemp(path.join(parent, `.creative-stage-${process.pid}-`));
  const stageFile = path.join(stageDir, "artifact");
  let renamed = false;
  try {
    assertSafeCreativePublicationTarget(outputRoot, stageDir);
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW ?? 0);
    const handle = await fs.promises.open(stageFile, flags, 0o600);
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
    const stageDirEntry = await fs.promises.lstat(stageDir);
    const stageFileEntry = await fs.promises.lstat(stageFile);
    if (!stageDirEntry.isDirectory() || stageDirEntry.isSymbolicLink()
      || !stageFileEntry.isFile() || stageFileEntry.isSymbolicLink()) {
      throw new Error(`creative stage must remain a real directory with a regular file: ${stageDir}`);
    }
    targetGuard();
    await fs.promises.rename(stageFile, target);
    renamed = true;
    assertSafeCreativePublicationTarget(outputRoot, target);
    const targetEntry = await fs.promises.lstat(target);
    if (!targetEntry.isFile() || targetEntry.isSymbolicLink()) {
      throw new Error(`creative publication target is not a regular file: ${target}`);
    }
    await fs.promises.rmdir(stageDir);
  } catch (error) {
    if (renamed) await unlinkCreativePublicationLeaf(outputRoot, target).catch(() => {});
    await fs.promises.rm(stageFile, { force: true }).catch(() => {});
    await fs.promises.rmdir(stageDir).catch(() => {});
    throw error;
  }
}

function assertRealAssetsDirectory(outputDir, { allowMissing = true } = {}) {
  const outputRoot = assertRealCreativeOutputDirectory(outputDir);
  const assetsRoot = path.resolve(outputRoot, "assets");
  let entry;
  try { entry = fs.lstatSync(assetsRoot); } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return assetsRoot;
    throw error;
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`creative assets root must be a real directory: ${assetsRoot}`);
  }
  return assetsRoot;
}

function removePreviouslyLocalizedAssets(outputDir, protectedPaths) {
  const ownershipPath = path.resolve(outputDir, CREATIVE_ASSET_REGISTRY);
  let registry;
  try { registry = JSON.parse(fs.readFileSync(ownershipPath, "utf8")); } catch { return; }
  const outputRoot = path.resolve(outputDir);
  assertRealAssetsDirectory(outputRoot);
  for (const candidate of verifiedCreativeOwnedAssetPaths(outputRoot, registry, protectedPaths)) {
    fs.rmSync(candidate, { force: true });
  }
  fs.rmSync(ownershipPath, { force: true });
}

function localizePlanAssets(plan, planPath, outputDir) {
  const planDirectory = path.dirname(path.resolve(planPath));
  const actualSourcePaths = plan.assets.flatMap((asset) => {
    const sourceRef = asset.provenance.sourceRef;
    if (remoteReference.test(sourceRef) || sourceRef.startsWith("//")) return [];
    const candidate = path.isAbsolute(sourceRef) ? path.resolve(sourceRef) : path.resolve(planDirectory, sourceRef);
    return fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? [candidate] : [];
  });
  removePreviouslyLocalizedAssets(outputDir, actualSourcePaths);
  const assetsRoot = assertRealAssetsDirectory(outputDir);
  const assets = plan.assets.map((asset) => {
    const sourceRef = asset.provenance.sourceRef;
    if (remoteReference.test(sourceRef) || sourceRef.startsWith("//")) {
      throw new Error(`asset ${asset.id} uses a remote sourceRef; localize it before running the creative pipeline`);
    }
    const sourcePath = path.isAbsolute(sourceRef) ? path.resolve(sourceRef) : path.resolve(planDirectory, sourceRef);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      throw new Error(`asset ${asset.id} source file not found: ${sourcePath}`);
    }
    const bytes = fs.readFileSync(sourcePath);
    const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (asset.provenance.contentHash !== undefined && asset.provenance.contentHash !== contentHash) {
      throw new Error(`asset ${asset.id} declared contentHash does not match localized bytes`);
    }
    const fileName = localizedAssetName(asset, bytes, sourcePath);
    const targetPath = path.resolve(outputDir, "assets", fileName);
    return {
      asset,
      sourcePath,
      targetPath,
      relativePath: path.posix.join("assets", fileName),
      bytes,
      contentHash,
      targetExisted: fs.existsSync(targetPath)
    };
  });

  if (assets.length > 0) {
    fs.mkdirSync(assetsRoot, { recursive: true });
    assertRealAssetsDirectory(outputDir, { allowMissing: false });
  }
  for (const asset of assets) {
    if (asset.sourcePath === asset.targetPath || !asset.targetExisted) continue;
    let targetEntry;
    try { targetEntry = fs.lstatSync(asset.targetPath); } catch { targetEntry = null; }
    if (!targetEntry?.isFile() || !fs.readFileSync(asset.targetPath).equals(asset.bytes)) {
      throw new Error(`asset ${asset.asset.id} content-hash target collision: ${asset.targetPath}`);
    }
  }
  const createdTargets = [];
  try {
    for (const asset of assets) {
      if (asset.sourcePath === asset.targetPath || asset.targetExisted) continue;
      assertRealAssetsDirectory(outputDir, { allowMissing: false });
      const fileDescriptor = fs.openSync(asset.targetPath, "wx");
      createdTargets.push(asset.targetPath);
      try { fs.writeFileSync(fileDescriptor, asset.bytes); } finally { fs.closeSync(fileDescriptor); }
    }
  } catch (error) {
    for (const targetPath of createdTargets.reverse()) fs.rmSync(targetPath, { force: true });
    throw error;
  }
  const ownedAssets = assets.filter((asset) => asset.sourcePath !== asset.targetPath && !asset.targetExisted);
  const ownershipPath = path.resolve(outputDir, CREATIVE_ASSET_REGISTRY);
  return {
    sourceById: Object.fromEntries(assets.map((asset) => [asset.asset.id, asset.relativePath])),
    protectedPaths: assets.flatMap((asset) => [asset.sourcePath, asset.targetPath]),
    ownershipPath,
    ownership: {
      version: CREATIVE_ASSET_OWNERSHIP_VERSION,
      owner: CREATIVE_ASSET_OWNER,
      files: ownedAssets.map((asset) => asset.relativePath)
    },
    createdTargets,
    records: assets
  };
}

function cleanupLocalizedPlanAssets(localizedAssets) {
  for (const targetPath of localizedAssets.createdTargets) fs.rmSync(targetPath, { force: true });
  fs.rmSync(localizedAssets.ownershipPath, { force: true });
}

function snapshotLocalizedAssetEvidence(localizedAssets) {
  return {
    records: localizedAssets.records.map((record) => ({
      asset: structuredClone(record.asset),
      relativePath: record.relativePath,
      ...(record.sourcePath ? { sourcePath: record.sourcePath } : {}),
      ...(record.targetPath ? { targetPath: record.targetPath } : {}),
      ...(record.contentHash ? { contentHash: record.contentHash } : {}),
      ...(Object.prototype.hasOwnProperty.call(record, "targetExisted") ? { targetExisted: record.targetExisted } : {}),
      bytes: Buffer.isBuffer(record.bytes) ? Buffer.from(record.bytes) : structuredClone(record.bytes)
    }))
  };
}

function assertOrderedUniqueIds(label, ids, expectedIds = null) {
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} slide IDs must be unique`);
  }
  if (expectedIds && JSON.stringify(ids) !== JSON.stringify(expectedIds)) {
    throw new Error(`${label} slide order/membership does not match the plan`);
  }
}

function manifestAssetUsesBySlide(manifest) {
  return new Map((manifest?.slides ?? []).map((slide) => {
    if (slide.backgroundImage !== undefined) {
      throw new Error(`manifest ${slide.id} uses unsupported untracked backgroundImage`);
    }
    const background = slide.background?.type === "image"
      ? [{ ...slide.background, id: slide.background.id ?? "background", _creativeBackground: true }]
      : [];
    return [slide.id, [...background, ...(slide.elements ?? [])]];
  }));
}

function finalDeckUseForAsset(asset, usedInSlides, elementsBySlide, localPath) {
  const referencedElements = usedInSlides.flatMap((slideId) => (elementsBySlide.get(slideId) ?? [])
    .filter((element) => element?.assetId === asset.id)
    .map((element) => ({ slideId, element })));
  const imageElements = referencedElements.filter(({ element }) => ["image", "cropped-asset"].includes(element.type));
  for (const { slideId, element } of imageElements) {
    if (element.src !== localPath || !isSafeAssetRuntimePath(element.src)) {
      throw new Error(`asset ${asset.id} manifest image source drift on ${slideId}`);
    }
  }
  if (imageElements.length > 0) return "embedded";
  const expectedNativeType = asset.kind === "chart-data"
    ? "chart"
    : asset.kind === "diagram-source" ? "diagram" : null;
  if (expectedNativeType && referencedElements.some(({ element }) => element.type === expectedNativeType)) {
    return "recreated-locally";
  }
  return "not-embedded";
}

function canonicalAssetProjection(asset) {
  return {
    id: asset?.id,
    kind: asset?.kind,
    role: asset?.role,
    description: asset?.description,
    provenance: structuredClone(asset?.provenance),
    focalPoint: asset?.focalPoint,
    cropPolicy: asset?.cropPolicy,
    altText: asset?.altText,
    fallback: structuredClone(asset?.fallback)
  };
}

function assertCanonicalAssetProjection(label, actual, expected, src = null) {
  const actualProjection = canonicalAssetProjection(actual);
  const expectedProjection = canonicalAssetProjection(expected);
  if (!isDeepStrictEqual(actualProjection, expectedProjection)) {
    throw new Error(`${label} canonical asset contract does not match the plan`);
  }
  if (src !== null && actual?.src !== src) {
    throw new Error(`${label} canonical asset runtime source does not match localized evidence`);
  }
}

function assertFlattenedManifestProvenance(asset, expectedProvenance) {
  const allowedKeys = new Set([
    "id", "kind", "role", "description", "provenance", "focalPoint", "cropPolicy", "altText", "fallback", "src",
    "origin", "sourceRef", "sourceUrl", "contentHash", "rights", "generation"
  ]);
  const unexpected = Object.keys(asset).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new Error(`manifest asset ${asset.id} contains competing or unknown provenance fields: ${unexpected.join(", ")}`);
  }
  for (const key of ["origin", "sourceRef", "sourceUrl", "contentHash", "rights", "generation"]) {
    const expectedHas = Object.prototype.hasOwnProperty.call(expectedProvenance, key);
    const actualHas = Object.prototype.hasOwnProperty.call(asset, key);
    if (expectedHas !== actualHas || (expectedHas && !isDeepStrictEqual(asset[key], expectedProvenance[key]))) {
      throw new Error(`manifest asset ${asset.id} flattened provenance does not match canonical provenance`);
    }
  }
}

export function buildCanonicalAssetRegistry(plan, localizedAssets, manifest, ir = null) {
  const localizedRecords = localizedAssets?.records ?? [];
  const records = new Map(localizedRecords.map((record) => [record.asset.id, record]));
  const planAssets = new Map((plan?.assets ?? []).map((asset) => [asset.id, asset]));
  const expectedAssetIds = (plan?.assets ?? []).map((asset) => asset.id);
  const localizedAssetIds = localizedRecords.map((record) => record.asset?.id);
  if (new Set(localizedAssetIds).size !== localizedAssetIds.length
    || JSON.stringify(localizedAssetIds) !== JSON.stringify(expectedAssetIds)) {
    throw new Error("localized evidence asset order/membership does not match the plan");
  }
  for (const record of localizedRecords) {
    assertCanonicalAssetProjection(`localized evidence asset ${record.asset?.id ?? "unknown"}`, record.asset, planAssets.get(record.asset?.id));
  }
  const planSlideIds = (plan?.slides ?? []).map((slide) => slide.id);
  assertOrderedUniqueIds("plan", planSlideIds);
  const manifestSlideIds = (manifest?.slides ?? []).map((slide) => slide.id);
  assertOrderedUniqueIds("manifest", manifestSlideIds, planSlideIds);
  const planSlides = new Map((plan?.slides ?? []).map((slide) => [slide.id, slide]));
  const irSlides = ir ? new Map((ir.slides ?? []).map((slide) => [slide.id, slide])) : null;
  const elementsBySlide = manifestAssetUsesBySlide(manifest);

  const verifyArtifactAssets = (label, assets, { flattenedProvenance = false } = {}) => {
    const artifactIds = (assets ?? []).map((asset) => asset.id);
    if (new Set(artifactIds).size !== artifactIds.length
      || JSON.stringify(artifactIds) !== JSON.stringify(expectedAssetIds)) {
      throw new Error(`${label} asset order/membership does not match the plan`);
    }
    for (const artifactAsset of assets ?? []) {
      const localized = records.get(artifactAsset.id);
      if (!localized || artifactAsset.src !== localized.relativePath || !isSafeAssetRuntimePath(artifactAsset.src)) {
        throw new Error(`${label} asset ${artifactAsset.id} runtime source does not match localized evidence`);
      }
      const planAsset = planAssets.get(artifactAsset.id);
      assertCanonicalAssetProjection(`${label} asset ${artifactAsset.id}`, artifactAsset, planAsset, localized.relativePath);
      if (flattenedProvenance) assertFlattenedManifestProvenance(artifactAsset, planAsset.provenance);
    }
  };
  verifyArtifactAssets("manifest", manifest?.assets ?? [], { flattenedProvenance: true });
  if (ir) {
    verifyArtifactAssets("semantic IR", ir.assets ?? []);
    const irSlideIds = (ir.slides ?? []).map((slide) => slide.id);
    assertOrderedUniqueIds("semantic IR", irSlideIds, planSlideIds);
    for (const [slideId, planSlide] of planSlides) {
      if (JSON.stringify(irSlides.get(slideId)?.assetRefs ?? []) !== JSON.stringify(planSlide.assetIds ?? [])) {
        throw new Error(`semantic IR ${slideId} asset membership does not match the plan`);
      }
    }
  }

  for (const [slideId, elements] of elementsBySlide) {
    const planSlide = planSlides.get(slideId);
    if (!planSlide) throw new Error(`manifest contains unknown slide ${slideId}`);
    for (const element of elements) {
      const imageClass = ["image", "cropped-asset"].includes(element?.type);
      if (imageClass && !element?.assetId) {
        const location = element?._creativeBackground ? "background image" : `${element?.type ?? "image"} element`;
        throw new Error(`manifest ${slideId}/${element?.id ?? "element"} ${location} must carry a tracked assetId`);
      }
      if (!element?.assetId) continue;
      if (!planAssets.has(element.assetId)) {
        throw new Error(`manifest ${slideId}/${element.id ?? "element"} references unknown asset ${element.assetId}`);
      }
      if (!(planSlide.assetIds ?? []).includes(element.assetId)) {
        throw new Error(`manifest ${slideId}/${element.id ?? "element"} uses asset ${element.assetId} outside same-slide plan membership`);
      }
      if (irSlides && !(irSlides.get(slideId)?.assetRefs ?? []).includes(element.assetId)) {
        throw new Error(`manifest ${slideId}/${element.id ?? "element"} uses asset ${element.assetId} outside same-slide semantic IR membership`);
      }
      if (imageClass) {
        const localized = records.get(element.assetId);
        if (!localized || !isSafeAssetRuntimePath(element.src) || element.src !== localized.relativePath) {
          throw new Error(`manifest ${slideId}/${element.id ?? "element"} image src does not match canonical localized evidence`);
        }
        const canonical = planAssets.get(element.assetId);
        if (element.altText !== canonical.altText
          || (Object.prototype.hasOwnProperty.call(element, "alt") && element.alt !== canonical.altText)
          || element.focalPoint !== canonical.focalPoint
          || element.cropPolicy !== canonical.cropPolicy) {
          throw new Error(`manifest ${slideId}/${element.id ?? "element"} image asset contract does not match canonical asset metadata`);
        }
        if (element.type === "cropped-asset") {
          throw new Error(`manifest ${slideId}/${element.id ?? "element"} cropped-asset is unsupported in Creative mode because it cannot preserve canonical crop policy`);
        }
        if (element._creativeBackground) {
          throw new Error(`manifest ${slideId} background image is unsupported in Creative mode because it cannot preserve canonical crop policy`);
        }
        const expectedSizing = {
          type: ["contain", "none"].includes(canonical.cropPolicy) ? "contain" : "cover"
        };
        if (!isDeepStrictEqual(element.sizing, expectedSizing)) {
          throw new Error(`manifest ${slideId}/${element.id ?? "element"} image sizing does not match canonical crop policy`);
        }
      }
    }
  }

  const registry = {
    version: "0.2.0",
    assets: (plan?.assets ?? []).map((asset) => {
      const localized = records.get(asset.id);
      if (!localized || !isSafeAssetRuntimePath(localized.relativePath)) {
        throw new Error(`asset ${asset.id} has no verified localized registry record`);
      }
      let publicationBytes = localized.bytes;
      if (localized.targetPath) {
        const targetEntry = fs.lstatSync(localized.targetPath);
        if (!targetEntry.isFile() || targetEntry.isSymbolicLink()) {
          throw new Error(`asset ${asset.id} localized publication target is not a regular file`);
        }
        publicationBytes = fs.readFileSync(localized.targetPath);
        if (!Buffer.isBuffer(localized.bytes) || !publicationBytes.equals(localized.bytes)) {
          throw new Error(`asset ${asset.id} localized publication bytes drifted after localization`);
        }
      }
      const actualContentHash = `sha256:${createHash("sha256").update(publicationBytes).digest("hex")}`;
      if (asset.provenance.contentHash !== undefined && asset.provenance.contentHash !== actualContentHash) {
        throw new Error(`asset ${asset.id} declared content hash does not match publication bytes`);
      }
      if (localized.contentHash !== undefined && localized.contentHash !== actualContentHash) {
        throw new Error(`asset ${asset.id} localized registry record has a forged content hash`);
      }
      const usedInSlides = (plan.slides ?? [])
        .filter((slide) => (slide.assetIds ?? []).includes(asset.id))
        .map((slide) => slide.id);
      const source = {
        origin: asset.provenance.origin,
        sourceRef: asset.provenance.sourceRef,
        ...(asset.provenance.sourceUrl ? { sourceUrl: asset.provenance.sourceUrl } : {})
      };
      return {
        id: asset.id,
        kind: asset.kind,
        source,
        localPath: localized.relativePath,
        contentHash: actualContentHash,
        rights: structuredClone(asset.provenance.rights),
        altText: asset.altText,
        role: asset.role,
        focalPoint: asset.focalPoint,
        cropPolicy: asset.cropPolicy,
        fallback: structuredClone(asset.fallback),
        usedInSlides,
        finalDeckUse: finalDeckUseForAsset(asset, usedInSlides, elementsBySlide, localized.relativePath),
        ...(asset.provenance.generation ? { generation: structuredClone(asset.provenance.generation) } : {})
      };
    })
  };
  const validation = validateAssetRegistry(registry);
  if (!validation.valid) {
    throw new Error(`asset registry invalid: ${validation.issues.map((entry) => entry.message).join("; ")}`);
  }
  return registry;
}

export function createCreativeAuthoringTransaction({
  outputDir,
  planPath,
  plan,
  ir,
  localizedAssets,
  mode = "creative",
  ownershipPath = null,
  ownership = null,
  afterPublish = null,
  afterRollback = null
}) {
  const outputRoot = assertRealCreativeOutputDirectory(outputDir);
  if (!localizedAssets || !Array.isArray(localizedAssets.records)) {
    throw new Error("creative authoring transaction requires localized asset evidence");
  }
  const resolvedPlanPath = path.resolve(planPath);
  let sourcePlanBytes;
  let sourcePlan;
  try {
    sourcePlanBytes = fs.readFileSync(resolvedPlanPath);
    sourcePlan = JSON.parse(sourcePlanBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`creative source plan cannot be snapshotted: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isDeepStrictEqual(sourcePlan, plan)) {
    throw new Error("creative source plan does not match the supplied validated snapshot");
  }
  const planSnapshot = structuredClone(plan);
  const irSnapshot = structuredClone(ir);
  const localizedAssetsSnapshot = snapshotLocalizedAssetEvidence(localizedAssets);
  const ownershipSnapshot = ownership ? structuredClone(ownership) : null;
  const canonicalPlanBytes = Buffer.from(`${JSON.stringify(planSnapshot, null, 2)}\n`, "utf8");
  const canonicalIrBytes = Buffer.from(`${JSON.stringify(irSnapshot, null, 2)}\n`, "utf8");
  const published = [];

  const publishBytes = async (relativePath, bytes, {
    publicArtifact = true,
    removable = true,
    rollbackBytes = null
  } = {}) => {
    const target = path.resolve(outputRoot, relativePath);
    if (target !== outputRoot && !target.startsWith(`${outputRoot}${path.sep}`)) {
      throw new Error(`creative authoring target escapes output directory: ${relativePath}`);
    }
    await atomicPublishCreativeBytes(outputRoot, target, bytes);
    if (removable || rollbackBytes !== null) {
      published.push({ relativePath, target, publicArtifact, rollbackBytes });
    }
    if (publicArtifact && typeof afterPublish === "function") await afterPublish(relativePath);
  };

  const readRegularPublishedArtifact = async (relativePath) => {
    const target = path.resolve(outputRoot, relativePath);
    assertSafeCreativePublicationTarget(outputRoot, target);
    let entry;
    try { entry = await fs.promises.lstat(target); } catch (error) {
      throw new Error(`creative required artifact is missing: ${relativePath}; ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`creative required artifact must be a real regular file: ${relativePath}`);
    }
    return fs.promises.readFile(target);
  };

  const assertRunPointers = (run) => {
    const expected = {
      deckPlan: "deck.plan.json",
      semanticIr: "semantic-slide-ir.json",
      manifest: "deck.manifest.json",
      assetRegistry: "assets/asset-registry.json"
    };
    for (const [key, value] of Object.entries(expected)) {
      if (run?.artifacts?.[key] !== value) {
        throw new Error(`creative run artifact pointer ${key} must equal ${value}`);
      }
    }
    if (run?.mode !== "creative") {
      throw new Error("creative run mode must remain exactly creative");
    }
    if (run?.input?.type !== "text") {
      throw new Error("creative run input type must remain exactly text");
    }
    if (run.runId !== contentDerivedRunId(irSnapshot)) {
      throw new Error("creative run ID does not match the immutable semantic IR snapshot");
    }
  };

  const validatePublishedCreativeEvidence = async ({ requireRun = false } = {}) => {
    assertRealCreativeOutputDirectory(outputRoot);
    const [publishedPlanBytes, publishedIrBytes, manifestBytes, registryBytes] = await Promise.all([
      readRegularPublishedArtifact("deck.plan.json"),
      readRegularPublishedArtifact("semantic-slide-ir.json"),
      readRegularPublishedArtifact("deck.manifest.json"),
      readRegularPublishedArtifact("assets/asset-registry.json")
    ]);
    if (!publishedPlanBytes.equals(canonicalPlanBytes)) {
      throw new Error("published deck.plan.json does not match the immutable canonical snapshot");
    }
    if (!publishedIrBytes.equals(canonicalIrBytes)) {
      throw new Error("published semantic-slide-ir.json does not match the immutable canonical snapshot");
    }
    let finalManifest;
    try { finalManifest = JSON.parse(manifestBytes.toString("utf8")); } catch (error) {
      throw new Error(`published deck.manifest.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const expectedRegistry = buildCanonicalAssetRegistry(
      planSnapshot,
      localizedAssetsSnapshot,
      finalManifest,
      irSnapshot
    );
    const expectedRegistryBytes = Buffer.from(canonicalAssetRegistryText(expectedRegistry), "utf8");
    if (!registryBytes.equals(expectedRegistryBytes)) {
      throw new Error("published asset registry does not match final manifest and localized byte evidence");
    }
    for (const asset of expectedRegistry.assets) {
      const localTarget = path.resolve(outputRoot, asset.localPath);
      assertSafeCreativePublicationTarget(outputRoot, localTarget);
      const entry = await fs.promises.lstat(localTarget);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`published registry localPath must be a real regular file: ${asset.localPath}`);
      }
      const actualHash = `sha256:${createHash("sha256").update(await fs.promises.readFile(localTarget)).digest("hex")}`;
      if (actualHash !== asset.contentHash) {
        throw new Error(`published registry content hash drifted before package commit: ${asset.id}`);
      }
    }
    if (requireRun) {
      const runBytes = await readRegularPublishedArtifact("run.json");
      let run;
      try { run = JSON.parse(runBytes.toString("utf8")); } catch (error) {
        throw new Error(`published run.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      assertRunPointers(run);
    }
  };

  const beforePackage = async () => {
    assertRealCreativeOutputDirectory(outputRoot);
    const finalManifestPath = path.join(outputRoot, "deck.manifest.json");
    let finalManifest;
    try {
      finalManifest = JSON.parse(await fs.promises.readFile(finalManifestPath, "utf8"));
    } catch (error) {
      throw new Error(`cannot rebuild canonical asset registry from final deck.manifest.json: ${error instanceof Error ? error.message : String(error)}`);
    }
    const finalAssetRegistry = buildCanonicalAssetRegistry(
      planSnapshot,
      localizedAssetsSnapshot,
      finalManifest,
      irSnapshot
    );
    const targetPlan = path.join(outputRoot, "deck.plan.json");
    await publishBytes("deck.plan.json", canonicalPlanBytes, resolvedPlanPath === path.resolve(targetPlan)
      ? { removable: false, rollbackBytes: sourcePlanBytes }
      : {});
    await publishBytes("semantic-slide-ir.json", canonicalIrBytes);
    await publishBytes("assets/asset-registry.json", canonicalAssetRegistryText(finalAssetRegistry));
    if (ownershipPath && ownershipSnapshot) {
      const relativeOwnership = path.relative(outputRoot, path.resolve(ownershipPath));
      await publishBytes(relativeOwnership, `${JSON.stringify(ownershipSnapshot, null, 2)}\n`, { publicArtifact: false });
    }
    await validatePublishedCreativeEvidence();
    const run = await buildRunIndex(outputRoot, {
      runId: contentDerivedRunId(irSnapshot),
      mode,
      input: { type: "text", summary: planSnapshot?.context?.title ?? "Creative deck plan" }
    });
    assertRunPointers(run);
    await publishBytes("run.json", `${JSON.stringify(run, null, 2)}\n`);
  };

  const beforePackageCommit = async () => {
    await validatePublishedCreativeEvidence({ requireRun: true });
  };

  const beforePackageRollback = async () => {
    while (published.length > 0) {
      const entry = published.pop();
      try {
        if (entry.rollbackBytes !== null) {
          await atomicPublishCreativeBytes(outputRoot, entry.target, entry.rollbackBytes, {
            allowExistingTargetSymlink: true
          });
        } else {
          await unlinkCreativePublicationLeaf(outputRoot, entry.target);
        }
        if (entry.publicArtifact && typeof afterRollback === "function") await afterRollback(entry.relativePath);
      } catch {}
    }
  };

  return { beforePackage, beforePackageCommit, beforePackageRollback };
}

async function main() {
  const { inputDir, outputDir, options } = parseArgs(process.argv.slice(2));
  const resolvedInput = path.resolve(inputDir);
  const resolvedOutput = path.resolve(outputDir);
  assertRealCreativeOutputDirectory(resolvedOutput, { create: true });
  const explicitDesignInput = options.designSystem && fs.existsSync(path.resolve(options.designSystem))
    ? path.resolve(options.designSystem)
    : null;
  await invalidatePublishedOutputs(resolvedOutput, [resolvedInput, ...(explicitDesignInput ? [explicitDesignInput] : [])]);
  const planPath = fs.statSync(resolvedInput).isDirectory() ? path.join(resolvedInput, "deck.plan.json") : resolvedInput;
  const reservedManifestPath = path.join(resolvedOutput, "deck.manifest.json");
  if (path.resolve(planPath) === path.resolve(reservedManifestPath)) {
    throw new Error("creative deck-plan input collides with reserved output deck.manifest.json");
  }
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const validation = validateDeckPlan(plan);
  if (!validation.valid) throw new Error(`deck.plan invalid: ${validation.errors.join("; ")}`);
  const selection = await resolveDesignSystem({ request: options.designSystem, inputPath: planPath, projectRoot });
  const localizedAssets = localizePlanAssets(plan, planPath, resolvedOutput);
  try {
    const designOutputDir = path.join(resolvedOutput, "design-system");
    const designOutputPath = path.join(designOutputDir, "DESIGN.md");
    if (selection.resolvedSource !== path.resolve(designOutputPath)) {
      await atomicPublishCreativeBytes(resolvedOutput, designOutputPath, fs.readFileSync(selection.resolvedSource));
    } else {
      assertSafeCreativePublicationTarget(resolvedOutput, designOutputPath);
    }
    const design = selection.design;
    const { ir, manifest: compiledManifest } = compileDeckPlanArtifacts(plan, {
      designSystemSource: "design-system/DESIGN.md",
      designSystemName: design.name,
      designTokens: design.tokens,
      designSystemSelection: { request: selection.request, resolvedSource: selection.resolvedSource },
      assetSourceById: localizedAssets.sourceById,
      compositionBlockRegistry
    });
    const fontCatalog = await createFontMetricsCatalog();
    const materializedFonts = materializeTextFonts(compiledManifest, design.tokens, fontCatalog);
    const fitted = await fitManifestText(materializedFonts.manifest, {
      designTokens: design.tokens,
      fontCatalog,
      ...(fontCatalog.source === "unavailable"
        ? { source: "unavailable", reason: "fontkit could not open any installed font faces" }
        : {})
    });
    if (fitted.unresolved.length > 0 || fitted.report.status !== "passed") {
      throw new Error(`creative text fit unresolved: ${fitted.unresolved.map((item) => `${item.slideId}/${item.elementId}:${item.status}`).join(", ")}`);
    }
    const manifest = fitted.manifest;
    const manifestPath = path.join(resolvedOutput, "deck.manifest.json");
    await atomicPublishCreativeBytes(
      resolvedOutput,
      manifestPath,
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8")
    );
    const authoringTransaction = createCreativeAuthoringTransaction({
      outputDir: resolvedOutput,
      planPath,
      plan,
      ir,
      localizedAssets,
      mode: options.mode,
      ownershipPath: localizedAssets.ownershipPath,
      ownership: localizedAssets.ownership
    });

    const designFirstOptions = {
      inputType: "text",
      inputSource: planPath,
      copyManifest: false,
      mode: options.mode,
      strictLayoutSafety: true,
      protectedInputs: [
        planPath,
        designOutputPath,
        selection.resolvedSource,
        ...localizedAssets.protectedPaths
      ],
      beforePackage: authoringTransaction.beforePackage,
      beforePackageCommit: authoringTransaction.beforePackageCommit,
      beforePackageRollback: authoringTransaction.beforePackageRollback
    };
    await runDeckPipeline(manifestPath, resolvedOutput, designFirstOptions);
    console.log(`Creative text pipeline complete: ${path.join(resolvedOutput, "final.pptx")}`);
  } catch (error) {
    cleanupLocalizedPlanAssets(localizedAssets);
    throw error;
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
