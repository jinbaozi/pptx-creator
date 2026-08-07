import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { reconstructionRepairSafety, validateOwnershipReport } from "../scripts/validate_output.mjs";

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, payload) {
  const name = Buffer.from(type, "ascii");
  const body = Buffer.concat([name, payload]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  return Buffer.concat([length, body, checksum]);
}

function png(width, height, alpha = 255) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 4;
      row[offset] = 20;
      row[offset + 1] = 40;
      row[offset + 2] = 60;
      row[offset + 3] = alpha;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", (() => { const value = Buffer.alloc(13); value.writeUInt32BE(width, 0); value.writeUInt32BE(height, 4); value[8] = 8; value[9] = 6; return value; })()),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function grayMaskPng(width, height, value) {
  const rows = [];
  for (let y = 0; y < height; y += 1) rows.push(Buffer.concat([Buffer.from([0]), Buffer.alloc(width, value)]));
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function report(classDigest, assetDigest, maskDigest, assets) {
  const classes = {};
  for (const name of ["background", "native_text", "native_shape", "raster_asset", "unresolved"]) {
    classes[name] = { pixelCount: name === "background" ? 16 : 0, share: name === "background" ? 1 : 0, maskDigest: classDigest, path: `masks/${name}.png` };
  }
  return {
    version: "1.0.0",
    status: "passed",
    coordinateSpace: "normalized-page-px",
    sizePx: { width: 4, height: 4 },
    tolerancePx: 2,
    algorithm: "native-claims-then-residual-components",
    backgroundColor: "#FFFFFF",
    sourceRef: "source-1",
    source: "test",
    totalPixels: 16,
    classes,
    conflictPixels: 0,
    rasterNativeOverlapPixels: 0,
    duplicateVisibleContent: 0,
    unassignedPixels: 0,
    unassignedShare: 0,
    unassignedBudget: 0,
    unionPixels: 16,
    assets: assets.map((item) => ({ ...item, assetDigest, maskDigest }))
  };
}

test("ownership validator keys duplicates by page claim, not asset bytes or bbox overlap", async () => {
  const root = await mkdtemp(join(tmpdir(), "pptx-owner-") );
  try {
    const classPng = png(4, 4);
    const assetPng = png(2, 2);
    const classDigest = digest(classPng);
    const assetDigest = digest(assetPng);
    const maskDigest = digest(assetPng);
    await writeFile(join(root, "masks-background.png"), classPng);
    for (const name of ["native_text", "native_shape", "raster_asset", "unresolved"]) {
      await writeFile(join(root, `masks-${name}.png`), classPng);
    }
    for (const [index, path] of ["one", "two"].entries()) {
      await writeFile(join(root, `asset-${path}.png`), assetPng);
      await writeFile(join(root, `mask-${path}.png`), assetPng);
    }
    const assets = [
      { objectId: "image-1", asset: "asset-one.png", mask: "mask-one.png", pagePixelBox: { x: 0, y: 0, w: 2, h: 2 }, originPagePixelBox: { x: 0, y: 0, w: 2, h: 2 }, sourceRef: "source-1", sourceDigest: "b".repeat(64), normalizedSourceDigest: "b".repeat(64), provenance: "test" },
      { objectId: "image-2", asset: "asset-two.png", mask: "mask-two.png", pagePixelBox: { x: 2, y: 2, w: 2, h: 2 }, originPagePixelBox: { x: 2, y: 2, w: 2, h: 2 }, sourceRef: "source-1", sourceDigest: "b".repeat(64), normalizedSourceDigest: "b".repeat(64), provenance: "test" }
    ];
    const slide = {
      id: "slide-1",
      sourceRef: "source-1",
      sizePx: { width: 4, height: 4 },
      objects: [{ id: "shape-1", type: "shape", pixelBox: { x: 0, y: 0, w: 4, h: 4 } }]
    };
    const value = report(classDigest, assetDigest, maskDigest, assets);
    value.classes.background.path = "masks-background.png";
    for (const name of ["native_text", "native_shape", "raster_asset", "unresolved"]) value.classes[name].path = `masks-${name}.png`;
    await validateOwnershipReport(value, root, slide, [{ id: "source-1", normalizedSha256: "b".repeat(64) }]);

    const duplicate = structuredClone(value);
    duplicate.assets[1].pagePixelBox = duplicate.assets[0].pagePixelBox;
    await assert.rejects(
      () => validateOwnershipReport(duplicate, root, slide, [{ id: "source-1", normalizedSha256: "b".repeat(64) }]),
      (error) => error.code === "E_DUPLICATE_VISIBLE_CONTENT"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repair safety reuses baseline ownership for transparent residual pixels", async () => {
  const root = await mkdtemp(join(tmpdir(), "pptx-repair-safety-transparent-"));
  try {
    const mask = grayMaskPng(2, 2, 0);
    await writeFile(join(root, "mask.png"), mask);
    const slide = {
      id: "slide-1",
      sizePx: { width: 8, height: 8 },
      objects: [{ id: "text-1", type: "text", confidence: 0.95, renderBox: { x: 0, y: 0, w: 2, h: 2 } }],
      ownershipReport: {
        status: "passed",
        rasterNativeOverlapPixels: 0,
        assets: [{
          objectId: "image-1",
          mask: "mask.png",
          maskDigest: digest(mask),
          pagePixelBox: { x: 0, y: 0, w: 2, h: 2 },
          originPagePixelBox: { x: 0, y: 0, w: 2, h: 2 }
        }]
      }
    };
    const safety = await reconstructionRepairSafety(slide, root);
    assert.equal(safety.status, "passed");
    assert.deepEqual(safety.rasterNativeOverlapObjectRefs, []);
    slide.objects[0].renderBox = { x: 4, y: 4, w: 2, h: 2 };
    slide.ownershipReport.assets[0].pagePixelBox = { x: 4, y: 4, w: 2, h: 2 };
    const movedTransparent = await reconstructionRepairSafety(slide, root);
    assert.equal(movedTransparent.status, "passed");
    assert.deepEqual(movedTransparent.rasterNativeOverlapObjectRefs, []);

    slide.ownershipReport.assets[0].maskDigest = "0".repeat(64);
    const tampered = await reconstructionRepairSafety(slide, root);
    assert.equal(tampered.status, "failed");
    assert.deepEqual(tampered.rasterNativeOverlapObjectRefs, ["image-1"]);

    slide.ownershipReport.assets[0].maskDigest = digest(mask);
    await rm(join(root, "mask.png"));
    const missing = await reconstructionRepairSafety(slide, root);
    assert.equal(missing.status, "failed");
    assert.deepEqual(missing.rasterNativeOverlapObjectRefs, ["image-1"]);

    delete slide.ownershipReport.assets[0].originPagePixelBox;
    const missingOrigin = await reconstructionRepairSafety(slide, root);
    assert.equal(missingOrigin.status, "failed");
    assert.deepEqual(missingOrigin.rasterNativeOverlapObjectRefs, ["image-1"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repair safety detects non-transparent pixels entering text after asset movement", async () => {
  const root = await mkdtemp(join(tmpdir(), "pptx-repair-safety-moved-"));
  try {
    const mask = grayMaskPng(2, 2, 255);
    await writeFile(join(root, "mask.png"), mask);
    const slide = {
      id: "slide-1",
      sizePx: { width: 8, height: 8 },
      objects: [{ id: "text-1", type: "text", confidence: 0.95, renderBox: { x: 4, y: 4, w: 2, h: 2 } }],
      ownershipReport: {
        status: "passed",
        rasterNativeOverlapPixels: 0,
        assets: [{
          objectId: "image-1",
          mask: "mask.png",
          maskDigest: digest(mask),
          pagePixelBox: { x: 0, y: 0, w: 2, h: 2 },
          originPagePixelBox: { x: 0, y: 0, w: 2, h: 2 }
        }]
      }
    };
    assert.equal((await reconstructionRepairSafety(slide, root)).status, "passed");
    slide.ownershipReport.assets[0].pagePixelBox = { x: 4, y: 4, w: 2, h: 2 };
    const safety = await reconstructionRepairSafety(slide, root);
    assert.equal(safety.status, "failed");
    assert.deepEqual(safety.rasterNativeOverlapObjectRefs, ["image-1"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
