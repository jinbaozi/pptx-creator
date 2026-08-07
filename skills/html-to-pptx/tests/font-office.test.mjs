import { describe, expect, it } from "vitest";
import {
  collectReferencedFontRequests,
  createFontMetricsCatalog,
  embeddingLicenseFromFsType,
  preflightFonts,
  scoreFontFace,
  __test__ as fontTest
} from "../scripts/lib/font-preflight.mjs";
import {
  aggregateMatrixStatus,
  buildPowerPointComScript,
  buildPowerPointEmbedScript,
  detectLibreOfficeAdapter,
  detectPowerPointAdapter,
  detectWpsAdapter,
  embedFontsWithPowerPoint,
  __test__ as officeTest,
  validateFontEmbeddingReport,
  verifyOfficeMatrix
} from "../scripts/verify-office-matrix.mjs";
import { materializeTextFonts } from "../scripts/lib/text-fit.mjs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function fakeFace({
  familyName,
  postscriptName,
  fullName,
  subfamilyName = "Regular",
  weight = 400,
  italic = false,
  fsType = 0,
  chars = "Hello 世界"
} = {}) {
  return {
    familyName,
    postscriptName,
    fullName,
    subfamilyName,
    unitsPerEm: 1000,
    layout: () => ({ positions: [{ xAdvance: 500 }] }),
    glyphForCodePoint: (codePoint) => ({
      id: [...chars].includes(String.fromCodePoint(codePoint)) ? 1 : 0
    }),
    "OS/2": {
      usWeightClass: weight,
      usWidthClass: 5,
      fsType,
      fsSelection: { italic }
    }
  };
}

function fakeFontkit() {
  const faces = [
    fakeFace({ familyName: "Test Sans", postscriptName: "TestSans-Regular", fullName: "Test Sans Regular" }),
    fakeFace({ familyName: "Test Sans", postscriptName: "TestSans-Bold", fullName: "Test Sans Bold", subfamilyName: "Bold", weight: 700 }),
    fakeFace({ familyName: "Fallback Sans", postscriptName: "FallbackSans-Regular", fullName: "Fallback Sans Regular" })
  ];
  return { openSync: () => ({ fonts: faces }) };
}

describe("font face matching and license evidence", () => {
  it("scores the closest weight/style face deterministically", async () => {
    const catalog = await createFontMetricsCatalog({
      files: ["test.ttf"],
      loadFontkit: async () => fakeFontkit()
    });
    const resolved = catalog.resolveFontFace({ family: "Test Sans", fontWeight: 700, fontStyle: "normal" }, "Hello");
    expect(resolved).toMatchObject({
      familyName: "Test Sans",
      postscriptName: "TestSans-Bold",
      weight: 700,
      style: "normal"
    });
    expect(scoreFontFace(catalog.faces[1], { family: "Test Sans", fontWeight: 700 }, "Hello"))
      .toBeLessThan(scoreFontFace(catalog.faces[0], { family: "Test Sans", fontWeight: 700 }, "Hello"));
  });

  it("records glyph coverage and embedding restrictions in preflight", async () => {
    const restricted = fakeFace({ familyName: "Restricted", postscriptName: "Restricted-Regular", fullName: "Restricted Regular", chars: "H" });
    restricted["OS/2"].fsType = 0x0002;
    const result = await preflightFonts(
      { slides: [{ id: "slide-1", elements: [{ id: "text-1", type: "text", text: "Hello", style: { fontFamily: "Restricted" } }] }] },
      null,
      { files: ["restricted.ttf"], loadFontkit: async () => ({ openSync: () => ({ fonts: [restricted] }) }) }
    );
    expect(result.availability).toEqual({ Restricted: "present" });
    expect(result.resolutions[0]).toMatchObject({
      substitutionReason: "glyph-coverage-incomplete",
      glyphCoverage: { complete: false, missingGlyphs: expect.any(Array) },
      embedding: { fsType: 2, canEmbed: false, mode: "restricted" }
    });
    expect(embeddingLicenseFromFsType(0x0104)).toMatchObject({
      canEmbed: true,
      mode: "preview-print",
      noSubsetting: true
    });
  });

  it("materializes glyph-aware fallback runs in text, tables, captions, and charts", async () => {
    const latin = fakeFace({ familyName: "Latin Sans", postscriptName: "LatinSans-Regular", fullName: "Latin Sans Regular", chars: "AB " });
    const cjk = fakeFace({ familyName: "Noto Sans CJK SC", postscriptName: "NotoSansCJKsc-Regular", fullName: "Noto Sans CJK SC", chars: "中表题AB " });
    const incidental = fakeFace({ familyName: ".Incidental UI", postscriptName: "IncidentalUI-Regular", fullName: "Incidental UI", chars: "中表题AB " });
    const catalog = await createFontMetricsCatalog({
      files: ["latin.ttf", "incidental.ttf", "cjk.ttf"],
      loadFontkit: async () => ({ openSync: (path) => ({
        fonts: [path.includes("latin") ? latin : path.includes("incidental") ? incidental : cjk]
      }) })
    });
    const input = { slides: [{ id: "slide-1", elements: [
      { id: "mixed", type: "text", text: "A中B", style: { fontFamily: "Latin Sans" } },
      { id: "table", type: "table", sections: [{ type: "tbody", rows: [{ cells: [{ text: "表A", style: { fontFamily: "Latin Sans" } }] }] }], caption: "题A", captionRuns: [{ text: "题A", fontFamily: "Latin Sans" }] },
      { id: "chart", type: "chart", kind: "horizontalBar", data: [{ label: "中A", value: 1 }], style: { fontFamily: "Latin Sans" } }
    ] }] };
    const output = materializeTextFonts(input, {}, catalog);
    expect(output.manifest.slides[0].elements[0].runs.map((run) => [run.text, run.fontFamily])).toEqual([
      ["A", "Latin Sans"], ["中", "Noto Sans CJK SC"], ["B", "Latin Sans"]
    ]);
    expect(output.manifest.slides[0].elements[1].sections[0].rows[0].cells[0].runs.map((run) => run.fontFamily))
      .toEqual(["Noto Sans CJK SC", "Latin Sans"]);
    expect(output.manifest.slides[0].elements[1].captionRuns.map((run) => run.fontFamily))
      .toEqual(["Noto Sans CJK SC", "Latin Sans"]);
    expect(output.manifest.slides[0].elements[2].style.fontFamily).toBe("Noto Sans CJK SC");
    expect(output.substitutions.some((entry) => entry.elementId === "mixed" && entry.scope === "run")).toBe(true);
  });

  it("preserves source runs when the host font catalog is unavailable", async () => {
    const input = { slides: [{ id: "slide-1", elements: [{
      id: "rich",
      type: "text",
      text: "Alpha bold",
      style: { fontFamily: "Missing Sans" },
      runs: [{ text: "Alpha " }, { text: "bold", fontWeight: 700 }]
    }] }] };
    const output = materializeTextFonts(input, {}, {
      resolveFontSegments: () => [],
      resolveFontFamily: () => null
    });
    expect(output.manifest.slides[0].elements[0].runs).toEqual(input.slides[0].elements[0].runs);
    expect(output.manifest.slides[0].elements[0].text).toBe("Alpha bold");
  });

  it("collects inherited font coverage text from runs, table cells, captions, and charts", () => {
    const requests = collectReferencedFontRequests({ slides: [{ id: "slide-1", elements: [
      { id: "rich", type: "text", text: "Alpha bold", style: { fontFamily: "Latin Sans" }, runs: [
        { text: "Alpha " }, { text: "bold", style: { fontWeight: 700 } }
      ] },
      { id: "table", type: "table", style: { fontFamily: "Latin Sans" }, sections: [{ rows: [{ cells: [
        { text: "表A", runs: [{ text: "表" }, { text: "A" }] }
      ] }] }], caption: "题A", captionRuns: [{ text: "题" }, { text: "A" }] },
      { id: "chart", type: "chart", title: "趋势", style: { fontFamily: "Latin Sans" }, data: [
        { label: "中A", series: { Sales: 1 } }
      ] }
    ] }] }, {});
    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ elementId: "rich", text: "bold", family: "Latin Sans", weight: 700 }),
      expect.objectContaining({ elementId: "table", text: "表A", family: "Latin Sans" }),
      expect.objectContaining({ elementId: "table", text: "题A", family: "Latin Sans", scope: "caption" }),
      expect.objectContaining({ elementId: "chart", text: "趋势 中A Sales", family: "Latin Sans" })
    ]));
  });

  it.each([
    ["embeddable", 0, true, "all-requested-faces-embeddable"],
    ["restricted", 0x0002, false, "embedding-restricted"],
    ["unknown", null, null, "embedding-permission-unknown"]
  ])("feeds the real preflight report into embedding validation (%s)", async (_label, fsType, expectedCanEmbed, expectedReason) => {
    const root = await mkdtemp(join(tmpdir(), "font-report-e2e-"));
    try {
      const face = fakeFace({
        familyName: "Report Face",
        postscriptName: "ReportFace-Regular",
        fullName: "Report Face Regular",
        fsType
      });
      const report = await preflightFonts(
        { slides: [{ id: "slide-report", elements: [{ id: "text-report", type: "text", text: "Hello", style: { fontFamily: "Report Face" } }] }] },
        null,
        { files: ["report-face.ttf"], loadFontkit: async () => ({ openSync: () => ({ fonts: [face] }) }) }
      );
      expect(report.resolutions[0].embedding.canEmbed).toBe(expectedCanEmbed);
      expect(report.resolutions[0].resolved.embedding.canEmbed).toBe(expectedCanEmbed);
      const validation = validateFontEmbeddingReport(report);
      expect(validation.allowed).toBe(expectedCanEmbed === true);
      expect(validation.reason).toBe(expectedReason);

      let calls = 0;
      const output = join(root, "embedded.pptx");
      const embedded = await embedFontsWithPowerPoint({
        platform: "win32",
        adapter: { id: "powerpoint", adapter: "powerpoint-com", status: "available", detectionStatus: "available", powershell: "powershell.exe" },
        pptxPath: join(root, "input.pptx"),
        embedFontsOutput: output,
        fontReport: report,
        commandRunner: async () => {
          calls += 1;
          await writeFile(output, "COM-created-test-placeholder");
          return { ok: true };
        }
      });
      expect(embedded.status).toBe(expectedCanEmbed === true ? "passed" : "failed");
      expect(calls).toBe(expectedCanEmbed === true ? 1 : 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when direct and resolved embedding evidence conflicts", () => {
    expect(validateFontEmbeddingReport({
      resolutions: [{
        requested: { family: "Conflict" },
        embedding: { canEmbed: true },
        resolved: { embedding: { canEmbed: false } }
      }]
    })).toMatchObject({
      allowed: false,
      reason: "embedding-evidence-conflict",
      blocked: [{ reason: "embedding-evidence-conflict" }]
    });
  });

  it("keeps the legacy missing-family fallback contract", async () => {
    const result = await preflightFonts(
      { slides: [{ elements: [{ type: "text", text: "Hello", style: { fontFamily: "Missing Family" } }] }] },
      null,
      { files: [], loadFontkit: async () => ({ error: new Error("fontkit unavailable") }) }
    );
    expect(result).toMatchObject({
      availability: { "Missing Family": "missing" },
      fallback: [{ requested: "Missing Family", fallback: "system-default" }],
      source: "unavailable"
    });
  });
});

describe("office render validation matrix", () => {
  it("discovers LibreOffice independently from GUI-only targets", () => {
    const libreoffice = detectLibreOfficeAdapter({
      platform: "darwin",
      which: (command) => command === "soffice" ? "/opt/soffice" : null,
      exists: () => false
    });
    const powerPoint = detectPowerPointAdapter({ platform: "darwin", which: () => null, exists: () => false });
    const wps = detectWpsAdapter({
      platform: "darwin",
      which: () => null,
      exists: (path) => path === "/Applications/wpsoffice.app"
    });
    expect(libreoffice).toMatchObject({ status: "available", capability: "headless-cli", canRender: true });
    expect(powerPoint.status).toBe("unavailable");
    expect(wps.status).toBe("detected-but-not-automatable");
  });

  it("aggregates matrix states without treating unavailable as passed", () => {
    expect(aggregateMatrixStatus([
      { status: "passed" },
      { status: "unavailable" },
      { status: "detected-but-not-automatable" }
    ])).toMatchObject({ status: "unavailable", passed: false });
    expect(aggregateMatrixStatus([
      { status: "passed" },
      { status: "failed" }
    ])).toMatchObject({ status: "failed", passed: false });
    expect(aggregateMatrixStatus([
      { status: "passed" },
      { status: "passed" }
    ])).toMatchObject({ status: "passed", passed: true });
  });

  it("keeps GUI targets pending and emits the PowerPoint embedding contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "office-matrix-test-"));
    try {
      const report = await verifyOfficeMatrix({
        outputPath: join(root, "matrix.json"),
        adapters: {
          libreoffice: { id: "libreoffice", status: "unavailable", detectionStatus: "unavailable", note: "missing" },
          powerpoint: { id: "powerpoint", status: "detected-but-not-automatable", detectionStatus: "detected-but-not-automatable", note: "GUI" },
          wps: { id: "wps", status: "detected-but-not-automatable", detectionStatus: "detected-but-not-automatable", note: "GUI" }
        }
      });
      expect(report.summary.passed).toBe(false);
      expect(report.targets.libreoffice.status).toBe("unavailable");
      expect(report.targets.powerpoint.passed).toBe(false);
      const script = buildPowerPointComScript({ pptxPath: "input.pptx", pdfPath: "render.pdf", embeddedPath: "embedded.pptx" });
      expect(script).toContain("SaveCopyAs");
      expect(script).toContain("SaveCopyAs('/");
      expect(script).toContain(", 24, -1)");
      expect(script).toContain("EmbedTrueTypeFonts");
      expect(script).toContain("SaveAs");
      expect(JSON.parse(await readFile(join(root, "matrix.json"))).summary.passed).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("permits and records a Windows COM embedded copy only for explicit embeddable faces", async () => {
    const root = await mkdtemp(join(tmpdir(), "office-embed-permitted-"));
    try {
      const output = join(root, "embedded.pptx");
      const report = { resolutions: [{ requested: { family: "Permitted" }, resolved: { embedding: { canEmbed: true } } }] };
      const calls = [];
      const result = await embedFontsWithPowerPoint({
        platform: "win32",
        adapter: { id: "powerpoint", adapter: "powerpoint-com", status: "available", detectionStatus: "available", powershell: "powershell.exe" },
        pptxPath: join(root, "input.pptx"),
        embedFontsOutput: output,
        fontReport: report,
        commandRunner: async (command, args) => {
          calls.push({ command, args });
          await writeFile(output, "COM-created-test-placeholder");
          return { ok: true, stdout: "", stderr: "" };
        }
      });
      expect(result).toMatchObject({ status: "passed", output, reason: "powerpoint-com-saved-embedded-copy" });
      expect(result.validation).toMatchObject({ allowed: true, requestCount: 1 });
      expect(calls).toHaveLength(1);
      expect(calls[0].args.at(-1)).toContain("SaveCopyAs(");
      expect(calls[0].args.at(-1)).toContain(", 24, -1)");
      expect(await readFile(output, "utf8")).toContain("COM-created");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["restricted", false, "embedding-restricted"],
    ["unknown", null, "embedding-permission-unknown"]
  ])("blocks %s font evidence before invoking COM", async (_label, canEmbed, reason) => {
    const root = await mkdtemp(join(tmpdir(), "office-embed-blocked-"));
    try {
      const output = join(root, "must-not-exist.pptx");
      let calls = 0;
      const result = await embedFontsWithPowerPoint({
        platform: "win32",
        adapter: { id: "powerpoint", adapter: "powerpoint-com", status: "available", detectionStatus: "available", powershell: "powershell.exe" },
        pptxPath: join(root, "input.pptx"),
        embedFontsOutput: output,
        fontReport: { resolutions: [{ requested: { family: "Blocked" }, resolved: { embedding: { canEmbed } } }] },
        commandRunner: async () => {
          calls += 1;
          await writeFile(output, "must-not-be-created");
          return { ok: true };
        }
      });
      expect(result).toMatchObject({ status: "failed", output: null, reason });
      expect(result.validation).toMatchObject({ allowed: false, blocked: [{ reason }] });
      expect(calls).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks a missing font report and an unavailable/non-Windows adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "office-embed-unavailable-"));
    try {
      const output = join(root, "must-not-exist.pptx");
      let calls = 0;
      const permitted = { resolutions: [{ resolved: { embedding: { canEmbed: true } } }] };
      const missing = await embedFontsWithPowerPoint({
        platform: "win32",
        adapter: { id: "powerpoint", adapter: "powerpoint-com", status: "available", detectionStatus: "available", powershell: "powershell.exe" },
        pptxPath: join(root, "input.pptx"),
        embedFontsOutput: output,
        fontReport: null,
        commandRunner: async () => { calls += 1; return { ok: true }; }
      });
      expect(missing).toMatchObject({ status: "failed", reason: "font-report-missing", output: null });
      const unavailable = await embedFontsWithPowerPoint({
        platform: "win32",
        adapter: { id: "powerpoint", adapter: "powerpoint-com", status: "unavailable", detectionStatus: "unavailable" },
        pptxPath: join(root, "input.pptx"),
        embedFontsOutput: output,
        fontReport: permitted,
        commandRunner: async () => { calls += 1; return { ok: true }; }
      });
      expect(unavailable).toMatchObject({ status: "unavailable", reason: "powerpoint-com-adapter-unavailable", output: null });
      const nonWindows = await embedFontsWithPowerPoint({
        platform: "darwin",
        adapter: { id: "powerpoint", adapter: "powerpoint-com", status: "detected-but-not-automatable", detectionStatus: "detected-but-not-automatable" },
        pptxPath: join(root, "input.pptx"),
        embedFontsOutput: output,
        fontReport: permitted,
        commandRunner: async () => { calls += 1; return { ok: true }; }
      });
      expect(nonWindows).toMatchObject({ status: "detected-but-not-automatable", reason: "powerpoint-com-requires-windows", output: null });
      expect(calls).toBe(0);
      expect(validateFontEmbeddingReport({ resolutions: [{ resolved: { embedding: { canEmbed: true } } }] })).toMatchObject({ allowed: true });
      expect(buildPowerPointEmbedScript({ pptxPath: "input.pptx", outputPath: "embedded.pptx" })).toContain("SaveCopyAs");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses explicit CLI embedding arguments", () => {
    expect(officeTest.parseArgs([
      "--pptx", "input.pptx",
      "--embed-fonts-output", "embedded.pptx",
      "--font-report", "font-report.json",
      "--output", "matrix.json"
    ])).toMatchObject({
      pptxPath: "input.pptx",
      embedFontsOutput: "embedded.pptx",
      fontReport: "font-report.json",
      outputPath: "matrix.json"
    });
  });
});

describe("font helper metadata", () => {
  it("normalizes CSS style requests and exposes the test helpers", () => {
    expect(fontTest.normalizeFontRequest({ fontFamily: "Test Sans", fontWeight: "bold", fontStyle: "italic", fontStretch: "condensed" })).toMatchObject({
      family: "Test Sans",
      weight: 700,
      style: "italic",
      stretch: 75
    });
  });
});
