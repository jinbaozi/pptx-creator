#!/usr/bin/env node
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, join, resolve } from "node:path";
import { buildReplicaEvidence, runDeckPipeline } from "./run-deck-pipeline.mjs";
import { runPython } from "./lib/python-utils.mjs";
import { measureImageReplicaEvidence } from "./lib/replica-evidence.mjs";

const root=resolve(new URL("..",import.meta.url).pathname);
const execFileAsync=promisify(execFile);
export function applyImageTextAdjustments(plan,manifest,adjustments){const nextPlan=structuredClone(plan),nextManifest=structuredClone(manifest);let changed=false;const byId=new Map(nextPlan.objects.map((item)=>[item.id,item]));const manifestById=new Map(nextManifest.slides[0].elements.map((item)=>[item.id,item]));const pxX=nextPlan.slideMapping.pxPerInX,pxY=nextPlan.slideMapping.pxPerInY;for(const adjustment of adjustments??[]){const item=byId.get(adjustment.id),element=manifestById.get(adjustment.id);if(!item||!element)continue;for(const [key,delta,scale] of [["x",adjustment.dx,pxX],["y",adjustment.dy,pxY],["w",adjustment.dw,pxX],["h",adjustment.dh,pxY]]){if(Math.abs(delta)>.05&&Math.abs(delta)<=24){item.inchBox[key]=Number((item.inchBox[key]+delta/scale).toFixed(4));element[key]=item.inchBox[key];changed=true;}}}return {plan:nextPlan,manifest:nextManifest,changed};}
export async function runImagePipeline(input,outputDir,options={}){
  const {ocrConfidence=.7,prepareInitialReplica}=options;
  const source=resolve(input), out=resolve(outputDir); await mkdir(out,{recursive:true});
  const analysis=join(out,"image-replica-analysis.json"), plan=join(out,"replica-layer-plan.json"), manifest=join(out,"deck.manifest.json");
  await runPython([join(root,"scripts/image-replica-analyze.py"),source,analysis],{cwd:root});
  await runPython([join(root,"scripts/image-replica-plan.py"),analysis,plan,"--ocr-confidence",String(ocrConfidence)],{cwd:root});
  await runPython([join(root,"scripts/image-replica-compile.py"),plan,manifest],{cwd:root});
  if(typeof prepareInitialReplica==="function")await prepareInitialReplica({analysisPath:analysis,planPath:plan,manifestPath:manifest});
  const registry=JSON.parse(await readFile(join(out,".pptx-generated-assets.json"),"utf8"));
  const protectedInputs=[source,analysis,plan,manifest,...registry.files.map(p=>join(out,p))];
  const sourceDir=join(out,"evidence/source"),renderDir=join(out,"evidence/render");await mkdir(sourceDir,{recursive:true});await mkdir(renderDir,{recursive:true});await copyFile(source,join(sourceDir,"slide-1.png"));
  return runDeckPipeline(manifest,out,{mode:"replica",inputType:"image",inputSource:source,protectedInputs,
    buildReplicaProof:async({pptxPath,buildBaseEvidence})=>{
      const preview=JSON.parse((await runPython([join(root,"scripts/render-preview.py"),pptxPath,renderDir],{cwd:root})).stdout);
      if(preview.status!=="ok") throw new Error(`image replica preview unavailable: ${preview.note}`);
      const raw=await buildBaseEvidence({renderPath:renderDir});
      return measureImageReplicaEvidence(raw,{sourceArtifactPath:sourceDir,renderArtifactPath:renderDir,planPath:plan,pptxPath,manifest:JSON.parse(await readFile(manifest))});
    },
    initialRepairArtifact:{planPath:plan},
    runRepairAttempt:async({iteration,proof,artifact})=>{
      const currentPlan=JSON.parse(await readFile(artifact.planPath,"utf8")),currentManifest=artifact.manifest??JSON.parse(await readFile(artifact.manifestPath,"utf8"));
      const measured=JSON.parse((await runPython([join(root,"scripts/measure-image-replica.py"),join(sourceDir,"slide-1.png"),join(proof.paths.render.path,"slide-1.png"),artifact.planPath],{cwd:root})).stdout);const repaired=applyImageTextAdjustments(currentPlan,currentManifest,measured.textAdjustments);
      if(!repaired.changed)return null;const nextPlan=repaired.plan,nextManifest=repaired.manifest,candidatePlanPath=join(out,`.repair-${iteration}.plan.json`),candidateManifestPath=join(out,`.repair-${iteration}.manifest.json`),candidatePptxPath=join(out,`.repair-${iteration}.pptx`),candidateRenderDir=join(out,"evidence",`repair-${iteration}`);await writeFile(candidatePlanPath,`${JSON.stringify(nextPlan,null,2)}\n`);await writeFile(candidateManifestPath,`${JSON.stringify(nextManifest,null,2)}\n`);const rendered=await execFileAsync(process.execPath,[join(root,"scripts/render-pptx.mjs"),candidateManifestPath,candidatePptxPath],{cwd:root});const candidateIntermediate=JSON.parse(rendered.stdout).intermediate;await mkdir(candidateRenderDir,{recursive:true});const preview=JSON.parse((await runPython([join(root,"scripts/render-preview.py"),candidatePptxPath,candidateRenderDir],{cwd:root})).stdout);if(preview.status!=="ok")return null;const coverage=nextManifest.metadata.replicaSource.coverage;const raw=await buildReplicaEvidence({pptxPath:candidatePptxPath,manifest:nextManifest,coverage,intermediate:candidateIntermediate,route:"image",sourcePath:source,renderPath:candidateRenderDir,retryCount:iteration});const candidateProof=await measureImageReplicaEvidence(raw,{sourceArtifactPath:sourceDir,renderArtifactPath:candidateRenderDir,planPath:candidatePlanPath,pptxPath:candidatePptxPath,manifest:nextManifest});return {proof:candidateProof,artifact:{manifestPath:candidateManifestPath,pptxPath:candidatePptxPath,planPath:candidatePlanPath,manifest:nextManifest,intermediate:candidateIntermediate}};
    }});
}

if(import.meta.url===new URL(`file://${process.argv[1]}`).href){runImagePipeline(process.argv[2],process.argv[3]).then(x=>process.stdout.write(`${JSON.stringify(x,null,2)}\n`),e=>{console.error(e?.message??e);process.exitCode=1;});}
