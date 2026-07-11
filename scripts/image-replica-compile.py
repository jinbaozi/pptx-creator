#!/usr/bin/env python3
"""Compile a measured image layer plan to a native-first deck manifest."""
import argparse, hashlib, json, shutil, sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"scripts/lib"))
from image_inspect_core import build_replica_layer_plan

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("plan",type=Path); ap.add_argument("output",type=Path); args=ap.parse_args()
    plan=json.loads(args.plan.read_text())
    if plan.get("kind") != "replica-layer-plan" or not plan.get("sourcePath"): raise SystemExit("measured replica layer plan with sourcePath required")
    analysis_path=Path(plan.get("analysisPath","")).resolve()
    if not analysis_path.is_file() or hashlib.sha256(analysis_path.read_bytes()).hexdigest()!=plan.get("analysisSha256"): raise SystemExit("layer plan is not bound to its measured analysis")
    analysis=json.loads(analysis_path.read_text()); expected=build_replica_layer_plan(analysis,threshold=float(plan.get("threshold",.7)))
    if json.dumps({"objects":expected.get("objects",[]),"sourceInventory":expected.get("sourceInventory",[])},sort_keys=True,separators=(",",":")) != json.dumps({"objects":plan.get("objects",[]),"sourceInventory":plan.get("sourceInventory",[])},sort_keys=True,separators=(",",":")): raise SystemExit("layer plan objects differ from measured analysis")
    source=Path(plan["sourcePath"]).resolve(); out=args.output.resolve(); out.parent.mkdir(parents=True,exist_ok=True)
    source_bytes=source.read_bytes(); source_sha=hashlib.sha256(source_bytes).hexdigest()
    if not plan.get("sourceSha256") or plan["sourceSha256"] != source_sha or int(plan.get("sourceBytes",-1)) != len(source_bytes): raise SystemExit("source artifact changed after measured analysis")
    asset_dir=out.parent/"assets"/("image-"+source_sha[:12]); asset_dir.mkdir(parents=True,exist_ok=True)
    owned=[]; source_copy=asset_dir/source.name; shutil.copy2(source,source_copy); owned.append(source_copy.relative_to(out.parent).as_posix())
    mapping=plan["slideMapping"]; elements=[]; assets=[]
    with Image.open(source) as image:
        width,height=image.size
        for obj in sorted(plan["objects"],key=lambda x:x.get("zOrder",0)):
            pb=obj.get("pixelBox") or {}; x=float(pb.get("x",-1)); y=float(pb.get("y",-1)); w=float(pb.get("w",0)); h=float(pb.get("h",0))
            if x < 0 or y < 0 or w <= 0 or h <= 0 or x+w > width or y+h > height: raise SystemExit(f"object bbox outside source image: {obj.get('id')}")
            if obj.get("kind")=="cropped-asset" and x <= width*.01 and y <= height*.01 and w >= width*.98 and h >= height*.98: raise SystemExit("full-slide raster fallback is prohibited")
            b=obj["inchBox"]; base={"id":obj["id"],**{k:b[k] for k in ("x","y","w","h")},"zOrder":obj.get("zOrder",0)}
            if obj["kind"]=="native-shape":
                style={"backgroundColor":obj["color"],"borderWidth":0} if obj.get("fill",True) else {"backgroundColor":"#FFFFFF","transparency":100,"borderColor":obj["color"],"borderWidth":max(.75,float(obj.get("borderWidthPx",1))*.75)}
                elements.append({**base,"type":"shape","shape":obj.get("shape","rect"),"style":style})
            elif obj["kind"]=="native-line": elements.append({**base,"type":"line","style":{"color":obj["color"],"width":max(1,float(obj["pixelBox"]["h"])*.75)}})
            elif obj["kind"]=="editable-text":
                style=obj.get("styleHints",{}); elements.append({**base,"type":"text","text":obj["text"],"style":{**style,"margin":0,"valign":"mid","align":"left"},"sourceConfidence":obj.get("confidence")})
            else:
                pb=obj["pixelBox"]; crop=asset_dir/f"{obj['id']}.png"; image.crop((int(pb['x']),int(pb['y']),int(pb['x']+pb['w']),int(pb['y']+pb['h']))).save(crop)
                rel=crop.relative_to(out.parent).as_posix(); owned.append(rel); aid=f"asset-{obj['id']}"; assets.append({"id":aid,"src":rel})
                elements.append({**base,"type":"cropped-asset","assets":{"id":aid},"provenance":{"source":source.name,"pixelBox":pb},"replicaFallback":{"kind":"raster","fullSlide":False,"reason":obj.get("reason","low-confidence-or-complex-region"),"bbox":{"x":b["x"],"y":b["y"],"width":b["w"],"height":b["h"]},"zOrder":obj.get("zOrder",0),"nativeAlternativesAttempted":["editable-text","native-shape","native-line"]}})
    audited=plan.get("sourceInventory",[]); actionable=[item for item in audited if item.get("disposition")!="ignored"]; ignored=[item for item in audited if item.get("disposition")=="ignored"]
    inventory=len(actionable); covered=len(elements); dropped=[obj["id"] for obj in plan["objects"] if obj["id"] not in {element["id"] for element in elements}]
    slide_area=mapping["widthIn"]*mapping["heightIn"]
    raster_area=sum(e["w"]*e["h"] for e in elements if e["type"]=="cropped-asset")
    native_coverage=round(max(0,min(1,1-raster_area/slide_area)),4)
    coverage=covered/max(1,inventory)
    coverage_record={"coverage":coverage,"nativeCoverage":native_coverage,"sourceInventory":inventory,"coveredElements":covered,"ignoredWithReason":ignored,"droppedElements":dropped,"unsupportedEffects":[]}
    manifest={"version":"0.2.0","metadata":{"mode":"replica","inputType":"image","qualityProfile":"replica","replicaSource":{"type":"image","path":source.name,"sourceSha256":source_sha,"coverage":{**coverage_record,"slides":[coverage_record]}}},"designSystem":{"source":str(ROOT/"design-systems/business-neutral/DESIGN.md"),"name":"Source Image"},"deck":{"title":plan.get("deckTitle","Image Replica"),"language":"en-US","size":{"preset":mapping["preset"],"width":mapping["widthIn"],"height":mapping["heightIn"],"unit":"in"}},"assets":assets,"slides":[{"id":"slide-001","type":"replica","title":plan.get("deckTitle","Image Replica"),"background":{"type":"solid","color":"#F5F7FB"},"elements":elements}]}
    out.write_text(json.dumps(manifest,indent=2)+"\n")
    registry={"version":"0.1.0","owner":"image-replica-compiler","files":owned,"digests":{path:hashlib.sha256((out.parent/path).read_bytes()).hexdigest() for path in owned}}; (out.parent/".pptx-generated-assets.json").write_text(json.dumps(registry,indent=2)+"\n")
    print(out)
if __name__=="__main__": main()
