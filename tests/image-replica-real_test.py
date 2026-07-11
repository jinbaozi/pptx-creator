import hashlib, json, subprocess, sys, tempfile, unittest
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "examples/image-input/replica-golden.png"

class RealImageReplicaTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        subprocess.run([sys.executable, str(ROOT / "scripts/generate-image-replica-fixture.py")], check=True)

    def test_analysis_detects_real_objects(self):
        sys.path.insert(0, str(ROOT / "scripts/lib"))
        from image_inspect_core import build_replica_analysis
        analysis = build_replica_analysis(FIXTURE, mode="replica")
        self.assertEqual(analysis["detectors"]["geometryPrimitives"]["status"], "ok")
        self.assertGreaterEqual(len(analysis["ocrBlocks"]), 8)
        self.assertGreaterEqual(len(analysis["rectangles"]), 3)
        self.assertGreaterEqual(len(analysis["lines"]), 1)
        self.assertGreaterEqual(len(analysis["connectedComponents"]), 3)
        self.assertGreaterEqual(len(analysis["residualRegions"]), 1)
        self.assertTrue(all("pixelBox" in x and "inchBox" in x for x in analysis["ocrBlocks"]))
        self.assertEqual(analysis["sourceSha256"], hashlib.sha256(FIXTURE.read_bytes()).hexdigest())

    def test_compiler_owns_assets_and_never_uses_skeleton(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td)
            analysis = out / "analysis.json"; plan = out / "plan.json"; manifest = out / "deck.manifest.json"
            subprocess.run([sys.executable, str(ROOT/"scripts/image-replica-analyze.py"), str(FIXTURE), str(analysis)], check=True)
            subprocess.run([sys.executable, str(ROOT/"scripts/image-replica-plan.py"), str(analysis), str(plan)], check=True)
            subprocess.run([sys.executable, str(ROOT/"scripts/image-replica-compile.py"), str(plan), str(manifest)], check=True)
            data = json.loads(manifest.read_text())
            types = [x["type"] for x in data["slides"][0]["elements"]]
            self.assertIn("text", types); self.assertIn("shape", types); self.assertIn("line", types); self.assertIn("cropped-asset", types)
            self.assertNotIn("manifestSkeleton", json.dumps(data))
            self.assertEqual(data["metadata"]["replicaSource"]["coverage"]["coverage"], 1)
            registry = json.loads((out/".pptx-generated-assets.json").read_text())
            self.assertTrue(registry["files"])
            self.assertTrue(all((out/p).exists() for p in registry["files"]))
            self.assertTrue(all(registry["digests"][p] == hashlib.sha256((out/p).read_bytes()).hexdigest() for p in registry["files"]))
            full = [e for e in data["slides"][0]["elements"] if e["type"] == "cropped-asset" and e["w"] >= 13 and e["h"] >= 7]
            self.assertEqual(full, [])

    def test_compiler_rejects_source_replacement_and_full_slide_crop(self):
        with tempfile.TemporaryDirectory() as td:
            out=Path(td); source=out/"source.png"; source.write_bytes(FIXTURE.read_bytes())
            analysis=out/"analysis.json"; plan_path=out/"plan.json"; manifest=out/"deck.manifest.json"
            subprocess.run([sys.executable,str(ROOT/"scripts/image-replica-analyze.py"),str(source),str(analysis)],check=True)
            subprocess.run([sys.executable,str(ROOT/"scripts/image-replica-plan.py"),str(analysis),str(plan_path)],check=True)
            plan=json.loads(plan_path.read_text()); source.write_bytes(source.read_bytes()+b"changed")
            changed=subprocess.run([sys.executable,str(ROOT/"scripts/image-replica-compile.py"),str(plan_path),str(manifest)],capture_output=True,text=True)
            self.assertNotEqual(changed.returncode,0);self.assertIn("changed after measured analysis",changed.stderr)
            source.write_bytes(FIXTURE.read_bytes()); plan["sourceSha256"]=hashlib.sha256(source.read_bytes()).hexdigest();plan["sourceBytes"]=source.stat().st_size
            plan["objects"]=[{"id":"cheat","kind":"cropped-asset","pixelBox":{"x":0,"y":0,"w":1280,"h":720},"inchBox":{"x":0,"y":0,"w":13.333,"h":7.5},"zOrder":0}]
            plan_path.write_text(json.dumps(plan)); cheat=subprocess.run([sys.executable,str(ROOT/"scripts/image-replica-compile.py"),str(plan_path),str(manifest)],capture_output=True,text=True)
            self.assertNotEqual(cheat.returncode,0);self.assertIn("objects differ from measured analysis",cheat.stderr)

            texture=out/"texture.png"; textured=Image.new("RGB",(128,128)); textured.putdata([((x*7+y*13)%256,(x*11+y*17)%256,(x*19+y*23)%256) for y in range(128) for x in range(128)]);textured.save(texture)
            ta=out/"texture-analysis.json";tp=out/"texture-plan.json"
            subprocess.run([sys.executable,str(ROOT/"scripts/image-replica-analyze.py"),str(texture),str(ta)],check=True)
            subprocess.run([sys.executable,str(ROOT/"scripts/image-replica-plan.py"),str(ta),str(tp),"--skip-ocr"],check=True)
            full=subprocess.run([sys.executable,str(ROOT/"scripts/image-replica-compile.py"),str(tp),str(manifest)],capture_output=True,text=True)
            self.assertNotEqual(full.returncode,0);self.assertIn("full-slide raster fallback",full.stderr)

    def test_analysis_rejects_oversized_decoded_image(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/"wide.png";Image.new("RGB",(8193,1),"white").save(path)
            result=subprocess.run([sys.executable,str(ROOT/"scripts/image-replica-analyze.py"),str(path),str(Path(td)/"analysis.json")],capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0);self.assertIn("safety limit",result.stderr)

if __name__ == "__main__": unittest.main()
