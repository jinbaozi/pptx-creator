#!/usr/bin/env python3
"""Generate deterministic English-only example slide images and benchmarks.

The benchmark fixture is deliberately source-like rather than a synthetic
scene IR dump.  The PNG is the only visual source; ``ground-truth.json`` is a
separate, human-auditable record of the objects that were intentionally drawn
so object-level analysis can be measured without inventing hidden data.
"""

from __future__ import annotations

import argparse
import json
import math
from typing import Any

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]

BENCHMARK_VERSION = "1.0.0"
BENCHMARK_ID = "image-to-pptx-object-level-v1"
BENCHMARK_SIZE = {"width": 1280, "height": 720}


def font(size: int, bold: bool = False):
    candidates = (
        [
            "/Library/Fonts/Arial Bold.ttf",
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
        ]
        if bold
        else [
            "/Library/Fonts/Arial.ttf",
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
        ]
    )
    for candidate in candidates:
        if Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def minimal(path: Path) -> None:
    image = Image.new("RGB", (1280, 720), "#F5F7FB")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 1279, 118), fill="#102A43")
    draw.text((64, 35), "EDITABLE RECONSTRUCTION", font=font(32, True), fill="#FFFFFF")
    draw.text((64, 152), "Visible facts become native PowerPoint objects", font=font(24), fill="#243B53")
    draw.rectangle((64, 235, 1216, 492), fill="#FFFFFF", outline="#CBD5E1", width=2)
    draw.rectangle((64, 235, 76, 492), fill="#2F80ED")
    draw.text((104, 282), "92% NATIVE CONTENT", font=font(31, True), fill="#102A43")
    draw.text((104, 344), "Text, cards, and dividers remain editable.", font=font(22), fill="#486581")
    draw.line((64, 548, 1216, 548), fill="#829AB1", width=3)
    draw.text((64, 588), "SOURCE  /  REBUILD  /  VERIFY", font=font(22, True), fill="#102A43")
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path)


def complex_second(path: Path) -> None:
    image = Image.new("RGB", (1280, 720), "#FFFDF8")
    draw = ImageDraw.Draw(image)
    draw.text((64, 42), "GROWTH MOVES TO RETENTION", font=font(32, True), fill="#2C2A29")
    draw.text((64, 92), "Visible bar geometry is editable; hidden data is not invented.", font=font(20), fill="#6B625D")
    draw.line((80, 575, 1200, 575), fill="#8E8279", width=3)
    colors = ["#D98C5F", "#CF7442", "#B95D34", "#9F482C"]
    heights = [145, 230, 310, 390]
    labels = ["Q1", "Q2", "Q3", "Q4"]
    for index, (height, color, label) in enumerate(zip(heights, colors, labels)):
        left = 160 + index * 245
        draw.rectangle((left, 575 - height, left + 120, 575), fill=color)
        draw.text((left + 37, 594), label, font=font(20, True), fill="#2C2A29")
    draw.rectangle((64, 160, 1216, 648), outline="#D8CEC6", width=2)
    draw.text((880, 190), "4 QUARTERS", font=font(21, True), fill="#2C2A29")
    draw.text((880, 230), "Steady visible rise", font=font(18), fill="#6B625D")
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path)


def _gt_object(
    object_id: str,
    object_type: str,
    box: tuple[int, int, int, int],
    z: int,
    *,
    text: str | None = None,
    style: dict[str, Any] | None = None,
    relations: dict[str, list[str]] | None = None,
    recoverability: dict[str, Any] | None = None,
    match_types: list[str] | None = None,
    required: bool = True,
) -> dict[str, Any]:
    """Return one stable, source-bound object truth record."""

    x, y, width, height = box
    return {
        "id": object_id,
        "type": object_type,
        "box": {"x": x, "y": y, "w": width, "h": height, "unit": "px"},
        "z": z,
        "text": text,
        "style": style or {},
        "relations": relations
        or {"contains": [], "overlaps": [], "occludes": [], "anchors": []},
        "recoverability": recoverability
        or {
            "status": "native",
            "confidence": 1.0,
            "renderedAs": object_type,
            "reason": "visible geometry is deterministic",
        },
        "match": {
            "types": match_types or [object_type],
            "required": required,
            "minIoU": 0.15,
        },
    }


def benchmark_ground_truth() -> dict[str, Any]:
    """Describe the intentionally drawn objects without inventing chart data."""

    objects = [
        _gt_object(
            "header-band",
            "shape",
            (0, 0, 1280, 112),
            0,
            style={"shape": "rect", "fill": True, "color": "#12263A", "opacity": 1.0},
            match_types=["shape"],
            required=False,
        ),
        _gt_object(
            "header-title",
            "text",
            (64, 34, 620, 42),
            4,
            text="OBJECT-LEVEL RECONSTRUCTION BENCHMARK",
            style={"fontFamily": "Arial", "fontSizePt": 30, "bold": True, "lineCount": 1},
            match_types=["text"],
        ),
        _gt_object(
            "copy-card",
            "shape",
            (64, 192, 446, 242),
            0,
            style={"shape": "roundRect", "fill": True, "color": "#FFFFFF", "borderColor": "#CAD5E2", "opacity": 1.0},
            match_types=["shape"],
        ),
        _gt_object(
            "multiline-copy",
            "text",
            (92, 232, 300, 78),
            2,
            text="Multi-line text block\nremains source-bound",
            style={"fontFamily": "Arial", "fontSizePt": 24, "bold": False, "lineCount": 2, "lineHeightPt": 30},
            match_types=["text"],
        ),
        _gt_object(
            "icon-star",
            "icon",
            (416, 245, 60, 60),
            3,
            style={"iconKind": "star", "fill": True, "color": "#F6C85F", "opacity": 1.0},
            recoverability={
                "status": "native",
                "confidence": 0.98,
                "renderedAs": "native-shape",
                "reason": "simple visible vector glyph",
            },
            match_types=["shape"],
        ),
        _gt_object(
            "rotated-badge",
            "shape",
            (500, 132, 232, 104),
            2,
            style={"shape": "roundRect", "fill": True, "color": "#E76F51", "opacity": 0.62, "rotationDeg": 12},
            recoverability={
                "status": "native",
                "confidence": 0.93,
                "renderedAs": "native-shape",
                "reason": "rotation and alpha are explicit visual attributes",
            },
            match_types=["shape"],
        ),
        _gt_object(
            "rotated-label",
            "text",
            (526, 164, 182, 34),
            3,
            text="ROTATED 12°",
            style={"fontFamily": "Arial", "fontSizePt": 18, "bold": True, "lineCount": 1, "rotationDeg": 12},
            match_types=["text"],
            required=False,
        ),
        _gt_object(
            "chart-panel",
            "shape",
            (545, 198, 671, 312),
            0,
            style={"shape": "roundRect", "fill": True, "color": "#FFFFFF", "borderColor": "#D8E1EA", "opacity": 1.0},
            match_types=["shape"],
        ),
        _gt_object(
            "chart-title",
            "text",
            (620, 218, 330, 30),
            2,
            text="VISIBLE BAR GEOMETRY",
            style={"fontFamily": "Arial", "fontSizePt": 18, "bold": True, "lineCount": 1},
            match_types=["text"],
        ),
        _gt_object(
            "retention-chart",
            "chart",
            (620, 258, 540, 210),
            1,
            style={"chartType": "bar", "dataPolicy": "visible-geometry-only"},
            recoverability={
                "status": "partial-native",
                "confidence": 0.9,
                "renderedAs": "native-shapes",
                "reason": "bar heights are visible; numeric dataset is not supplied",
            },
            match_types=["shape", "connector", "text"],
        ),
        _gt_object(
            "bar-q1",
            "shape",
            (662, 354, 58, 86),
            2,
            style={"shape": "rect", "fill": True, "color": "#4C78A8", "opacity": 1.0},
            relations={"contains": [], "overlaps": [], "occludes": [], "anchors": ["retention-chart"]},
            match_types=["shape"],
        ),
        _gt_object(
            "bar-q2",
            "shape",
            (762, 316, 58, 124),
            2,
            style={"shape": "rect", "fill": True, "color": "#59A14F", "opacity": 1.0},
            relations={"contains": [], "overlaps": [], "occludes": [], "anchors": ["retention-chart"]},
            match_types=["shape"],
        ),
        _gt_object(
            "bar-q3",
            "shape",
            (862, 286, 58, 154),
            2,
            style={"shape": "rect", "fill": True, "color": "#F28E2B", "opacity": 1.0},
            relations={"contains": [], "overlaps": [], "occludes": [], "anchors": ["retention-chart"]},
            match_types=["shape"],
        ),
        _gt_object(
            "bar-q4",
            "shape",
            (962, 324, 58, 116),
            2,
            style={"shape": "rect", "fill": True, "color": "#E15759", "opacity": 1.0},
            relations={"contains": [], "overlaps": [], "occludes": [], "anchors": ["retention-chart"]},
            match_types=["shape"],
        ),
        _gt_object(
            "chart-overlay",
            "shape",
            (1002, 300, 148, 106),
            4,
            style={"shape": "rect", "fill": True, "color": "#F6C85F", "opacity": 0.32, "transparency": 68},
            relations={"contains": [], "overlaps": ["bar-q4", "retention-chart"], "occludes": ["bar-q4"], "anchors": []},
            recoverability={
                "status": "native",
                "confidence": 0.88,
                "renderedAs": "native-shape",
                "reason": "bounded translucent overlay",
            },
            match_types=["shape"],
        ),
        _gt_object(
            "table-panel",
            "shape",
            (64, 486, 446, 194),
            0,
            style={"shape": "roundRect", "fill": True, "color": "#FFFFFF", "borderColor": "#CAD5E2", "opacity": 1.0},
            match_types=["shape"],
        ),
        _gt_object(
            "region-table",
            "table",
            (82, 508, 410, 150),
            1,
            style={"columns": 3, "rows": 4, "headerRows": 1, "dataPolicy": "visible-cell-text-only"},
            text="Region | Share | Delta\nNorth | 42% | +8\nSouth | 31% | +3\nWest | 27% | -2",
            recoverability={
                "status": "partial-native",
                "confidence": 0.87,
                "renderedAs": "native-table",
                "reason": "closed grid and visible cell text are present",
            },
            match_types=["table", "shape", "connector", "text"],
        ),
        _gt_object(
            "table-header",
            "text",
            (98, 516, 350, 24),
            2,
            text="REGION   SHARE   DELTA",
            style={"fontFamily": "Arial", "fontSizePt": 14, "bold": True, "lineCount": 1},
            match_types=["text"],
        ),
        _gt_object(
            "table-values",
            "text",
            (98, 546, 350, 90),
            2,
            text="North     42%      +8\nSouth     31%      +3\nWest      27%      -2",
            style={"fontFamily": "Arial", "fontSizePt": 14, "bold": False, "lineCount": 3, "lineHeightPt": 24},
            match_types=["text"],
        ),
        _gt_object(
            "overlap-badge",
            "shape",
            (366, 364, 154, 56),
            5,
            style={"shape": "roundRect", "fill": True, "color": "#12263A", "opacity": 0.9},
            relations={"contains": ["overlap-label"], "overlaps": ["copy-card"], "occludes": ["copy-card"], "anchors": []},
            match_types=["shape"],
        ),
        _gt_object(
            "overlap-label",
            "text",
            (388, 378, 112, 26),
            6,
            text="OVERLAP",
            style={"fontFamily": "Arial", "fontSizePt": 16, "bold": True, "lineCount": 1, "color": "#FFFFFF"},
            relations={"contains": [], "overlaps": ["overlap-badge"], "occludes": [], "anchors": []},
            match_types=["text"],
        ),
    ]
    return {
        "version": BENCHMARK_VERSION,
        "kind": "image-to-pptx-object-ground-truth",
        "id": BENCHMARK_ID,
        "source": "reference.png",
        "size": {**BENCHMARK_SIZE, "unit": "px"},
        "coordinateSpace": "top-left-pixel",
        "objects": objects,
        "acceptance": {
            "requiredObjectRecall": 0.68,
            "requiredRegionIoU": 0.15,
            "wholeSlideRasterAllowed": False,
            "notes": "Semantic chart/table/icon records may match observable native shapes, connectors, and text; hidden numeric data is never required.",
        },
    }


def object_benchmark(path: Path, ground_truth_path: Path, manifest_path: Path) -> None:
    """Draw a stable mixed-object challenge image and its truth manifest."""

    image = Image.new("RGBA", (BENCHMARK_SIZE["width"], BENCHMARK_SIZE["height"]), "#F7F9FC")
    draw = ImageDraw.Draw(image)

    # Header and multi-line text card.
    draw.rectangle((0, 0, 1279, 111), fill="#12263A")
    draw.text((64, 34), "OBJECT-LEVEL RECONSTRUCTION BENCHMARK", font=font(30, True), fill="#FFFFFF")
    draw.rounded_rectangle((64, 192, 510, 434), radius=18, fill="#FFFFFF", outline="#CAD5E2", width=2)
    draw.multiline_text(
        (92, 232),
        "Multi-line text block\nremains source-bound",
        font=font(24),
        fill="#243B53",
        spacing=6,
    )
    draw.text((94, 330), "No hidden facts are added.", font=font(18), fill="#6B7C93")

    # Star icon, intentionally overlapping the card's lower-right edge.
    cx, cy, outer, inner = 446, 275, 30, 13
    points = []
    for index in range(10):
        radius = outer if index % 2 == 0 else inner
        angle = -math.pi / 2 + index * math.pi / 5
        points.append((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
    draw.polygon(points, fill="#F6C85F", outline="#C69214")

    # Rotated, translucent badge.  The flattened PNG remains deterministic;
    # rotation and opacity are retained in the truth record for the analyser.
    badge = Image.new("RGBA", (210, 64), (0, 0, 0, 0))
    badge_draw = ImageDraw.Draw(badge)
    badge_draw.rounded_rectangle((0, 0, 209, 63), radius=14, fill=(231, 111, 81, 158))
    badge_draw.text((20, 17), "ROTATED 12°", font=font(18, True), fill="#FFFFFF")
    rotated = badge.rotate(12, expand=True, resample=Image.Resampling.BICUBIC)
    image.alpha_composite(rotated, dest=(500, 132))

    # Chart panel with explicit bars, axes, labels, and a bounded translucent
    # overlay.  Only visible geometry is a recoverable fact.
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((545, 198, 1215, 510), radius=18, fill="#FFFFFF", outline="#D8E1EA", width=2)
    draw.text((620, 218), "VISIBLE BAR GEOMETRY", font=font(18, True), fill="#243B53")
    draw.line((620, 440, 1150, 440), fill="#829AB1", width=3)
    draw.line((620, 270, 620, 440), fill="#829AB1", width=3)
    bars = [(662, 354, 720, 440, "#4C78A8", "Q1"), (762, 316, 820, 440, "#59A14F", "Q2"),
            (862, 286, 920, 440, "#F28E2B", "Q3"), (962, 324, 1020, 440, "#E15759", "Q4")]
    for left, top, right, bottom, color, label in bars:
        draw.rectangle((left, top, right, bottom), fill=color)
        draw.text((left + 16, 452), label, font=font(16, True), fill="#243B53")
    overlay = Image.new("RGBA", (148, 106), (0, 0, 0, 0))
    ImageDraw.Draw(overlay).rectangle((0, 0, 147, 105), fill=(246, 200, 95, 82))
    image.alpha_composite(overlay, dest=(1002, 300))

    # Closed table grid and readable cell text.
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((64, 486, 510, 679), radius=18, fill="#FFFFFF", outline="#CAD5E2", width=2)
    x_edges = [82, 214, 350, 492]
    y_edges = [508, 538, 578, 618, 658]
    for x in x_edges:
        draw.line((x, 508, x, 658), fill="#9AA9B8", width=2)
    for y in y_edges:
        draw.line((82, y, 492, y), fill="#9AA9B8", width=2)
    draw.text((98, 513), "REGION", font=font(14, True), fill="#243B53")
    draw.text((230, 513), "SHARE", font=font(14, True), fill="#243B53")
    draw.text((367, 513), "DELTA", font=font(14, True), fill="#243B53")
    rows = [("North", "42%", "+8"), ("South", "31%", "+3"), ("West", "27%", "-2")]
    for row, (region, share, delta) in enumerate(rows):
        y = 548 + row * 40
        draw.text((98, y), region, font=font(14), fill="#486581")
        draw.text((230, y), share, font=font(14), fill="#486581")
        draw.text((367, y), delta, font=font(14), fill="#486581")

    # A deliberately overlaid badge proves z-order/occlusion relations.
    draw.rounded_rectangle((366, 364, 520, 420), radius=14, fill=(18, 38, 58, 230))
    draw.text((388, 378), "OVERLAP", font=font(16, True), fill="#FFFFFF")

    path.parent.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").save(path)
    ground_truth = benchmark_ground_truth()
    ground_truth_path.parent.mkdir(parents=True, exist_ok=True)
    ground_truth_path.write_text(json.dumps(ground_truth, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    manifest = {
        "version": BENCHMARK_VERSION,
        "kind": "image-to-pptx-object-benchmark",
        "id": BENCHMARK_ID,
        "fixture": {
            "image": path.relative_to(manifest_path.parent).as_posix(),
            "groundTruth": ground_truth_path.relative_to(manifest_path.parent).as_posix(),
            "size": {**BENCHMARK_SIZE, "unit": "px"},
        },
        "generator": "scripts/generate_examples.py",
        "deterministic": {"network": False, "model": None, "seed": 0},
        "evaluation": ground_truth["acceptance"],
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(output_root: Path = ROOT) -> None:
    minimal(output_root / "examples" / "minimal" / "input.png")
    complex_second(output_root / "examples" / "complex" / "slide-02-chart.png")
    fixture_dir = output_root / "tests" / "fixtures" / "object-level-benchmark"
    object_benchmark(
        fixture_dir / "reference.png",
        fixture_dir / "ground-truth.json",
        fixture_dir / "manifest.json",
    )
    print(output_root / "examples")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-root", type=Path, default=ROOT)
    main(parser.parse_args().output_root.resolve())
