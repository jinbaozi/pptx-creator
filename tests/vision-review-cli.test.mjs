import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("vision review CLI", () => {
  it("writes a mock vision-review.json without network access", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-vision-review-"));
    await mkdir(join(dir, "previews"), { recursive: true });
    await writeFile(join(dir, "previews", "slide-001.png"), "");
    await writeFile(join(dir, "deck.design-direction.json"), JSON.stringify({ style: "business-tech" }));
    await writeFile(join(dir, "slide-design-specs.json"), JSON.stringify({ slides: [{ id: "slide-001", intent: "cover" }] }));
    await execFileAsync(process.execPath, ["scripts/run-vision-review.mjs", dir, "--provider", "mock"]);
    const review = JSON.parse(await readFile(join(dir, "vision-review.json"), "utf8"));
    expect(review.reviewer.provider).toBe("mock");
    expect(review.slides[0].slideId).toBe("slide-001");
    expect(review.slides[0].findings[0].source).toBe("vision-model");
  });
});
