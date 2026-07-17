import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { enforceHtmlFinalReview } from "../scripts/lib/html-final-review.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

async function makeReviewWorkspace() {
  const outputDir = await mkdtemp(join(tmpdir(), "pptx-html-final-review-"));
  await mkdir(join(outputDir, "evidence", "render"), { recursive: true });
  await mkdir(join(outputDir, "evidence", "compatibility"), { recursive: true });
  await writeFile(join(outputDir, "deck.repaired.html"), "<section class=\"pptx-slide\">Accepted</section>", "utf8");
  await writeFile(join(outputDir, "html-layout-report.json"), JSON.stringify({ version: "0.1.0", createdAt: "volatile", summary: { blocked: false } }), "utf8");
  await writeFile(join(outputDir, "pptx-geometry-report.json"), JSON.stringify({ version: "0.4.0", summary: { blocked: false } }), "utf8");
  await writeFile(join(outputDir, "evidence", "render", "slide-1.png"), Buffer.from("slide-png"));
  await writeFile(join(outputDir, "evidence", "render", "contact-sheet.png"), Buffer.from("contact-png"));
  await writeFile(join(outputDir, "evidence", "compatibility", "powerpoint.png"), Buffer.from("powerpoint-png"));
  await writeFile(join(outputDir, "evidence", "compatibility", "wps.png"), Buffer.from("wps-png"));
  const zip = new JSZip();
  zip.file("docProps/core.xml", "<dcterms:created>2026-01-01</dcterms:created><dcterms:modified>2026-01-01</dcterms:modified>");
  zip.file("ppt/slides/slide1.xml", "<p:sld/>");
  await writeFile(join(outputDir, "final.pptx"), await zip.generateAsync({ type: "nodebuffer" }));
  const manifest = {
    version: "0.2.0",
    slides: [{ id: "slide-001", elements: [{ type: "text", id: "title", text: "Accepted" }] }]
  };
  await writeFile(join(outputDir, "deck.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { outputDir, manifest };
}

function hash(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function completedReview(outputDir, verdict = "accept") {
  const review = JSON.parse(await readFile(join(outputDir, "html-final-review", "host-final-review.template.json"), "utf8"));
  review.status = "completed";
  review.overallVerdict = verdict;
  review.summary = verdict === "accept" ? "All slides and target suites were inspected." : "Candidate needs repair.";
  for (const slide of review.slides) {
    slide.noOcclusion = "pass";
    slide.textRhythm = "pass";
    slide.whitespaceBalance = "pass";
    slide.connectorSemantics = "pass";
    slide.componentVisibility = "pass";
    slide.observations = "Inspected the full-size slide; title, content, and edges remain separated.";
  }
  const evidence = {
    libreoffice: ["evidence/render/contact-sheet.png", Buffer.from("contact-png")],
    powerpoint: ["evidence/compatibility/powerpoint.png", Buffer.from("powerpoint-png")],
    wps: ["evidence/compatibility/wps.png", Buffer.from("wps-png")]
  };
  for (const suite of review.suites) {
    const [path, bytes] = evidence[suite.suite];
    suite.status = "passed";
    suite.environment = `${suite.suite}-test-environment`;
    suite.reason = "Opened or rendered successfully with no P1 layout divergence.";
    suite.artifacts = [{ path, hash: hash(bytes) }];
  }
  return review;
}

describe("HTML-first final visual review", () => {
  it("blocks the first pass, binds every artifact, and publishes only after an accepted sidecar", async () => {
    const { outputDir, manifest } = await makeReviewWorkspace();
    const options = {
      outputDir,
      manifest,
      repairedHtmlPath: join(outputDir, "deck.repaired.html"),
      schemaPath: join(root, "schemas", "host-html-visual-review.schema.json")
    };
    await expect(enforceHtmlFinalReview(options)).rejects.toMatchObject({ stage: "host-final-visual-review" });
    const packet = JSON.parse(await readFile(join(outputDir, "html-final-review", "review-packet.json"), "utf8"));
    expect(packet).toMatchObject({ version: "0.4.0", route: "text/html-first", maxReviewRounds: 3 });
    expect(packet.slides).toHaveLength(1);
    const reviewPath = join(outputDir, "accepted-review.json");
    await writeFile(reviewPath, await readFile(join(outputDir, "html-final-review", "host-final-review.template.json"), "utf8"), "utf8");
    await expect(enforceHtmlFinalReview({ ...options, reviewPath })).rejects.toThrow(/contract invalid/i);
    await writeFile(reviewPath, `${JSON.stringify(await completedReview(outputDir), null, 2)}\n`, "utf8");
    await expect(enforceHtmlFinalReview({ ...options, reviewPath })).resolves.toMatchObject({ packetHash: packet.packetHash });
    expect(JSON.parse(await readFile(join(outputDir, "host-html-visual-review.json"), "utf8"))).toMatchObject({ overallVerdict: "accept" });
  });

  it("exhausts the review budget after three artifact-bound rejections", async () => {
    const { outputDir, manifest } = await makeReviewWorkspace();
    const options = {
      outputDir,
      manifest,
      repairedHtmlPath: join(outputDir, "deck.repaired.html"),
      schemaPath: join(root, "schemas", "host-html-visual-review.schema.json")
    };
    await expect(enforceHtmlFinalReview(options)).rejects.toBeTruthy();
    const rejected = await completedReview(outputDir, "reject");
    rejected.slides[0].componentVisibility = "fail";
    const reviewPath = join(outputDir, "rejected-review.json");
    await writeFile(reviewPath, `${JSON.stringify(rejected, null, 2)}\n`, "utf8");
    await expect(enforceHtmlFinalReview({ ...options, reviewPath })).rejects.toMatchObject({ stage: "host-final-visual-review" });
    await expect(enforceHtmlFinalReview({ ...options, reviewPath })).rejects.toMatchObject({ stage: "host-final-visual-review" });
    await expect(enforceHtmlFinalReview({ ...options, reviewPath })).rejects.toMatchObject({ stage: "host-final-visual-review-exhausted" });
  });
});
