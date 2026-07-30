import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  HtmlToPptxError,
  resolveHtmlInput
} from "../scripts/convert.mjs";
import {
  SUPPORTED_VERSION,
  validatePresentationPackage
} from "../scripts/validate-presentation-package.mjs";

function protocol(entrypoint = "index.html") {
  return {
    protocol: "pptx-creator.presentation-package",
    version: "1.0.0",
    kind: "html-presentation",
    producer: { skill: "text-to-html", version: "2.0.0" },
    entrypoint,
    deck: {
      id: "deck-001",
      title: "Deck",
      size: { width: 1280, height: 720, unit: "px" },
      slides: [{
        id: "slide-001",
        order: 1,
        title: "Slide",
        sourceRefs: ["source-001"],
        components: []
      }]
    },
    assets: [],
    sources: [{
      id: "source-001",
      kind: "user-input",
      label: "Input",
      factStatus: "provided"
    }],
    validation: { status: "passed", reports: ["qa-report.json"] },
    degradations: [],
    compatibility: { minReaderVersion: "1.0.0", features: [] }
  };
}

describe("presentation-package 1.0.0 input contract", () => {
  it("keeps plain HTML independent from the optional protocol", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-contract-"));
    const html = join(root, "custom.html");
    await writeFile(html, "<h1>Plain HTML</h1>");
    await expect(resolveHtmlInput(html)).resolves.toMatchObject({
      inputKind: "plain-html",
      htmlPath: await realpath(html),
      packageManifest: null
    });
  });

  it("resolves a directory index without sibling Skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-directory-"));
    await writeFile(join(root, "index.html"), "<h1>Directory HTML</h1>");
    await expect(resolveHtmlInput(root)).resolves.toMatchObject({
      inputKind: "html-directory",
      packageManifest: null
    });
  });

  it("accepts the frozen protocol version", () => {
    expect(SUPPORTED_VERSION).toBe("1.0.0");
    expect(validatePresentationPackage(protocol())).toMatchObject({
      version: "1.0.0",
      kind: "html-presentation"
    });
  });

  it("fails closed with E_PROTOCOL_VERSION", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-version-"));
    await writeFile(join(root, "index.html"), "<h1>Future</h1>");
    const value = protocol();
    value.version = "2.0.0";
    await writeFile(join(root, "presentation-package.json"), JSON.stringify(value));
    try {
      await resolveHtmlInput(root);
      throw new Error("expected version failure");
    } catch (error) {
      expect(error).toBeInstanceOf(HtmlToPptxError);
      expect(error.code).toBe("E_PROTOCOL_VERSION");
      expect(error.message).toMatch(/supported=1.0.0/);
    }
  });

  it("rejects protocol entrypoints that escape the package root", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-path-"));
    await mkdir(join(root, "package"));
    await writeFile(join(root, "outside.html"), "<h1>Outside</h1>");
    await writeFile(
      join(root, "package", "presentation-package.json"),
      JSON.stringify(protocol("../outside.html"))
    );
    await expect(resolveHtmlInput(join(root, "package"))).rejects.toMatchObject({
      code: "E_PROTOCOL_PATH"
    });
  });
});
