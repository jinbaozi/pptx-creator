import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

const routeContracts = [
  ["text", "text.md"],
  ["html-replica", "html-replica.md"],
  ["image-replica", "image-replica.md"],
  ["pdf-replica", "pdf-replica.md"],
  ["manifest-repair", "manifest-repair.md"]
];

describe("Task 1 progressive-disclosure router", () => {
  it("is at most 80 lines and routes exactly one canonical route", async () => {
    const skill = await readFile(join(root, "SKILL.md"), "utf8");
    expect(skill.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(80);
    expect(skill).toContain("Select exactly one route");
    for (const [route, file] of routeContracts) {
      expect(skill).toContain(`\`${route}\``);
      expect(skill).toContain(`references/routes/${file}`);
    }
    expect(skill).toContain("manifest is the single source of truth");
    expect(skill).toContain("Never use a full-slide raster");
    expect(skill).toContain("at most three");
  });

  it.each(routeContracts)("declares the %s route contract", async (_route, file) => {
    const contract = await readFile(join(root, "references/routes", file), "utf8");
    for (const heading of [
      "## Trigger",
      "## Exclusions",
      "## Public command",
      "## Inputs and outputs",
      "## Blocking conditions",
      "## Next references"
    ]) {
      expect(contract).toContain(heading);
    }
    const commandLines = contract.match(/^npm run pptx -- .+$/gm) ?? [];
    expect(commandLines).toHaveLength(1);
    const references = contract.match(/^\d+\. `references\/.+`$/gm) ?? [];
    expect(references.length).toBeLessThanOrEqual(3);
  });
});

describe("Task 1 public CLI", () => {
  it("selects real existing-script invocations for every route", async () => {
    const { buildInvocation } = await import("../scripts/pptx.mjs");
    expect(buildInvocation(["text", "artifacts", "out"])).toMatchObject({ route: "text", script: "run-route-pipeline.mjs", args: ["text", "creative", "artifacts", "out"] });
    expect(buildInvocation(["text", "artifacts", "out", "--creative"])).toMatchObject({ route: "text", script: "run-route-pipeline.mjs", args: ["text", "creative", "artifacts", "out"], warning: expect.stringMatching(/deprecated/) });
    expect(buildInvocation(["text", "artifacts", "out", "--design-system", "dark-tech"])).toMatchObject({
      route: "text",
      script: "run-route-pipeline.mjs",
      args: ["text", "creative", "artifacts", "out", "--design-system", "dark-tech"]
    });
    expect(buildInvocation(["text", "artifacts", "out", "--creative-directions", "directions.json", "--host-review", "review.json"])).toMatchObject({
      route: "text",
      script: "run-route-pipeline.mjs",
      args: ["text", "creative", "artifacts", "out", "--creative-directions", "directions.json", "--host-review", "review.json"]
    });
    expect(buildInvocation(["text", "deck.json", "out", "--direct"])).toMatchObject({ route: "text", script: "run-route-pipeline.mjs", args: ["text", "direct", "deck.json", "out"] });
    expect(buildInvocation(["html", "input.html", "out"])).toMatchObject({
      route: "html-replica",
      script: "run-route-pipeline.mjs",
      args: ["html", "replica", "input.html", "out"]
    });
    expect(buildInvocation(["image", "input.png", "out"])).toMatchObject({ route: "image-replica", script: "run-route-pipeline.mjs" });
    expect(buildInvocation(["pdf", "input.pdf", "out"])).toMatchObject({ route: "pdf-replica", script: "run-route-pipeline.mjs" });
    expect(buildInvocation(["manifest", "deck.json", "patch.json", "repaired.json"])).toMatchObject({ route: "manifest-repair", script: "run-manifest-repair.mjs" });
  });

  it("prints help and rejects invalid route arguments", async () => {
    const cli = join(root, "scripts/pptx.mjs");
    const help = await execFileAsync(process.execPath, [cli, "--help"], { cwd: root });
    expect(help.stdout).toContain("pptx <text|html|image|pdf|manifest>");
    expect(help.stdout).toContain("--direct");
    expect(help.stdout).toContain("--design-system <path-or-name>");
    expect(help.stdout).toContain("--creative-directions <json>");

    await expect(execFileAsync(process.execPath, [cli, "unknown"], { cwd: root })).rejects.toMatchObject({ code: 1 });
    await expect(execFileAsync(process.execPath, [cli, "html", "input.html"], { cwd: root })).rejects.toMatchObject({ code: 1 });
    await expect(execFileAsync(process.execPath, [cli, "text", "deck.json", "out", "--direct", "--creative"], { cwd: root }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/mutually exclusive/) });
    await expect(execFileAsync(process.execPath, [cli, "text", "deck.json", "out", "--design-system"], { cwd: root }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/requires a value|expected/i) });
    await expect(execFileAsync(process.execPath, [cli, "text", "deck.json", "out", "--direct", "--design-system", "dark-tech"], { cwd: root }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/creative|direct/i) });
    await expect(execFileAsync(process.execPath, [cli, "text", "deck.json", "out", "--host-review", "review.json"], { cwd: root }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/requires --creative-directions/i) });
  });

  it("forwards the creative design-system option through the second routing hop", async () => {
    const { buildRouteInvocation } = await import("../scripts/run-route-pipeline.mjs");
    expect(buildRouteInvocation(["text", "creative", "deck.plan.json", "out", "--design-system", "dark-tech"])).toEqual({
      route: "text",
      mode: "creative",
      input: "deck.plan.json",
      outputDir: "out",
      options: { designSystem: "dark-tech", allowRemoteAssets: false }
    });
    expect(() => buildRouteInvocation(["text", "creative", "deck.plan.json", "out", "--design-system"])).toThrow(/requires a value/i);
    expect(buildRouteInvocation(["text", "creative", "deck.plan.json", "out", "--creative-directions", "directions.json", "--host-review", "review.json"])).toEqual({
      route: "text",
      mode: "creative",
      input: "deck.plan.json",
      outputDir: "out",
      options: { designSystem: null, allowRemoteAssets: false, creativeDirections: "directions.json", hostReview: "review.json" }
    });
  });
});

describe("Task 1 deck schema 0.2.0", () => {
  it("requires provenance metadata and keeps designSystem theme-only", async () => {
    const schema = JSON.parse(await readFile(join(root, "schemas/deck.schema.json"), "utf8"));
    expect(schema.required).toContain("metadata");
    expect(schema.properties.version.const).toBe("0.2.0");
    expect(schema.properties.metadata.required).toEqual(["mode", "inputType", "qualityProfile"]);
    expect(schema.properties.metadata.properties.mode.enum).toEqual(["direct", "creative", "replica", "repair"]);
    expect(schema.properties.metadata.properties.inputType.enum).toEqual(["text", "html", "image", "pdf", "manifest", "mixed"]);
    expect(schema.properties.metadata.properties.qualityProfile.enum).toEqual(["light", "creative", "replica"]);
    expect(schema.properties.metadata.properties).toHaveProperty("designIntent");
    expect(schema.properties.metadata.properties.designIntent.properties.visibleGrid).toEqual({ type: "boolean", default: false });
    expect(schema.properties.metadata.properties).toHaveProperty("replicaSource");
    expect(schema.properties.metadata.properties).toHaveProperty("generator");
    expect(schema.properties.designSystem.properties).not.toHaveProperty("mode");
    expect(schema.properties.slides.items.properties.pageRole.enum).toContain("evidence");
    expect(schema.properties.slides.items.properties.compositionStrategy.enum).toContain("asymmetric");
    expect(schema.propertyNames).toEqual({ not: { pattern: "^_" } });
  });

  it("publishes deck.plan 0.2.0 as the coordinate-free creative contract", async () => {
    const schema = JSON.parse(await readFile(join(root, "schemas/deck-plan.schema.json"), "utf8"));
    expect(schema.properties.version.const).toBe("0.2.0");
    expect(schema.required).toEqual(["version", "context", "designIntent", "story", "assets", "slides"]);
    expect(schema.properties.slides.items.$ref).toBe("#/$defs/slide");
    expect(schema.$defs.slide.additionalProperties).toBe(false);
    expect(schema.$defs.routePolicy.properties.preferred.const).toBe("native");
    expect(schema.$defs.routePolicy.properties.fullSlideRaster.const).toBe(false);
  });
});
