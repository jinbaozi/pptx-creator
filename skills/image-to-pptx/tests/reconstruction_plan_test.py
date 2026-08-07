import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from reconstruction_planner import ReconstructionPlanError, _geometry_digest, _repair_safety, build_reconstruction_plan  # noqa: E402


SOURCE = "source-001"
SOURCE_DIGEST = "a" * 64
ASSET_DIGEST = "b" * 64


def ownership(assets=None, **overrides):
    value = {
        "version": "1.0.0",
        "status": "passed",
        "unassignedShare": 0.0,
        "unassignedBudget": 0.0,
        "conflictPixels": 0,
        "rasterNativeOverlapPixels": 0,
        "duplicateVisibleContent": 0,
        "assets": assets or [],
        "classes": {},
    }
    value.update(overrides)
    return value


def profile(region_id, role, refs, box=(20, 20, 240, 160), area_share=0.05):
    return {
        "id": region_id,
        "role": role,
        "pixelBox": {"x": box[0], "y": box[1], "w": box[2], "h": box[3]},
        "objectRefs": list(refs),
        "density": {"areaShare": area_share},
        "complexity": {"score": 0.2},
    }


def object_record(object_id, object_type, box=(20, 20, 120, 80), z=0, confidence=0.95):
    return {
        "id": object_id,
        "type": object_type,
        "pixelBox": {"x": box[0], "y": box[1], "w": box[2], "h": box[3]},
        "z": z,
        "confidence": confidence,
        "factStatus": "observed",
        "sourceRef": SOURCE,
        "sourceDigest": SOURCE_DIGEST,
    }


def asset_record(object_id, path="assets/local.png"):
    return {
        "objectId": object_id,
        "asset": path,
        "mask": "assets/local-mask.png",
        "assetDigest": ASSET_DIGEST,
        "maskDigest": SOURCE_DIGEST,
        "sourceRef": SOURCE,
        "sourceDigest": SOURCE_DIGEST,
        "normalizedSourceDigest": SOURCE_DIGEST,
        "pagePixelBox": {"x": 20, "y": 20, "w": 120, "h": 80},
        "originPagePixelBox": {"x": 20, "y": 20, "w": 120, "h": 80},
    }


def plan(region_profiles, objects, report=None):
    return build_reconstruction_plan(
        "slide-001",
        (1280, 720),
        region_profiles,
        objects,
        report or ownership(),
        [{"id": SOURCE, "sha256": SOURCE_DIGEST, "normalizedSha256": SOURCE_DIGEST}],
    )


class ReconstructionPlanTests(unittest.TestCase):
    def test_flat_page_emits_three_candidates_and_native_winner(self):
        objects = [object_record("shape-001", "shape"), object_record("text-001", "text", z=1)]
        region = profile("region-001", "card-or-native-group", [item["id"] for item in objects])
        first = plan([region], objects)
        second = plan([region], objects)
        self.assertEqual(first, second)
        candidates = first["regions"][0]["candidates"]
        self.assertEqual({item["strategy"] for item in candidates}, {"native-all", "native-plus-local-assets", "bounded-raster"})
        self.assertEqual(first["regions"][0]["winnerId"], "region-001-native-all")

    def test_hybrid_route_blocks_bounded_raster_over_high_confidence_text(self):
        objects = [object_record("image-001", "image"), object_record("text-001", "text", box=(220, 20, 120, 40), z=1)]
        assets = [asset_record("image-001")]
        value = plan([profile("region-001", "card-or-native-group", [item["id"] for item in objects])], objects, ownership(assets=assets))
        region = value["regions"][0]
        bounded = next(item for item in region["candidates"] if item["strategy"] == "bounded-raster")
        self.assertFalse(bounded["eligible"])
        self.assertTrue(any(item["id"] == "route-object-coverage" and not item["passed"] for item in bounded["gateResults"]))
        self.assertEqual(region["winnerId"], "region-001-native-plus-local-assets")

    def test_image_only_route_chooses_bounded_raster(self):
        objects = [object_record("image-001", "image")]
        value = plan([profile("region-001", "image", ["image-001"])], objects, ownership(assets=[asset_record("image-001")]))
        self.assertEqual(value["regions"][0]["winnerId"], "region-001-bounded-raster")

    def test_conflict_fails_closed_before_scoring(self):
        objects = [object_record("shape-001", "shape")]
        with self.assertRaises(ReconstructionPlanError) as context:
            plan([profile("region-001", "decor", ["shape-001"])], objects, ownership(conflictPixels=1))
        self.assertEqual(context.exception.code, "E_RECONSTRUCTION_NO_ELIGIBLE")

    def test_stable_smallest_region_owns_shared_object(self):
        objects = [object_record("shape-001", "shape")]
        regions = [
            profile("region-large", "decor", ["shape-001"], box=(0, 0, 500, 400), area_share=0.5),
            profile("region-small", "decor", ["shape-001"], box=(20, 20, 100, 80), area_share=0.02),
        ]
        value = plan(regions, objects)
        self.assertEqual(value["regions"][0]["id"], "region-large")
        self.assertEqual(value["regions"][0]["unassignedObjectRefs"], ["shape-001"])
        self.assertEqual(value["regions"][1]["assignedObjectRefs"], ["shape-001"])

    def test_traversal_asset_is_ineligible_for_every_route(self):
        objects = [object_record("image-001", "image")]
        with self.assertRaises(ReconstructionPlanError) as context:
            plan([profile("region-001", "image", ["image-001"])], objects, ownership(assets=[asset_record("image-001", "../escape.png")]))
        self.assertEqual(context.exception.code, "E_RECONSTRUCTION_NO_ELIGIBLE")

    def test_geometry_digest_changes_after_calibration_and_eligible_route_override_is_bound(self):
        objects = [object_record("image-001", "image")]
        assets = [asset_record("image-001")]
        region = profile("region-001", "image", ["image-001"])
        first = plan([region], objects, ownership(assets=assets))
        objects[0]["pixelBox"]["w"] = 96
        rebuilt = build_reconstruction_plan(
            "slide-001", (1280, 720), [region], objects, ownership(assets=assets),
            [{"id": SOURCE, "sha256": SOURCE_DIGEST, "normalizedSha256": SOURCE_DIGEST}],
            route_overrides={"region-001": "native-plus-local-assets"},
        )
        self.assertNotEqual(first["regions"][0]["candidates"][0]["geometryDigest"], rebuilt["regions"][0]["candidates"][0]["geometryDigest"])
        self.assertEqual(rebuilt["routeOverrides"], {"region-001": "native-plus-local-assets"})
        self.assertEqual(rebuilt["regions"][0]["winnerId"], "region-001-native-plus-local-assets")

    def test_geometry_digest_changes_for_nested_style_and_color(self):
        objects = [object_record("text-001", "text")]
        objects[0].update({
            "text": "中文标题",
            "style": {"fontSizePt": 12.0, "nested": {"lineHeightPt": 18.0}},
            "color": "#112233",
        })
        first = _geometry_digest(objects, [])
        objects[0]["style"]["nested"]["lineHeightPt"] = 19.0
        self.assertNotEqual(first, _geometry_digest(objects, []))
        objects[0]["style"]["nested"]["lineHeightPt"] = 18.0
        objects[0]["color"] = "#445566"
        self.assertNotEqual(first, _geometry_digest(objects, []))

    def test_repair_safety_uses_mask_alpha_after_asset_move(self):
        with tempfile.TemporaryDirectory(prefix="image-repair-mask-") as temporary:
            root = Path(temporary)
            mask_path = root / "mask.png"
            from PIL import Image
            import hashlib

            Image.new("L", (2, 2), 0).save(mask_path)
            asset = {
                "objectId": "image-001",
                "mask": "mask.png",
                "maskDigest": hashlib.sha256(mask_path.read_bytes()).hexdigest(),
                "pagePixelBox": {"x": 0, "y": 0, "w": 2, "h": 2},
                "originPagePixelBox": {"x": 0, "y": 0, "w": 2, "h": 2},
            }
            objects = [{"id": "text-001", "type": "text", "confidence": 0.95, "renderBox": {"x": 0, "y": 0, "w": 2, "h": 2}}]
            ownership_report = {"status": "passed", "rasterNativeOverlapPixels": 0, "conflictPixels": 0, "duplicateVisibleContent": 0, "unassignedShare": 0, "unassignedBudget": 0}
            self.assertEqual(_repair_safety(objects, [asset], ownership_report, (8, 8), root)["status"], "passed")
            asset["pagePixelBox"] = {"x": 4, "y": 4, "w": 2, "h": 2}
            objects[0]["renderBox"] = {"x": 4, "y": 4, "w": 2, "h": 2}
            self.assertEqual(_repair_safety(objects, [asset], ownership_report, (8, 8), root)["status"], "passed")

            transparent_digest = asset["maskDigest"]
            asset["maskDigest"] = "0" * 64
            tampered = _repair_safety(objects, [asset], ownership_report, (8, 8), root)
            self.assertEqual(tampered["status"], "failed")
            self.assertEqual(tampered["rasterNativeOverlapObjectRefs"], ["image-001"])

            asset["maskDigest"] = transparent_digest
            mask_path.unlink()
            missing = _repair_safety(objects, [asset], ownership_report, (8, 8), root)
            self.assertEqual(missing["status"], "failed")
            self.assertEqual(missing["rasterNativeOverlapObjectRefs"], ["image-001"])

            Image.new("L", (2, 2), 0).save(mask_path)
            asset["maskDigest"] = hashlib.sha256(mask_path.read_bytes()).hexdigest()
            asset.pop("originPagePixelBox")
            missing_origin = _repair_safety(objects, [asset], ownership_report, (8, 8), root)
            self.assertEqual(missing_origin["status"], "failed")
            self.assertEqual(missing_origin["rasterNativeOverlapObjectRefs"], ["image-001"])

            asset["originPagePixelBox"] = {"x": 0, "y": 0, "w": 2, "h": 2}
            Image.new("L", (2, 2), 255).save(mask_path)
            asset["maskDigest"] = hashlib.sha256(mask_path.read_bytes()).hexdigest()
            safety = _repair_safety(objects, [asset], ownership_report, (8, 8), root)
            self.assertEqual(safety["status"], "failed")
            self.assertEqual(safety["rasterNativeOverlapObjectRefs"], ["image-001"])


if __name__ == "__main__":
    unittest.main()
