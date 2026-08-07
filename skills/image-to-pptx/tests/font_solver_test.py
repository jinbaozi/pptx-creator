import json
import sys
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from font_solver import (  # noqa: E402
    apply_typography_tiers,
    build_tier_requirements,
    classify_text_tier,
    discover_font_inventory,
    font_candidate_score,
    serializable_inventory,
    solve_text_style,
    infer_alignment,
    _render_font_mask,
)
import font_solver  # noqa: E402


class FontSolverTest(unittest.TestCase):
    def test_inventory_is_offline_stable_and_capped(self):
        first = serializable_inventory(discover_font_inventory(["Title 42 汉"]))
        second = serializable_inventory(discover_font_inventory(["Title 42 汉"]))
        self.assertEqual(
            json.dumps(first, ensure_ascii=False, sort_keys=True),
            json.dumps(second, ensure_ascii=False, sort_keys=True),
        )
        self.assertTrue(first["offline"])
        self.assertLessEqual(len(first["candidateFamilies"]), 6)
        self.assertEqual(first["runtime"]["fontTools"]["status"], "available")
        self.assertGreater(first["requiredGlyphCount"], 0)
        self.assertTrue(any(face["missingGlyphCount"] >= 0 for face in first["faces"]))

    def test_solver_budget_and_real_font_metrics(self):
        inventory = discover_font_inventory()
        image = Image.new("RGB", (320, 100), "white")
        draw = ImageDraw.Draw(image)
        draw.text((20, 20), "Title 42", fill="black")
        style, render_box, evidence, tier = solve_text_style(
            image,
            {"x": 10, "y": 10, "w": 240, "h": 50},
            "Title 42",
            {"pixelBox": {"x": 10, "y": 10, "w": 240, "h": 50}, "regionRole": "title"},
            inventory,
            page_budget={"evaluated": 0, "limit": 180},
        )
        self.assertIn(evidence["selected"]["selectionFamily"], inventory["candidateFamilies"])
        self.assertGreater(render_box["w"], 0)
        self.assertEqual(tier, "Display Title")
        self.assertLessEqual(evidence["candidateCaps"]["families"], 6)
        self.assertLessEqual(evidence["candidateCaps"]["sizes"], 5)
        self.assertLessEqual(evidence["candidateCaps"]["weights"], 3)
        self.assertLessEqual(evidence["candidateCaps"]["spacing"], 3)
        self.assertLessEqual(evidence["candidateCaps"]["lineHeight"], font_solver.FONT_LINE_HEIGHT_CAP)
        self.assertLessEqual(evidence["candidateCaps"]["boxWidth"], font_solver.FONT_WIDTH_CAP)
        self.assertLessEqual(evidence["candidateCaps"]["layoutTuples"], font_solver.FONT_LAYOUT_TUPLE_CAP)
        self.assertLessEqual(evidence["budget"]["pageEvaluated"], 180)
        self.assertIn("localSsim", evidence["selected"]["metrics"])
        self.assertGreaterEqual(len(evidence["evaluatedFamilies"]), min(2, len(inventory["candidateFamilies"])))
        self.assertTrue(evidence["evaluatedFaceIds"])
        self.assertGreater(len(evidence["evaluatedSizes"]), 1)
        self.assertGreaterEqual(len(evidence["evaluatedRequestedWeights"]), 3)
        self.assertGreaterEqual(len(evidence["evaluatedSpacings"]), 3)
        self.assertEqual(evidence["deferredReason"], "tier-budget-cap")
        self.assertEqual(evidence["dpi"], 96)
        self.assertAlmostEqual(evidence["ptToPx"], 96 / 72)
        self.assertEqual(evidence["selected"]["weight"], evidence["selected"]["actualWeightClass"])
        selected_face = next(face for face in inventory["faces"] if face["faceId"] == evidence["selected"]["faceId"])
        self.assertEqual(evidence["selected"]["faceDigest"], selected_face["pathDigest"])
        _, render_metrics = _render_font_mask(selected_face["pathEvidence"], 12, "A", 0)
        self.assertEqual(render_metrics["fontSizePx"], 16)
        self.assertIn("targetInkDensity", evidence["targetMetrics"])
        self.assertEqual(evidence["targetMetrics"]["provenance"], "current-line-observation")
        self.assertEqual(evidence["selected"]["metrics"]["provenance"], "line-measurement")
        self.assertEqual(evidence["layout"]["provenance"], "selected-font-layout")
        self.assertEqual(evidence["layout"]["renderedLineCount"], len(evidence["layout"]["lineBreaks"]))
        self.assertEqual(evidence["layout"]["lineHeightPt"], evidence["selected"]["lineHeightPt"])
        self.assertIn("alignmentSource", evidence)
        limited_state = {"evaluated": 174, "limit": 180}
        _, _, limited_evidence, _ = solve_text_style(
            image,
            {"x": 10, "y": 10, "w": 240, "h": 50},
            "Title 42",
            {"pixelBox": {"x": 10, "y": 10, "w": 240, "h": 50}, "regionRole": "title"},
            inventory,
            page_budget=limited_state,
        )
        self.assertEqual(limited_evidence["deferredReason"], "page-budget-cap")

    def test_tiers_fallback_and_score_direction(self):
        self.assertEqual(classify_text_tier({"pixelBox": {"x": 0, "y": 0, "w": 40, "h": 12}}, 720)[0], "Body")
        self.assertGreater(
            font_candidate_score({"inkBboxIou": 0.9, "localSsim": 0.9, "widthError": 0.1, "heightError": 0.1, "baselineError": 0.1, "lineCountConsistency": 1, "ocrContentConsistency": 1}),
            font_candidate_score({"inkBboxIou": 0.2, "localSsim": 0.2, "widthError": 0.8, "heightError": 0.8, "baselineError": 0.8, "lineCountConsistency": 0, "ocrContentConsistency": 0}),
        )
        objects = [{
            "id": "text-001", "type": "text", "style": {"fontFamily": "A", "fontSizePt": 20, "fontWeight": 700, "charSpacingPt": 0, "lineHeightPt": 24, "textBoxWidthScale": 1, "align": "left"},
            "fontSolver": {"version": "font-fit-v1", "tier": "Display Title", "representativeReuse": False, "alignmentSource": "explicit", "selected": {"family": "A", "selectionFamily": "A", "actualFamily": "A", "faceId": "face-a", "faceDigest": "a" * 64, "fontSizePt": 20, "requestedWeight": 700, "weight": 700, "actualWeightClass": 700, "charSpacingPt": 0, "lineHeightPt": 24, "textBoxWidthScale": 1, "metrics": {"inkBboxIou": 0.8, "localSsim": 0.8, "widthError": 0.1, "provenance": "line-measurement"}, "metricProvenance": "line-measurement"}},
        }]
        tiers = apply_typography_tiers(objects, [{"id": "text-001", "pixelBox": {"x": 0, "y": 0, "w": 100, "h": 60}, "role": "title"}], (1280, 720))
        self.assertEqual(tiers[0]["name"], "Display Title")
        self.assertEqual(objects[0]["typographyTierRef"], tiers[0]["id"])

    def test_dense_page_reuses_one_representative_per_tier(self):
        inventory = discover_font_inventory()
        image = Image.new("RGB", (1280, 720), "white")
        lines = []
        roles = ("title", "section-title", "card-title", "body", "caption", "footer", "badge")
        for index in range(35):
            role = roles[index % len(roles)]
            lines.append({
                "id": f"text-{index:03d}",
                "text": f"Item {index}",
                "role": role,
                "disposition": "editable-text",
                "pixelBox": {"x": 20 + (index % 5) * 220, "y": 20 + (index // 5) * 80, "w": 180, "h": 30},
            })
        requirements = build_tier_requirements(lines, image.height)
        state = {"evaluated": 0, "limit": 180}
        fake_metrics = {"width": 32.0, "height": 18.0, "baseline": 18.0, "lineCount": 1.0, "bboxX": 0.0, "bboxY": 0.0}
        measured = {}
        with patch.object(font_solver, "_render_font_mask", return_value=(Image.new("L", (32, 18), 255), fake_metrics)):
            for line in lines:
                _, _, evidence, tier = solve_text_style(
                    image, line["pixelBox"], line["text"], line, inventory,
                    page_budget=state, object_id=line["id"], tier_requirements=requirements,
                )
                measured.setdefault(tier, []).append(evidence)
        self.assertLessEqual(state["evaluated"], font_solver.FONT_PAGE_BUDGET)
        self.assertEqual(set(measured), set(font_solver.TIER_ORDER))
        for evidence_list in measured.values():
            self.assertEqual(sum(not item["representativeReuse"] for item in evidence_list), 1)
            expected_candidates = min(
                font_solver.FONT_TIER_REPRESENTATIVE_BUDGET,
                len(inventory["candidateFamilies"]) * evidence_list[0]["candidateCaps"]["layoutTuples"],
            )
            self.assertEqual(sum(item["evaluatedCandidates"] for item in evidence_list), expected_candidates)
            self.assertEqual(sum(item["representativeReuse"] for item in evidence_list), len(evidence_list) - 1)

    def test_apply_tiers_rejects_member_truth_mutation_and_infers_alignment(self):
        base = {
            "id": "text-001", "type": "text", "pixelBox": {"x": 0, "y": 0, "w": 100, "h": 60},
            "style": {"fontFamily": "A", "fontSizePt": 20, "fontWeight": 700, "charSpacingPt": 0, "lineHeightPt": 24, "textBoxWidthScale": 1, "align": "center"},
            "fontSolver": {"tier": "Display Title", "representativeReuse": False, "selected": {
                "family": "A", "selectionFamily": "A", "actualFamily": "A", "faceId": "face-a", "faceDigest": "a" * 64,
                "fontSizePt": 20, "requestedWeight": 700, "weight": 700, "actualWeightClass": 700, "charSpacingPt": 0,
                "lineHeightPt": 24, "textBoxWidthScale": 1,
                "metrics": {"inkBboxIou": 0.8, "localSsim": 0.8, "widthError": 0.1, "provenance": "line-measurement"},
            }},
        }
        second = deepcopy(base)
        second["id"] = "text-002"
        second["fontSolver"]["representativeReuse"] = True
        second["fontSolver"]["selected"]["faceId"] = "face-b"
        with self.assertRaises(RuntimeError):
            apply_typography_tiers([base, second], [
                {"id": "text-001", "role": "title", "pixelBox": base["pixelBox"]},
                {"id": "text-002", "role": "title", "pixelBox": second["pixelBox"]},
            ], (1280, 720))
        self.assertEqual(infer_alignment({"role": "title"}, {"x": 440, "y": 10, "w": 400, "h": 40}, 1280)[0], "center")
        self.assertEqual(infer_alignment({"role": "label"}, {"x": 1120, "y": 10, "w": 120, "h": 20}, 1280)[0], "right")

    def test_wrap_metrics_are_deterministic_for_narrow_box(self):
        inventory = discover_font_inventory(["A narrow English sentence"])
        face = inventory["faces"][0]
        first_mask, first_metrics = _render_font_mask(face["pathEvidence"], 12, "A narrow English sentence", 0, 14, 70)
        second_mask, second_metrics = _render_font_mask(face["pathEvidence"], 12, "A narrow English sentence", 0, 14, 70)
        self.assertEqual(first_metrics["renderedLineCount"], second_metrics["renderedLineCount"])
        self.assertEqual(first_metrics["lineBreaks"], second_metrics["lineBreaks"])
        self.assertGreater(first_metrics["renderedLineCount"], 1)
        self.assertEqual(first_metrics["renderedLineCount"], len(first_metrics["lineBreaks"]))
        self.assertEqual(first_mask.size, second_mask.size)

    def test_representative_reuse_is_zero_cost_at_page_limit(self):
        inventory = discover_font_inventory(["One line"])
        image = Image.new("RGB", (400, 120), "white")
        state = {"evaluated": 0, "limit": font_solver.FONT_PAGE_BUDGET}
        line = {"id": "body-001", "text": "One line", "role": "body", "pixelBox": {"x": 10, "y": 10, "w": 220, "h": 36}}
        requirements = build_tier_requirements([line], image.height)
        _, _, measured, tier = solve_text_style(image, line["pixelBox"], line["text"], line, inventory, page_budget=state, object_id=line["id"], tier_requirements=requirements)
        state["evaluated"] = state["limit"]
        line2 = {**line, "id": "body-002", "text": "Another very long reuse line that wraps repeatedly", "pixelBox": {"x": 20, "y": 60, "w": 70, "h": 24}}
        with patch.object(font_solver, "_render_font_mask", side_effect=AssertionError("reuse must not render")):
            style, render_box, reused, reused_tier = solve_text_style(image, line2["pixelBox"], line2["text"], line2, inventory, page_budget=state, object_id=line2["id"], tier_requirements=requirements)
        self.assertEqual(reused_tier, tier)
        self.assertTrue(reused["representativeReuse"])
        self.assertEqual(reused["evaluatedCandidates"], 0)
        self.assertEqual(state["evaluated"], state["limit"])
        self.assertEqual(reused["representativeObjectId"], line["id"])
        for key in ("evaluatedFamilies", "evaluatedFaceIds", "evaluatedSizes", "evaluatedRequestedWeights", "evaluatedSpacings", "evaluatedLineHeights", "evaluatedTextBoxWidthScales"):
            self.assertEqual(reused[key], [])
        for style_key, selected_key in (("fontFamily", "family"), ("fontSizePt", "fontSizePt"), ("fontWeight", "weight"), ("charSpacingPt", "charSpacingPt"), ("lineHeightPt", "lineHeightPt"), ("textBoxWidthScale", "textBoxWidthScale")):
            self.assertEqual(style[style_key], measured["selected"][selected_key])
        self.assertEqual(reused["selected"]["family"], measured["selected"]["family"])
        self.assertEqual(reused["selected"]["fontSizePt"], measured["selected"]["fontSizePt"])
        self.assertEqual(reused["targetMetrics"]["provenance"], "current-line-observation")
        self.assertGreater(reused["layout"]["renderedLineCount"], 1)
        self.assertEqual(reused["layout"]["renderedLineCount"], len(reused["layout"]["lineBreaks"]))
        self.assertGreater(render_box["h"], line2["pixelBox"]["h"])
        self.assertGreater(render_box["w"], 0)

    def test_low_confidence_local_crop_is_not_a_tier_glyph_requirement(self):
        lines = [
            {"id": "keep", "text": "editable", "role": "body", "disposition": "editable-text", "pixelBox": {"x": 0, "y": 0, "w": 80, "h": 20}},
            {"id": "drop", "text": "uncertain", "role": "body", "disposition": "local-crop", "pixelBox": {"x": 0, "y": 30, "w": 80, "h": 20}},
        ]
        requirements = build_tier_requirements(lines, 720)
        self.assertEqual(requirements["Body"]["texts"], ["editable"])
        self.assertNotIn("uncertain", requirements["Body"]["requiredText"])

    def test_selection_alias_can_render_with_actual_family_truth(self):
        inventory = discover_font_inventory(["Alias text"])
        aliased = deepcopy(inventory)
        alias = "Selection Alias"
        aliased["candidateFamilies"] = [alias]
        for face in aliased["faces"]:
            face["selectionFamily"] = alias
            face["actualFamily"] = face["family"]
        image = Image.new("RGB", (320, 100), "white")
        line = {"id": "alias-001", "text": "Alias text", "role": "body", "pixelBox": {"x": 10, "y": 10, "w": 220, "h": 40}}
        style, _, evidence, _ = solve_text_style(image, line["pixelBox"], line["text"], line, aliased, page_budget={"evaluated": 0, "limit": font_solver.FONT_PAGE_BUDGET}, object_id=line["id"], tier_requirements=build_tier_requirements([line], image.height))
        self.assertEqual(style["fontFamily"], evidence["selected"]["actualFamily"])
        self.assertNotIn(style["fontFamily"], aliased["candidateFamilies"])
        self.assertEqual(evidence["selected"]["selectionFamily"], alias)
        self.assertNotEqual(evidence["selected"]["actualFamily"], alias)


if __name__ == "__main__":
    unittest.main()
