#!/usr/bin/env node
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { runDeckPipeline } from "./run-deck-pipeline.mjs";
import { runPython } from "./lib/python-utils.mjs";
import { measureImageReplicaEvidence } from "./lib/replica-evidence.mjs";

const root=resolve(new URL("..",import.meta.url).pathname);
export async function runImagePipeline(input,outputDir,{ocrConfidence=.7}={}){
  const source=resolve(input), out=resolve(outputDir); await mkdir(out,{recursive:true});
  const analysis=join(out,"image-replica-analysis.json"), plan=join(out,"replica-layer-plan.json"), manifest=join(out,"deck.manifest.json");
  await runPython([join(root,"scripts/image-replica-analyze.py"),source,analysis],{cwd:root});
  await runPython([join(root,"scripts/image-replica-plan.py"),analysis,plan,"--ocr-confidence",String(ocrConfidence)],{cwd:root});
  await runPython([join(root,"scripts/image-replica-compile.py"),plan,manifest],{cwd:root});
  const registry=JSON.parse(await readFile(join(out,".pptx-generated-assets.json"),"utf8"));
  const protectedInputs=[source,analysis,plan,manifest,...registry.files.map(p=>join(out,p))];
  return runDeckPipeline(manifest,out,{mode:"replica",inputType:"image",inputSource:source,protectedInputs,
    buildReplicaProof:async({pptxPath,buildBaseEvidence})=>{
      const sourceDir=join(out,"evidence/source"),renderDir=join(out,"evidence/render");await mkdir(sourceDir,{recursive:true});await mkdir(renderDir,{recursive:true});
      await copyFile(source,join(sourceDir,"slide-1.png"));
      const preview=JSON.parse((await runPython([join(root,"scripts/render-preview.py"),pptxPath,renderDir],{cwd:root})).stdout);
      if(preview.status!=="ok") throw new Error(`image replica preview unavailable: ${preview.note}`);
      const raw=await buildBaseEvidence({renderPath:renderDir});
      return measureImageReplicaEvidence(raw,{sourceArtifactPath:sourceDir,renderArtifactPath:renderDir,planPath:plan,pptxPath,manifest:JSON.parse(await readFile(manifest))});
    }});
}

if(import.meta.url===new URL(`file://${process.argv[1]}`).href){runImagePipeline(process.argv[2],process.argv[3]).then(x=>process.stdout.write(`${JSON.stringify(x,null,2)}\n`),e=>{console.error(e?.message??e);process.exitCode=1;});}
