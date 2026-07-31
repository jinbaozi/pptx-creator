import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { localizeAssets } from "../../scripts/lib/assets.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function planAsset(overrides = {}) {
  return {
    id: "asset-diagram",
    selectedLocator: "assets/diagram.svg",
    mime: "image/svg+xml",
    alt: "Architecture diagram",
    rights: {
      status: "licensed",
      spdx: "CC-BY-4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      attribution: "Example Studio"
    },
    sourceRef: "source-design",
    intendedPurpose: "Explain the system boundary",
    fallback: {
      selectedLocator: "assets/diagram-fallback.svg",
      reason: "Use when the primary diagram is unavailable."
    },
    ...overrides,
    rights: {
      status: "licensed",
      spdx: "CC-BY-4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      attribution: "Example Studio",
      ...overrides.rights
    }
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "text-to-html-assets-"));
  const sourceRoot = join(root, "source");
  const outputDir = join(root, "output");
  await mkdir(join(sourceRoot, "assets"), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, sourceRoot, outputDir };
}

test("localizes package-local assets and emits hash-bound provenance", async (t) => {
  const { sourceRoot, outputDir } = await fixture(t);
  const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><title>diagram</title></svg>";
  await writeFile(join(sourceRoot, "assets", "diagram.svg"), svg);
  const asset = planAsset({ selectedLocator: "assets\\diagram.svg", expectedSha256: sha256(svg) });

  const result = await localizeAssets({ assets: [asset], sourceRoot, outputDir });
  const [record] = result.assetRecords;
  const [ledger] = result.provenanceLedger;

  assert.equal(await readFile(join(outputDir, "assets", "media", "asset-diagram.svg"), "utf8"), svg);
  assert.equal(asset.selectedLocator, "assets\\diagram.svg", "localization must not mutate the reviewed plan");
  assert.deepEqual(record, {
    id: "asset-diagram",
    selectedLocator: "assets/diagram.svg",
    mime: "image/svg+xml",
    alt: "Architecture diagram",
    rights: {
      status: "licensed",
      spdx: "CC-BY-4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      attribution: "Example Studio"
    },
    sourceRef: "source-design",
    expectedSha256: sha256(svg),
    intendedPurpose: "Explain the system boundary",
    fallback: {
      selectedLocator: "assets/diagram-fallback.svg",
      reason: "Use when the primary diagram is unavailable."
    },
    sha256: sha256(svg),
    outputPath: "assets/media/asset-diagram.svg",
    sourcePath: "assets/diagram.svg",
    origin: "local"
  });
  assert.deepEqual(ledger, {
    assetId: "asset-diagram",
    origin: "local",
    selectedLocator: "assets/diagram.svg",
    outputPath: "assets/media/asset-diagram.svg",
    sha256: sha256(svg),
    mime: "image/svg+xml",
    rights: record.rights,
    sourceRef: "source-design",
    expectedSha256: sha256(svg),
    intendedPurpose: "Explain the system boundary",
    fallback: record.fallback
  });
  assert.match(result.notice, /Asset: asset-diagram/);
  assert.match(result.notice, /SHA-256: [a-f0-9]{64}/);
  assert.match(result.notice, /Attribution: Example Studio/);
});

test("rejects traversal and absolute locators before reading source files", async (t) => {
  const { sourceRoot, outputDir } = await fixture(t);
  await writeFile(join(sourceRoot, "assets", "diagram.svg"), "safe");

  for (const selectedLocator of ["../outside.svg", "assets/../outside.svg", "/tmp/outside.svg", "file:///tmp/outside.svg"]) {
    await assert.rejects(
      () => localizeAssets({ assets: [planAsset({ selectedLocator })], sourceRoot, outputDir }),
      (error) => error.code === "E_ASSET_PATH"
    );
  }
});

test("blocks remote locators by default without invoking fetchAsset", async (t) => {
  const { sourceRoot, outputDir } = await fixture(t);
  let calls = 0;

  await assert.rejects(
    () => localizeAssets({
      assets: [planAsset({ selectedLocator: "https://assets.example.test/diagram.png" })],
      sourceRoot,
      outputDir,
      fetchAsset: async () => {
        calls += 1;
        return Buffer.from("unexpected");
      }
    }),
    (error) => error.code === "E_REMOTE_ASSET"
  );
  assert.equal(calls, 0);
});

test("requires an exact expected SHA-256 before creating output assets", async (t) => {
  const { sourceRoot, outputDir } = await fixture(t);
  await writeFile(join(sourceRoot, "assets", "diagram.svg"), "known bytes");

  await assert.rejects(
    () => localizeAssets({
      assets: [planAsset({ expectedSha256: "0".repeat(64) })],
      sourceRoot,
      outputDir
    }),
    (error) => error.code === "E_ASSET_HASH" && error.details.actualSha256 === sha256("known bytes")
  );
  await assert.rejects(() => access(join(outputDir, "assets", "media", "asset-diagram.svg")));
});

test("rejects symlinked source files and output-directory symlink escapes", async (t) => {
  const { root, sourceRoot, outputDir } = await fixture(t);
  const outside = join(root, "outside.svg");
  await writeFile(outside, "outside bytes");
  await symlink(outside, join(sourceRoot, "assets", "diagram.svg"));
  await assert.rejects(
    () => localizeAssets({ assets: [planAsset()], sourceRoot, outputDir }),
    (error) => error.code === "E_ASSET_SYMLINK"
  );

  await rm(join(sourceRoot, "assets", "diagram.svg"));
  await writeFile(join(sourceRoot, "assets", "diagram.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"><title>safe</title></svg>");
  const externalOutput = join(root, "external-output");
  await mkdir(externalOutput);
  await mkdir(outputDir);
  await symlink(externalOutput, join(outputDir, "assets"));
  await assert.rejects(
    () => localizeAssets({ assets: [planAsset()], sourceRoot, outputDir }),
    (error) => error.code === "E_OUTPUT_PATH"
  );
  await assert.rejects(() => access(join(externalOutput, "media", "asset-diagram.svg")));
});

test("uses an explicitly injected fetcher only when network access is selected", async (t) => {
  const { sourceRoot, outputDir } = await fixture(t);
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
  const result = await localizeAssets({
    assets: [planAsset({
      selectedLocator: "https://assets.example.test/diagram.png",
      mime: "image/png",
      expectedSha256: sha256(bytes)
    })],
    sourceRoot,
    outputDir,
    networkPolicy: "prefer",
    fetchAsset: async (locator, context) => {
      assert.equal(locator, "https://assets.example.test/diagram.png");
      assert.equal(context.networkPolicy, "prefer");
      assert.equal(context.asset.id, "asset-diagram");
      return { bytes };
    }
  });

  assert.equal(result.assetRecords[0].origin, "remote");
  assert.deepEqual(await readFile(join(outputDir, "assets", "media", "asset-diagram.png")), bytes);
});

test("uses only a declared package-local fallback for a failed prefer-policy fetch", async (t) => {
  const { sourceRoot, outputDir } = await fixture(t);
  const fallback = "<svg xmlns=\"http://www.w3.org/2000/svg\"><title>fallback</title></svg>";
  await writeFile(join(sourceRoot, "assets", "diagram-fallback.svg"), fallback);
  const result = await localizeAssets({
    assets: [planAsset({ selectedLocator: "https://assets.example.test/diagram.png" })],
    sourceRoot,
    outputDir,
    networkPolicy: "prefer",
    fetchAsset: async () => {
      throw new Error("offline fixture");
    }
  });

  assert.equal(result.assetRecords[0].origin, "fallback-local");
  assert.deepEqual(result.assetRecords[0].fallbackUsed, {
    selectedLocator: "assets/diagram-fallback.svg",
    reason: "Use when the primary diagram is unavailable."
  });
  assert.equal(await readFile(join(outputDir, "assets", "media", "asset-diagram.svg"), "utf8"), fallback);
  assert.match(result.notice, /Fallback used: assets\/diagram-fallback\.svg/);
});

test("rejects active SVG content before it can enter the offline package", async (t) => {
  const { sourceRoot, outputDir } = await fixture(t);
  await writeFile(join(sourceRoot, "assets", "diagram.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>");

  await assert.rejects(
    () => localizeAssets({ assets: [planAsset()], sourceRoot, outputDir }),
    (error) => error.code === "E_ASSET_UNSAFE"
  );
});

test("preserves a reviewed focal point in the materialized asset ledger", async (t) => {
  const { sourceRoot, outputDir } = await fixture(t);
  const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><title>focal</title></svg>";
  await writeFile(join(sourceRoot, "assets", "diagram.svg"), svg);
  const result = await localizeAssets({
    assets: [planAsset({ focalPoint: { x: 0.25, y: 0.75 } })],
    sourceRoot,
    outputDir
  });
  assert.deepEqual(result.assetRecords[0].focalPoint, { x: 0.25, y: 0.75 });
  assert.deepEqual(result.provenanceLedger[0].focalPoint, { x: 0.25, y: 0.75 });
});
