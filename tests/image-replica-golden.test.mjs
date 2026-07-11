import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";
import { measureImageReplicaEvidence } from "../scripts/lib/replica-evidence.mjs";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const enabled = process.env.PLAYWRIGHT_RUN === "1";

describe.runIf(enabled)("real image replica golden", () => {
  it("reconstructs native objects, proves fidelity, and never compares the source to itself", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-image-golden-"));
    await execFileAsync(process.execPath, [
      join(root, "scripts/pptx.mjs"), "image",
      join(root, "examples/image-input/replica-golden.png"), dir
    ], { cwd: root, timeout: 180000, env: process.env });
    const evidence = JSON.parse(await readFile(join(dir, "replica-evidence.json"), "utf8"));
    expect(evidence.accepted).toBe(true);
    expect(evidence.paths.source.sha256).not.toBe(evidence.paths.render.sha256);
    expect(evidence.source.size).toEqual(evidence.render.size);
    expect(evidence.aggregate.fidelity.ssim.value).toBeGreaterThanOrEqual(0.94);
    expect(evidence.aggregate.fidelity.ocrCer.value).toBeLessThanOrEqual(0.02);
    expect(evidence.aggregate.fidelity.bboxIou.value).toBeGreaterThanOrEqual(0.9);
    expect(evidence.aggregate.fidelity.paletteDeltaE2000P95.value).toBeLessThanOrEqual(3);
    expect(evidence.aggregate.fidelity.nativeHighConfidenceTextRecall.value).toBeGreaterThanOrEqual(0.9);
    expect(evidence.aggregate.editability.level).toBeGreaterThanOrEqual(3);
    expect(evidence.aggregate.fallbacks.every((item) => item.fullSlide === false)).toBe(true);

    const original = await JSZip.loadAsync(await readFile(join(dir, "final.pptx")));
    for (const name of Object.keys(original.files).filter((item) => /^ppt\/slides\/slide\d+\.xml$/.test(item))) {
      const xml = await original.file(name).async("string");
      original.file(name, xml.replace(/<a:t>[\s\S]*?<\/a:t>/g, "<a:t></a:t>"));
    }
    const tampered = join(dir, "no-native-text.pptx");
    await writeFile(tampered, await original.generateAsync({ type: "nodebuffer" }));
    const attacked = await measureImageReplicaEvidence(evidence, {
      sourceArtifactPath: evidence.paths.source.path,
      renderArtifactPath: evidence.paths.render.path,
      planPath: join(dir, "replica-layer-plan.json"), pptxPath: tampered,
      manifest: JSON.parse(await readFile(join(dir,"deck.manifest.json"),"utf8"))
    });
    expect(attacked.accepted).toBe(false);
    expect(attacked.blockingFindings.join(" ")).toMatch(/native-text-ooxml-mismatch/);

    const decoyZip=await JSZip.loadAsync(await readFile(join(dir,"final.pptx")));
    const slide=await decoyZip.file("ppt/slides/slide1.xml").async("string");
    decoyZip.file("ppt/slides/slide1.xml",slide.replace(/(<p:sp>[\s\S]*?name="text-line-[^"]+"[\s\S]*?<a:off\b[^>]*x=")\d+("[^>]*y=")\d+/g,(_match,left,middle)=>`${left}999999999${middle}999999999`));
    const decoy=join(dir,"off-slide-decoy.pptx");await writeFile(decoy,await decoyZip.generateAsync({type:"nodebuffer"}));
    const decoyEvidence=await measureImageReplicaEvidence(evidence,{sourceArtifactPath:evidence.paths.source.path,renderArtifactPath:evidence.paths.render.path,planPath:join(dir,"replica-layer-plan.json"),pptxPath:decoy,manifest:JSON.parse(await readFile(join(dir,"deck.manifest.json"),"utf8"))});
    expect(decoyEvidence.accepted).toBe(false);
    expect(decoyEvidence.blockingFindings.join(" ")).toMatch(/native-text-ooxml-mismatch/);

    const rasterZip=await JSZip.loadAsync(await readFile(join(dir,"final.pptx")));const rasterSlide=await rasterZip.file("ppt/slides/slide1.xml").async("string");
    rasterZip.file("ppt/slides/slide1.xml",rasterSlide.replace(/(<p:pic>[\s\S]*?name="residual-1"[\s\S]*?<a:off\b[^>]*x=")\d+("[^>]*y=")\d+("\/>[\s\S]*?<a:ext\b[^>]*cx=")\d+("[^>]*cy=")\d+/g,(_m,a,b,c,d)=>`${a}0${b}0${c}12191695${d}6858000`));
    const fullRaster=join(dir,"same-id-full-raster.pptx");await writeFile(fullRaster,await rasterZip.generateAsync({type:"nodebuffer"}));
    const maliciousManifest=JSON.parse(await readFile(join(dir,"deck.manifest.json"),"utf8"));const residual=maliciousManifest.slides[0].elements.find((item)=>item.id==="residual-1");Object.assign(residual,{x:0,y:0,w:13.333,h:7.5});
    const rasterAttack=await measureImageReplicaEvidence(evidence,{sourceArtifactPath:evidence.paths.source.path,renderArtifactPath:evidence.paths.render.path,planPath:join(dir,"replica-layer-plan.json"),pptxPath:fullRaster,manifest:maliciousManifest});
    expect(rasterAttack.accepted).toBe(false);expect(rasterAttack.blockingFindings.join(" ")).toMatch(/manifest-plan-element-mismatch|pptx-raster-inventory-mismatch/);
    const backgroundManifest=JSON.parse(await readFile(join(dir,"deck.manifest.json"),"utf8"));backgroundManifest.slides[0].background={type:"image",src:"replica-golden.png"};
    const backgroundAttack=await measureImageReplicaEvidence(evidence,{sourceArtifactPath:evidence.paths.source.path,renderArtifactPath:evidence.paths.render.path,planPath:join(dir,"replica-layer-plan.json"),pptxPath:join(dir,"final.pptx"),manifest:backgroundManifest});
    expect(backgroundAttack.accepted).toBe(false);expect(backgroundAttack.blockingFindings.join(" ")).toMatch(/manifest-background-mismatch/);
  });
});
