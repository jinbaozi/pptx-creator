import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");

const ARTIFACT_PATH = resolve(ROOT, "references/visual-design-calibration.md");
const CSV_PATH = resolve(ROOT, "examples/slopRisk-corpus/annotations.csv");
const INTERNAL_DIR = resolve(ROOT, "examples/slopRisk-corpus/internal");
const EXTERNAL_DIR = resolve(ROOT, "examples/slopRisk-corpus/external");
const EXTERNAL_README = resolve(ROOT, "examples/slopRisk-corpus/external/README.md");

function readText(path) {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

function listExpectedSidecars(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".expected.json"))
    .sort();
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length === 0) return { header: [], rows: [] };
  const header = lines[0].split(",").map((c) => c.trim());
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(",").map((c) => c.trim());
    const row = {};
    header.forEach((key, i) => {
      row[key] = cells[i];
    });
    return row;
  });
  return { header, rows };
}

describe("references/visual-design-calibration.md artifact", () => {
  it("exists", () => {
    const md = readText(ARTIFACT_PATH);
    expect(md).toBeTruthy();
  });

  it("declares the locked threshold and clearance target", () => {
    const md = readText(ARTIFACT_PATH);
    expect(md).toMatch(/Threshold default:\*\* reviewer-vs-formula agreement/);
    expect(md).toMatch(/≥ 80%/);
  });

  it("contains all 6 required section headings", () => {
    const md = readText(ARTIFACT_PATH);
    expect(md).toMatch(/## Distribution table/);
    expect(md).toMatch(/## Reviewer protocol/);
    expect(md).toMatch(/## How distributions are derived/);
    expect(md).toMatch(/## Pending population/);
    expect(md).toMatch(/## Manifest dependency/);
    expect(md).toMatch(/## Regeneration rules/);
  });

  it("declares corpus size = 15 (6 internal + 9 external)", () => {
    const md = readText(ARTIFACT_PATH);
    expect(md).toMatch(/15 decks/);
    expect(md).toMatch(/6 internal \+ 9 external/);
  });
});

describe("examples/slopRisk-corpus/annotations.csv", () => {
  it("exists with exactly 15 data rows + 1 header", () => {
    const text = readText(CSV_PATH);
    expect(text).toBeTruthy();
    const { header, rows } = parseCsv(text);
    expect(rows).toHaveLength(15);
    expect(header).toHaveLength(5);
  });

  it("has the 5 expected columns", () => {
    const text = readText(CSV_PATH);
    const { header } = parseCsv(text);
    expect(header).toEqual([
      "deckId",
      "source",
      "expectedSlopRisk",
      "reviewer",
      "annotatedAt",
    ]);
  });

  it("every row has a numeric expectedSlopRisk in [0, 100]", () => {
    const text = readText(CSV_PATH);
    const { rows } = parseCsv(text);
    for (const row of rows) {
      const v = Number(row.expectedSlopRisk);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("deckIds are unique across the corpus", () => {
    const text = readText(CSV_PATH);
    const { rows } = parseCsv(text);
    const ids = rows.map((r) => r.deckId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("contains the 6 expected internal deckIds", () => {
    const text = readText(CSV_PATH);
    const { rows } = parseCsv(text);
    const ids = rows.map((r) => r.deckId);
    const expectedInternal = [
      "internal-001-text-input",
      "internal-002-html-input-one-page",
      "internal-003-html-input-css-positioned",
      "internal-004-html-input",
      "internal-005-design-first",
      "internal-006-image-input",
    ];
    for (const id of expectedInternal) {
      expect(ids).toContain(id);
    }
  });

  it("contains the 9 expected external deckIds", () => {
    const text = readText(CSV_PATH);
    const { rows } = parseCsv(text);
    const ids = rows.map((r) => r.deckId);
    const expectedExternal = [
      "external-001-html-ppt-skill-modern-minimalist",
      "external-002-html-ppt-skill-dark-tech",
      "external-003-html-ppt-skill-editorial",
      "external-004-html-ppt-skill-cyberpunk",
      "external-005-ppt-master-compiler-roadshow",
      "external-006-ppt-master-startup-pitch",
      "external-007-ppt-master-product-roadshow",
      "external-008-marp-theme-default",
      "external-009-reveal-js-template",
    ];
    for (const id of expectedExternal) {
      expect(ids).toContain(id);
    }
  });
});

describe("examples/slopRisk-corpus/internal/ sidecars", () => {
  it("contains exactly 6 expected.json sidecars", () => {
    const files = listExpectedSidecars(INTERNAL_DIR);
    expect(files).toHaveLength(6);
  });

  it("every sidecar has a sourcePath field referencing the example input", () => {
    const files = listExpectedSidecars(INTERNAL_DIR);
    expect(files).toHaveLength(6);
    for (const f of files) {
      const json = JSON.parse(readFileSync(resolve(INTERNAL_DIR, f), "utf8"));
      expect(json).toHaveProperty("sourcePath");
      expect(json.sourcePath).toMatch(/^\.\.\/\.\.\//);
    }
  });

  it("every sidecar has the required fields", () => {
    const files = listExpectedSidecars(INTERNAL_DIR);
    for (const f of files) {
      const json = JSON.parse(readFileSync(resolve(INTERNAL_DIR, f), "utf8"));
      expect(json).toHaveProperty("deckId");
      expect(json).toHaveProperty("sourcePath");
      expect(json).toHaveProperty("expectedSlopRisk");
      expect(json).toHaveProperty("reviewer");
      expect(json).toHaveProperty("annotatedAt");
    }
  });
});

describe("examples/slopRisk-corpus/external/ sidecars", () => {
  it("contains exactly 9 expected.json sidecars", () => {
    const files = listExpectedSidecars(EXTERNAL_DIR);
    expect(files).toHaveLength(9);
  });

  it("every sidecar has a provenanceUrl field", () => {
    const files = listExpectedSidecars(EXTERNAL_DIR);
    expect(files).toHaveLength(9);
    for (const f of files) {
      const json = JSON.parse(readFileSync(resolve(EXTERNAL_DIR, f), "utf8"));
      expect(json).toHaveProperty("provenanceUrl");
      expect(json.provenanceUrl).toMatch(/^https:\/\//);
    }
  });

  it("every sidecar cites an MIT or Apache-2.0 source license", () => {
    const files = listExpectedSidecars(EXTERNAL_DIR);
    for (const f of files) {
      const json = JSON.parse(readFileSync(resolve(EXTERNAL_DIR, f), "utf8"));
      expect(["MIT", "Apache-2.0"]).toContain(json.sourceLicense);
    }
  });

  it("every sidecar has the required fields", () => {
    const files = listExpectedSidecars(EXTERNAL_DIR);
    for (const f of files) {
      const json = JSON.parse(readFileSync(resolve(EXTERNAL_DIR, f), "utf8"));
      expect(json).toHaveProperty("deckId");
      expect(json).toHaveProperty("provenanceUrl");
      expect(json).toHaveProperty("sourceLicense");
      expect(json).toHaveProperty("expectedSlopRisk");
      expect(json).toHaveProperty("reviewer");
      expect(json).toHaveProperty("annotatedAt");
    }
  });
});

describe("examples/slopRisk-corpus/external/README.md", () => {
  it("exists explaining the pending PNG downloads", () => {
    const md = readText(EXTERNAL_README);
    expect(md).toBeTruthy();
    // The README must explain the manual download step.
    expect(md).toMatch(/manually download/i);
    // And that without PNGs, the agreement-phase test only runs against internal decks.
    expect(md).toMatch(/6 internal decks/);
  });
});

describe("total corpus + sidecar count", () => {
  it("total *.expected.json across internal + external is 15", () => {
    const internal = listExpectedSidecars(INTERNAL_DIR);
    const external = listExpectedSidecars(EXTERNAL_DIR);
    expect(internal.length + external.length).toBe(15);
  });

  it("CSV row count matches sidecar count (15 = 15)", () => {
    const csvText = readText(CSV_PATH);
    const { rows } = parseCsv(csvText);
    const internal = listExpectedSidecars(INTERNAL_DIR);
    const external = listExpectedSidecars(EXTERNAL_DIR);
    expect(rows.length).toBe(internal.length + external.length);
  });
});