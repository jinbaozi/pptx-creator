import { describe, expect, it, vi } from "vitest";
import { runBoundedRepair } from "../scripts/lib/bounded-repair.mjs";
import { applyImageTextAdjustments } from "../scripts/run-image-pipeline.mjs";
import { repairHtmlManifestGeometry } from "../scripts/run-html-pipeline.mjs";
import { publishRepairArtifact } from "../scripts/run-deck-pipeline.mjs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const proof = (ssim, accepted = false) => ({ accepted, aggregate: { fidelity: { ssim: { status: "available", value: ssim } } } });

describe("bounded repair convergence", () => {
  it("applies measured image text deltas to both plan and manifest", () => {
    const plan={slideMapping:{pxPerInX:100,pxPerInY:100},objects:[{id:"t",kind:"editable-text",inchBox:{x:1,y:1,w:2,h:.5}}]};
    const manifest={slides:[{elements:[{id:"t",type:"text",x:1,y:1,w:2,h:.5}]}]};
    const repaired=applyImageTextAdjustments(plan,manifest,[{id:"t",dx:2,dy:-1,dw:4,dh:0}]);
    expect(repaired.changed).toBe(true);
    expect(repaired.plan.objects[0].inchBox).toEqual({x:1.02,y:.99,w:2.04,h:.5});
    expect(repaired.manifest.slides[0].elements[0]).toMatchObject({x:1.02,y:.99,w:2.04,h:.5});
    expect(plan.objects[0].inchBox.x).toBe(1);
  });
  it("applies bounded OOXML geometry drift to an HTML manifest",()=>{const manifest={deck:{size:{width:10,height:5}},slides:[{elements:[{id:"x",x:1,y:1,w:2,h:1}]}]};const result=repairHtmlManifestGeometry(manifest,{viewport:{width:1000,height:500}},[{id:"x",slideIndex:0,dx:10,dy:-5,dw:20,dh:0}]);expect(result.changed).toBe(true);expect(result.manifest.slides[0].elements[0]).toEqual({id:"x",x:1.1,y:.95,w:2.2,h:1});});
  it("stages the complete repair set before replacing any final file",async()=>{const dir=await mkdtemp(join(tmpdir(),"repair-publish-"));const a=join(dir,"a"),b=join(dir,"b"),na=join(dir,"na"),nb=join(dir,"nb");await writeFile(a,"old-a");await writeFile(b,"old-b");await writeFile(na,"new-a");await writeFile(nb,"new-b");await publishRepairArtifact([{source:na,target:a},{source:nb,target:b}]);expect(await readFile(a,"utf8")).toBe("new-a");expect(await readFile(b,"utf8")).toBe("new-b");await writeFile(na,"next-a");await expect(publishRepairArtifact([{source:na,target:a},{source:join(dir,"missing-source"),target:b}])).rejects.toThrow();expect(await readFile(a,"utf8")).toBe("new-a");expect(await readFile(b,"utf8")).toBe("new-b");});
  it("hard caps attempts at three and returns the best improving proof", async () => {
    const attempt = vi.fn(async ({ iteration }) => ({ proof: proof([0.8, 0.85, 0.9][iteration - 1]), artifact: `v${iteration}` }));
    const result = await runBoundedRepair({ initialProof: proof(0.7), maxAttempts: 99, attempt });
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ accepted: false, attempts: 3, artifact: "v3", stopReason: "attempt-limit" });
  });

  it("stops immediately on no improvement and preserves the prior best", async () => {
    const attempt = vi.fn(async () => ({ proof: proof(0.79), artifact: "worse" }));
    const result = await runBoundedRepair({ initialProof: proof(0.8), initialArtifact: "original", attempt });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ artifact: "original", attempts: 1, stopReason: "no-improvement" });
  });

  it("stops as soon as an accepted proof is measured", async () => {
    const attempt = vi.fn(async ({ iteration }) => ({ proof: proof(iteration === 2 ? 0.96 : 0.9, iteration === 2), artifact: `v${iteration}` }));
    const result = await runBoundedRepair({ initialProof: proof(0.8), attempt });
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ accepted: true, attempts: 2, artifact: "v2", stopReason: "accepted" });
  });

  it("accepts an accepted equal candidate when the injected comparator reports no regression", async () => {
    const initialProof = { accepted: false, quality: { editabilityLevel: 4 } };
    const candidateProof = { accepted: true, quality: { editabilityLevel: 4 } };
    const compare = vi.fn(() => 0);
    const result = await runBoundedRepair({
      initialProof,
      initialArtifact: "original",
      compare,
      attempt: async () => ({ proof: candidateProof, artifact: "candidate" })
    });

    expect(compare).toHaveBeenCalledWith(candidateProof, initialProof);
    expect(result).toMatchObject({ accepted: true, proof: candidateProof, artifact: "candidate", attempts: 1, stopReason: "accepted" });
  });

  it("rejects an accepted candidate when the injected comparator reports a regression", async () => {
    const initialProof = proof(0.8);
    const candidateProof = proof(0.9, true);
    const compare = vi.fn(() => -1);
    const result = await runBoundedRepair({
      initialProof,
      initialArtifact: "original",
      compare,
      attempt: async () => ({ proof: candidateProof, artifact: "candidate" })
    });

    expect(compare).toHaveBeenCalledWith(candidateProof, initialProof);
    expect(result).toMatchObject({ accepted: false, proof: initialProof, artifact: "original", attempts: 1, stopReason: "no-improvement" });
  });

  it("does not claim attempts when no deterministic repair is available", async () => {
    const result = await runBoundedRepair({ initialProof: proof(0.8) });
    expect(result).toMatchObject({ attempts: 0, stopReason: "repair-unavailable" });
  });

  it("fails closed when a non-replica route has no replica proof", async () => {
    const result = await runBoundedRepair({ initialProof: null });
    expect(result).toMatchObject({ accepted: false, proof: null, attempts: 0, stopReason: "repair-unavailable" });
  });
});
