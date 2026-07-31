import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_THEME_ID,
  listThemes,
  loadTheme,
  materializeThemeTokens,
  themeFingerprints
} from "../../scripts/lib/themes.mjs";
import { skillRoot } from "../helpers.mjs";

const COMPLETE_THEME_IDS = [
  "restrained-business",
  "accessible-high-contrast",
  "editorial-magazine",
  "dark-technical",
  "warm-humanist",
  "swiss-data"
];

const defaultTokens = JSON.parse(readFileSync(join(skillRoot, "assets", "design-tokens.default.json"), "utf8"));

function clone(value) {
  return structuredClone(value);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function validRegistry(overrides = {}) {
  return {
    version: "1.0.0",
    themes: [{ id: "safe-theme", manifest: "assets/themes/safe-theme/manifest.json" }],
    ...overrides
  };
}

function validManifest(overrides = {}) {
  return {
    version: "1.0.0",
    id: "safe-theme",
    label: "Safe theme",
    description: "A local theme fixture with bounded CSS tokens.",
    useWhen: ["A test needs an approved local theme."],
    quietConstraints: ["Keep the fixture deterministic."],
    antiPatterns: ["Injecting CSS through a token."],
    tokens: "tokens.json",
    preview: "preview.svg",
    notice: "NOTICE",
    fontFallbacks: ["Arial", "Helvetica", "sans-serif"],
    ...overrides
  };
}

function themeFixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "text-to-html-themes-"));
  const themeDir = join(root, "assets", "themes", "safe-theme");
  mkdirSync(themeDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(join(root, "assets", "themes", "registry.json"), `${JSON.stringify(options.registry ?? validRegistry(), null, 2)}\n`);
  writeFileSync(join(themeDir, "manifest.json"), `${JSON.stringify(options.manifest ?? validManifest(), null, 2)}\n`);
  writeFileSync(join(themeDir, "tokens.json"), `${JSON.stringify(options.tokens ?? clone(defaultTokens), null, 2)}\n`);
  writeFileSync(join(themeDir, "preview.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"><rect width=\"1\" height=\"1\"/></svg>\n");
  writeFileSync(join(themeDir, "NOTICE"), "Fixture preview is local and deterministic.\n");
  return { root, themeDir };
}

test("loads all six complete visual themes with validated manifests, tokens, and local resources", () => {
  for (const id of COMPLETE_THEME_IDS) {
    const theme = loadTheme(id);
    assert.equal(theme.id, id);
    assert.equal(theme.manifest.id, id);
    assert.equal(theme.tokens.canvas.width, 1280);
    assert.equal(theme.tokens.canvas.height, 720);
    assert.equal(theme.tokens.canvas.aspectRatio, "16:9");
    assert.match(theme.manifestSha256, /^[a-f0-9]{64}$/);
    assert.match(theme.tokenSha256, /^[a-f0-9]{64}$/);
    assert.match(theme.previewSha256, /^[a-f0-9]{64}$/);
    assert.match(theme.noticeSha256, /^[a-f0-9]{64}$/);
    assert.equal(Object.isFrozen(theme), true);
  }
});

test("lists the registry in its declared order and preserves legacy-default tokens exactly", () => {
  assert.deepEqual(listThemes().map((theme) => theme.id), [
    "legacy-default",
    "restrained-business",
    "accessible-high-contrast",
    "editorial-magazine",
    "dark-technical",
    "warm-humanist",
    "swiss-data",
    "reference-adapted"
  ]);
  assert.deepEqual(materializeThemeTokens(loadTheme(DEFAULT_THEME_ID)), defaultTokens);
});

test("exposes deterministic raw file fingerprints", () => {
  const theme = loadTheme("editorial-magazine");
  const fingerprints = themeFingerprints(theme);

  assert.deepEqual(fingerprints, {
    registrySha256: sha256File(join(skillRoot, theme.paths.registry)),
    manifestSha256: sha256File(join(skillRoot, theme.paths.manifest)),
    tokenSha256: sha256File(join(skillRoot, theme.paths.tokens)),
    previewSha256: sha256File(join(skillRoot, theme.paths.preview)),
    noticeSha256: sha256File(join(skillRoot, theme.paths.notice))
  });
  assert.deepEqual(themeFingerprints(loadTheme("editorial-magazine")), fingerprints);
});

test("materializes only safe declared overrides without mutating the loaded theme", () => {
  const theme = loadTheme(DEFAULT_THEME_ID);
  const tokens = materializeThemeTokens(theme, {
    colors: { primary: "#102A43" },
    fonts: { body: "Georgia, Times New Roman, serif" },
    type: { body: 26 },
    space: { gap: 28 },
    radius: { card: 16 },
    shadow: { card: "none" }
  });

  assert.equal(tokens.colors.primary, "#102A43");
  assert.equal(tokens.fonts.body, "Georgia, Times New Roman, serif");
  assert.equal(tokens.type.body, 26);
  assert.equal(tokens.space.gap, 28);
  assert.equal(tokens.radius.card, 16);
  assert.equal(tokens.shadow.card, "none");
  assert.deepEqual(tokens.canvas, { width: 1280, height: 720, aspectRatio: "16:9" });
  assert.equal(theme.tokens.colors.primary, defaultTokens.colors.primary);
  assert.equal(theme.tokens.type.body, defaultTokens.type.body);
});

test("rejects registry traversal, manifest mismatches, and symlinked theme resources", (t) => {
  assert.throws(() => loadTheme("not-registered"), (error) => error.code === "E_THEME_NOT_FOUND");

  const traversal = themeFixture(t, {
    registry: validRegistry({ themes: [{ id: "safe-theme", manifest: "../outside/manifest.json" }] })
  });
  assert.throws(() => loadTheme("safe-theme", { root: traversal.root }), (error) => error.code === "E_THEME_PATH");

  const mismatch = themeFixture(t, { manifest: validManifest({ id: "other-theme" }) });
  assert.throws(() => loadTheme("safe-theme", { root: mismatch.root }), (error) => error.code === "E_THEME_MANIFEST");

  const symlinked = themeFixture(t);
  const externalTokens = join(symlinked.root, "outside-tokens.json");
  writeFileSync(externalTokens, JSON.stringify(defaultTokens));
  rmSync(join(symlinked.themeDir, "tokens.json"));
  symlinkSync(externalTokens, join(symlinked.themeDir, "tokens.json"));
  assert.throws(() => loadTheme("safe-theme", { root: symlinked.root }), (error) => error.code === "E_THEME_PATH");
});

test("rejects unsafe CSS values, out-of-range values, and low-contrast tokens or overrides", (t) => {
  const unsafeTokens = clone(defaultTokens);
  unsafeTokens.fonts.body = "Arial; color: red";
  const unsafe = themeFixture(t, { tokens: unsafeTokens });
  assert.throws(() => loadTheme("safe-theme", { root: unsafe.root }), (error) => error.code === "E_THEME_TOKEN");

  const outOfRangeTokens = clone(defaultTokens);
  outOfRangeTokens.type.body = 20;
  const outOfRange = themeFixture(t, { tokens: outOfRangeTokens });
  assert.throws(() => loadTheme("safe-theme", { root: outOfRange.root }), (error) => error.code === "E_THEME_TOKEN");

  const contrastTokens = clone(defaultTokens);
  contrastTokens.colors.text = "#FFFFFF";
  contrastTokens.colors.background = "#FFFFFF";
  const contrast = themeFixture(t, { tokens: contrastTokens });
  assert.throws(() => loadTheme("safe-theme", { root: contrast.root }), (error) => error.code === "E_THEME_CONTRAST");

  const theme = loadTheme(DEFAULT_THEME_ID);
  assert.throws(
    () => materializeThemeTokens(theme, { colors: { unknown: "#102A43" } }),
    (error) => error.code === "E_THEME_OVERRIDE" && error.path === "$.overrides.colors.unknown"
  );
  assert.throws(
    () => materializeThemeTokens(theme, { fonts: { body: "Arial; color: red" } }),
    (error) => error.code === "E_THEME_TOKEN" && error.path === "$.overrides.fonts.body"
  );
  assert.throws(
    () => materializeThemeTokens(theme, { colors: { text: "#FFFFFF", background: "#FFFFFF" } }),
    (error) => error.code === "E_THEME_CONTRAST" && error.path === "$.overrides.colors"
  );
});
