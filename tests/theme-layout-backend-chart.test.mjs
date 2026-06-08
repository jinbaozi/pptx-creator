import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const node = process.execPath;
const root = fileURLToPath(new URL("..", import.meta.url));

async function slideXml(pptxPath) {
  const zip = await JSZip.loadAsync(await readFile(pptxPath));
  const files = Object.keys(zip.files).filter((name) => name.startsWith("ppt/slides/slide") && name.endsWith(".xml"));
  return (await Promise.all(files.map((name) => zip.files[name].async("string")))).join("\n");
}

describe("theme packs, layouts, backend selection, and richer charts", () => {
  it("validates enterprise theme pack DESIGN.md files", async () => {
    for (const id of ["enterprise-blueprint", "executive-crimson", "finance-boardroom"]) {
      const { stdout } = await execFileAsync(node, [
        join(root, "scripts/validate-design-md.mjs"),
        join(root, `design-systems/${id}/DESIGN.md`)
      ]);
      expect(stdout).toContain("design valid");
    }
  });

  it("renders line and pie charts as native editable shapes/text", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-rich-chart-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].layout = "dashboard";
    sample.slides[0].elements.push(
      {
        type: "chart",
        kind: "line",
        id: "line-chart",
        x: 0.7,
        y: 4.2,
        w: 4.5,
        h: 1.6,
        data: [
          { label: "Jan", value: 10 },
          { label: "Feb", value: 16 },
          { label: "Mar", value: 13 }
        ],
        style: { color: "{colors.primary}" }
      },
      {
        type: "chart",
        kind: "pie",
        id: "pie-chart",
        x: 5.6,
        y: 4.1,
        w: 2.2,
        h: 1.8,
        data: [
          { label: "A", value: 60 },
          { label: "B", value: 40 }
        ],
        style: { color: "{colors.accent}" }
      }
    );
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath, "--backend", "pptxgen"], {
      cwd: root
    });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain("Jan");
    expect(xml).toContain("Mar");
    expect(xml).toContain("A");
    expect(xml).toContain("60%");
    expect(await readFile(join(outputDir, "qa-report.md"), "utf8")).toContain("Layouts used: dashboard");
  }, 60000);

  it("keeps the deck schema aligned with supported chart kinds", async () => {
    const schema = JSON.parse(await readFile(join(root, "schemas/deck.schema.json"), "utf8"));
    const kindEnum = schema.properties.slides.items.properties.elements.items.properties.kind.enum;

    expect(kindEnum).toEqual(["bar", "line", "pie", "stackedBar", "horizontalBar", "groupedBar", "kpiGroup", "sparkline"]);
  });
});
