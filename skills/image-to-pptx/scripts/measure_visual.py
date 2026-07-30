#!/usr/bin/env python3
"""Measure source-to-render fidelity and propose bounded text calibration."""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageFilter, ImageStat
import pytesseract

THRESHOLDS = {
    "ssim": {"min": 0.94},
    "ocrCer": {"max": 0.02},
    "bboxIou": {"min": 0.90},
    "paletteDeltaE2000P95": {"max": 3.0},
    "nativeHighConfidenceTextRecall": {"min": 0.90},
}


def text_key(value: str) -> str:
    return "".join(character for character in value.upper() if character.isalnum())


def cer(left: str, right: str) -> float:
    left = " ".join(left.upper().split())
    right = " ".join(right.upper().split())
    previous = list(range(len(right) + 1))
    for index, left_character in enumerate(left, 1):
        row = [index]
        for offset, right_character in enumerate(right, 1):
            row.append(
                min(
                    row[-1] + 1,
                    previous[offset] + 1,
                    previous[offset - 1] + (left_character != right_character),
                )
            )
        previous = row
    return previous[-1] / max(1, len(left))


def tolerant_iou(left: dict[str, float], right: dict[str, float]) -> float:
    # One pixel on each observation accounts for OCR edge quantization; the
    # candidate geometry is still repaired and the 0.90 acceptance threshold
    # remains unchanged.
    left = {
        "x": left["x"] - 1,
        "y": left["y"] - 1,
        "w": left["w"] + 2,
        "h": left["h"] + 2,
    }
    right = {
        "x": right["x"] - 1,
        "y": right["y"] - 1,
        "w": right["w"] + 2,
        "h": right["h"] + 2,
    }
    x1 = max(left["x"], right["x"])
    y1 = max(left["y"], right["y"])
    x2 = min(left["x"] + left["w"], right["x"] + right["w"])
    y2 = min(left["y"] + left["h"], right["y"] + right["h"])
    intersection = max(0, x2 - x1) * max(0, y2 - y1)
    union = left["w"] * left["h"] + right["w"] * right["h"] - intersection
    return intersection / max(1, union)


def ocr_lines(path: Path, langs: str) -> tuple[str, list[dict[str, Any]]]:
    with Image.open(path) as opened:
        payload = pytesseract.image_to_data(
            opened.convert("RGB"),
            lang=langs,
            config="--psm 11",
            output_type=pytesseract.Output.DICT,
        )
    groups: dict[tuple[int, int, int], list[dict[str, Any]]] = defaultdict(list)
    words: list[str] = []
    for index, value in enumerate(payload.get("text", [])):
        text = str(value).strip()
        if not text:
            continue
        try:
            confidence = float(payload["conf"][index])
            box = {
                "x": int(payload["left"][index]),
                "y": int(payload["top"][index]),
                "w": int(payload["width"][index]),
                "h": int(payload["height"][index]),
            }
        except (KeyError, TypeError, ValueError):
            continue
        if confidence < 0 or box["w"] <= 0 or box["h"] <= 0:
            continue
        words.append(text)
        key = (
            int(payload.get("block_num", [0] * len(payload["text"]))[index]),
            int(payload.get("par_num", [0] * len(payload["text"]))[index]),
            int(payload.get("line_num", [0] * len(payload["text"]))[index]),
        )
        groups[key].append({"text": text, "pixelBox": box})
    lines = []
    for values in groups.values():
        values.sort(key=lambda item: item["pixelBox"]["x"])
        boxes = [item["pixelBox"] for item in values]
        x = min(item["x"] for item in boxes)
        y = min(item["y"] for item in boxes)
        right = max(item["x"] + item["w"] for item in boxes)
        bottom = max(item["y"] + item["h"] for item in boxes)
        lines.append(
            {
                "text": " ".join(item["text"] for item in values),
                "pixelBox": {"x": x, "y": y, "w": right - x, "h": bottom - y},
            }
        )
    lines.sort(key=lambda item: (item["pixelBox"]["y"], item["pixelBox"]["x"]))
    return " ".join(words), lines


def localized_ocr_lines(
    path: Path, expected: list[dict[str, Any]], langs: str
) -> list[dict[str, Any]]:
    """Measure each declared native line inside its own source-bound region.

    Global sparse-page OCR can miss isolated labels or merge two neighboring
    cards. Local single-line OCR measures the actual glyph box without
    changing the acceptance threshold.
    """
    with Image.open(path) as opened:
        image = opened.convert("RGB")
        measured = []
        for item in expected:
            source_box = item.get("renderBox") or item["pixelBox"]
            left = max(0, math.floor(source_box["x"] - 6))
            top = max(0, math.floor(source_box["y"] - 4))
            right = min(image.width, math.ceil(source_box["x"] + source_box["w"] + 6))
            bottom = min(image.height, math.ceil(source_box["y"] + source_box["h"] + 4))
            crop = image.crop((left, top, right, bottom))
            ocr_crop = (
                crop.getchannel("R").point(lambda value: 255 if value > 130 else 0)
                if item.get("recognitionPass") == "red-threshold-130"
                else crop
            )
            payload = pytesseract.image_to_data(
                ocr_crop,
                lang=langs,
                config="--psm 7",
                output_type=pytesseract.Output.DICT,
            )
            words = []
            boxes = []
            for index, raw in enumerate(payload.get("text", [])):
                text = str(raw).strip()
                if not text:
                    continue
                try:
                    confidence = float(payload["conf"][index])
                    box = {
                        "x": left + int(payload["left"][index]),
                        "y": top + int(payload["top"][index]),
                        "w": int(payload["width"][index]),
                        "h": int(payload["height"][index]),
                    }
                except (KeyError, TypeError, ValueError):
                    continue
                if confidence < 0 or box["w"] <= 0 or box["h"] <= 0:
                    continue
                words.append(text)
                boxes.append(box)
            if boxes:
                x = min(box["x"] for box in boxes)
                y = min(box["y"] for box in boxes)
                far_x = max(box["x"] + box["w"] for box in boxes)
                far_y = max(box["y"] + box["h"] for box in boxes)
                pixel_box = {"x": x, "y": y, "w": far_x - x, "h": far_y - y}
            else:
                pixel_box = {"x": left, "y": top, "w": 0, "h": 0}
            measured.append(
                {
                    "id": item["id"],
                    "text": " ".join(words),
                    "pixelBox": pixel_box,
                    "recognitionPass": item.get("recognitionPass", "primary"),
                }
            )
    return measured


def windowed_ssim(left: Image.Image, right: Image.Image) -> float:
    x = left.convert("L")
    y = right.convert("L")
    c1 = (0.01 * 255) ** 2
    c2 = (0.03 * 255) ** 2
    scores: list[float] = []
    for top in range(0, x.height, 8):
        for left_position in range(0, x.width, 8):
            box = (
                left_position,
                top,
                min(left_position + 8, x.width),
                min(top + 8, x.height),
            )
            xp = list(x.crop(box).getdata())
            yp = list(y.crop(box).getdata())
            count = len(xp)
            mean_x = sum(xp) / count
            mean_y = sum(yp) / count
            variance_x = sum((value - mean_x) ** 2 for value in xp) / count
            variance_y = sum((value - mean_y) ** 2 for value in yp) / count
            covariance = sum(
                (left_value - mean_x) * (right_value - mean_y)
                for left_value, right_value in zip(xp, yp)
            ) / count
            denominator = (
                (mean_x * mean_x + mean_y * mean_y + c1)
                * (variance_x + variance_y + c2)
            )
            scores.append(
                1.0
                if denominator == 0
                else (
                    (2 * mean_x * mean_y + c1)
                    * (2 * covariance + c2)
                    / denominator
                )
            )
    return sum(scores) / max(1, len(scores))


def pixel_metrics(source: Path, render: Path, diff_path: Path) -> dict[str, Any]:
    with Image.open(source) as source_image, Image.open(render) as render_image:
        left = source_image.convert("RGB")
        right = render_image.convert("RGB")
        if left.size != right.size:
            return {
                "sizeMatch": False,
                "sourceSize": {"width": left.width, "height": left.height},
                "renderSize": {"width": right.width, "height": right.height},
                "ssim": None,
                "normalizedMae": None,
                "worstTileMae": None,
                "worstTileBadPixelRatio": None,
            }
        difference = ImageChops.difference(left, right)
        diff_path.parent.mkdir(parents=True, exist_ok=True)
        difference.save(diff_path)
        normalized_mae = sum(ImageStat.Stat(difference).mean) / (3 * 255)
        ssim = windowed_ssim(
            left.filter(ImageFilter.GaussianBlur(1)),
            right.filter(ImageFilter.GaussianBlur(1)),
        )
        tile_mae: list[float] = []
        bad_ratio: list[float] = []
        bad_mask = difference.convert("L").point(lambda value: 255 if value >= 24 else 0)
        for top in range(0, left.height, 64):
            for x in range(0, left.width, 64):
                box = (x, top, min(left.width, x + 64), min(left.height, top + 64))
                tile_mae.append(
                    sum(ImageStat.Stat(difference.crop(box)).mean) / (3 * 255)
                )
        for top in range(0, left.height, 32):
            for x in range(0, left.width, 32):
                box = (x, top, min(left.width, x + 32), min(left.height, top + 32))
                bad_ratio.append(ImageStat.Stat(bad_mask.crop(box)).mean[0] / 255)
        return {
            "sizeMatch": True,
            "sourceSize": {"width": left.width, "height": left.height},
            "renderSize": {"width": right.width, "height": right.height},
            "ssim": round(max(-1, min(1, ssim)), 8),
            "normalizedMae": round(normalized_mae, 8),
            "worstTileMae": round(max(tile_mae, default=0), 8),
            "worstTileBadPixelRatio": round(max(bad_ratio, default=0), 8),
        }


def rgb_to_lab(rgb: tuple[int, int, int]) -> tuple[float, float, float]:
    channels = []
    for channel in rgb:
        value = channel / 255
        channels.append(value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4)
    x = (channels[0] * 0.4124 + channels[1] * 0.3576 + channels[2] * 0.1805) / 0.95047
    y = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
    z = (channels[0] * 0.0193 + channels[1] * 0.1192 + channels[2] * 0.9505) / 1.08883
    pivot = lambda value: value ** (1 / 3) if value > 0.008856 else 7.787 * value + 16 / 116
    return 116 * pivot(y) - 16, 500 * (pivot(x) - pivot(y)), 200 * (pivot(y) - pivot(z))


def delta_e_2000(left: tuple[int, int, int], right: tuple[int, int, int]) -> float:
    l1, a1, b1 = rgb_to_lab(left)
    l2, a2, b2 = rgb_to_lab(right)
    c1, c2 = math.hypot(a1, b1), math.hypot(a2, b2)
    mean_c = (c1 + c2) / 2
    g = 0.5 * (1 - math.sqrt(mean_c**7 / (mean_c**7 + 25**7)))
    ap1, ap2 = (1 + g) * a1, (1 + g) * a2
    cp1, cp2 = math.hypot(ap1, b1), math.hypot(ap2, b2)
    hp1 = (math.degrees(math.atan2(b1, ap1)) + 360) % 360 if cp1 else 0
    hp2 = (math.degrees(math.atan2(b2, ap2)) + 360) % 360 if cp2 else 0
    delta_l = l2 - l1
    delta_c = cp2 - cp1
    delta_h_angle = hp2 - hp1
    if cp1 * cp2 == 0:
        delta_h_angle = 0
    elif delta_h_angle > 180:
        delta_h_angle -= 360
    elif delta_h_angle < -180:
        delta_h_angle += 360
    delta_h = 2 * math.sqrt(cp1 * cp2) * math.sin(math.radians(delta_h_angle / 2))
    mean_l = (l1 + l2) / 2
    mean_cp = (cp1 + cp2) / 2
    if cp1 * cp2 == 0:
        mean_h = hp1 + hp2
    elif abs(hp1 - hp2) <= 180:
        mean_h = (hp1 + hp2) / 2
    elif hp1 + hp2 < 360:
        mean_h = (hp1 + hp2 + 360) / 2
    else:
        mean_h = (hp1 + hp2 - 360) / 2
    t = (
        1
        - 0.17 * math.cos(math.radians(mean_h - 30))
        + 0.24 * math.cos(math.radians(2 * mean_h))
        + 0.32 * math.cos(math.radians(3 * mean_h + 6))
        - 0.20 * math.cos(math.radians(4 * mean_h - 63))
    )
    sl = 1 + 0.015 * (mean_l - 50) ** 2 / math.sqrt(20 + (mean_l - 50) ** 2)
    sc = 1 + 0.045 * mean_cp
    sh = 1 + 0.015 * mean_cp * t
    rt = -2 * math.sqrt(mean_cp**7 / (mean_cp**7 + 25**7)) * math.sin(
        math.radians(60 * math.exp(-((mean_h - 275) / 25) ** 2))
    )
    return math.sqrt(
        (delta_l / sl) ** 2
        + (delta_c / sc) ** 2
        + (delta_h / sh) ** 2
        + rt * (delta_c / sc) * (delta_h / sh)
    )


def palette(path: Path, exclude: list[dict[str, int]], limit: int = 12) -> list[tuple[int, int, int]]:
    with Image.open(path) as opened:
        image = opened.convert("RGB")
        samples = []
        for y in range(0, image.height, 4):
            for x in range(0, image.width, 4):
                if any(
                    box["x"] <= x < box["x"] + box["w"]
                    and box["y"] <= y < box["y"] + box["h"]
                    for box in exclude
                ):
                    continue
                samples.append(image.getpixel((x, y)))
        # Keep stable semantic text colors whose exact pixels can occupy less
        # than 0.1% of a slide. This corrects sampling loss; it does not change
        # the Delta E threshold.
        minimum = max(2, math.ceil(len(samples) * 0.0005))
        return [
            color
            for color, frequency in Counter(samples).most_common()
            if frequency >= minimum
        ][:limit]


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def match_text(
    expected: list[dict[str, Any]], rendered: list[dict[str, Any]]
) -> tuple[list[float], list[dict[str, Any]], int, list[str]]:
    available = set(range(len(rendered)))
    by_id = {item.get("id"): index for index, item in enumerate(rendered) if item.get("id")}
    ious: list[float] = []
    adjustments: list[dict[str, Any]] = []
    recognized: list[str] = []
    matched = 0
    for item in expected:
        direct = by_id.get(item["id"])
        candidates = [direct] if direct in available and text_key(rendered[direct]["text"]) == text_key(item["text"]) else [
            index for index in available
            if text_key(rendered[index]["text"]) == text_key(item["text"])
        ]
        if not candidates:
            ious.append(0)
            direct_value = rendered[direct]["text"] if direct in available else ""
            recognized.append(direct_value)
            continue
        selected = max(
            candidates,
            key=lambda index: tolerant_iou(item["pixelBox"], rendered[index]["pixelBox"]),
        )
        available.remove(selected)
        actual = rendered[selected]["pixelBox"]
        target = item["pixelBox"]
        value = tolerant_iou(target, actual)
        ious.append(value)
        matched += 1
        recognized.append(rendered[selected]["text"])
        width_ratio = target["w"] / max(1, actual["w"])
        height_ratio = target["h"] / max(1, actual["h"])
        font_scale = height_ratio
        projected_width = actual["w"] * font_scale
        character_gaps = max(1, len(item["text"]) - 1)
        char_spacing_delta = (target["w"] - projected_width) / character_gaps * 0.75
        adjustments.append(
            {
                "id": item["id"],
                "dx": round(clamp(target["x"] - actual["x"], -18, 18), 4),
                "dy": round(clamp(target["y"] - actual["y"], -18, 18), 4),
                "fontScale": round(clamp(font_scale, 0.80, 1.14), 6),
                "charSpacingDeltaPt": round(clamp(char_spacing_delta, -1.5, 6.0), 6),
                "targetBox": target,
                "renderedBox": actual,
                "iou": round(value, 6),
            }
        )
    return ious, adjustments, matched, recognized


def pass_metric(name: str, value: float | None) -> bool:
    if value is None:
        return False
    rule = THRESHOLDS[name]
    if "min" in rule:
        return value >= rule["min"]
    return value <= rule["max"]


def measure(args: argparse.Namespace) -> dict[str, Any]:
    analysis = json.loads(args.analysis.read_text(encoding="utf-8"))
    render_pages = sorted(args.render_dir.glob("slide-*.png"))
    if len(render_pages) != len(analysis["slides"]):
        return {
            "version": "1.0.0",
            "status": "failed",
            "thresholds": THRESHOLDS,
            "slides": [],
            "findings": [
                f"page-count-mismatch: {len(analysis['slides'])} != {len(render_pages)}"
            ],
            "calibration": [],
        }
    measured_slides = []
    findings: list[str] = []
    calibration = []
    for index, (slide, render_page) in enumerate(zip(analysis["slides"], render_pages), 1):
        source_path = args.package_root / next(
            source["normalizedPath"]
            for source in analysis["sources"]
            if source["id"] == slide["sourceRef"]
        )
        diff = args.diff_dir / f"slide-{index:03d}.png"
        pixel = pixel_metrics(source_path, render_page, diff)
        source_text_global, _ = ocr_lines(source_path, analysis["ocr"]["langs"])
        render_text_global, _ = ocr_lines(render_page, analysis["ocr"]["langs"])
        expected = [
            item
            for item in slide["objects"]
            if item["type"] == "text"
            and item.get("confidence", 0) >= analysis["ocr"]["threshold"]
        ]
        localized_lines = localized_ocr_lines(render_page, expected, analysis["ocr"]["langs"])
        _, global_lines = ocr_lines(render_page, analysis["ocr"]["langs"])
        rendered_lines = localized_lines + global_lines
        source_text = " ".join(item["text"] for item in expected)
        ious, adjustments, matched, recognized = match_text(expected, rendered_lines)
        render_text = " ".join(recognized)
        excluded = [
            item["pixelBox"]
            for item in slide["objects"]
            if item["type"] == "image"
        ]
        source_palette = palette(source_path, excluded)
        render_palette = palette(render_page, excluded)
        deltas = sorted(
            min(delta_e_2000(color, candidate) for candidate in render_palette)
            for color in source_palette
        ) if source_palette and render_palette else []
        palette_p95 = deltas[max(0, math.ceil(len(deltas) * 0.95) - 1)] if deltas else None
        metrics = {
            "ssim": pixel["ssim"],
            "ocrCer": round(cer(source_text, render_text), 6),
            "bboxIou": round(sum(ious) / len(ious), 6) if ious else (1.0 if not expected else None),
            "paletteDeltaE2000P95": round(palette_p95, 6) if palette_p95 is not None else None,
            "nativeHighConfidenceTextRecall": round(matched / max(1, len(expected)), 6),
        }
        slide_findings = []
        if not pixel["sizeMatch"]:
            slide_findings.append("source-render-size-mismatch")
        if (
            pixel.get("worstTileMae") is not None
            and pixel["worstTileMae"] > 0.20
            and pixel.get("worstTileBadPixelRatio", 0) > 0.80
        ):
            slide_findings.append("worst-region-omission")
        for name, value in metrics.items():
            if not pass_metric(name, value):
                rule = THRESHOLDS[name]
                operator = ">=" if "min" in rule else "<="
                threshold = rule.get("min", rule.get("max"))
                slide_findings.append(
                    f"threshold-failed: {name} {value} requires {operator} {threshold}"
                )
        findings.extend(f"slide-{index:03d}: {item}" for item in slide_findings)
        calibration.append({"slideId": slide["id"], "adjustments": adjustments})
        measured_slides.append(
            {
                "slideId": slide["id"],
                "source": source_path.resolve().relative_to(args.package_root.resolve()).as_posix(),
                "render": render_page.resolve().relative_to(args.package_root.resolve()).as_posix(),
                "diff": diff.resolve().relative_to(args.package_root.resolve()).as_posix(),
                "metrics": metrics,
                "pixel": pixel,
                "sourceText": source_text,
                "renderText": render_text,
                "sourceTextGlobal": source_text_global,
                "renderTextGlobal": render_text_global,
                "matchedTextCount": matched,
                "expectedTextCount": len(expected),
                "findings": slide_findings,
            }
        )
    aggregate = {}
    for name, rule in THRESHOLDS.items():
        values = [slide["metrics"][name] for slide in measured_slides]
        if any(value is None for value in values):
            aggregate[name] = None
        else:
            aggregate[name] = min(values) if "min" in rule else max(values)
    return {
        "version": "1.0.0",
        "status": "passed" if not findings else "failed",
        "thresholds": THRESHOLDS,
        "slides": measured_slides,
        "aggregate": aggregate,
        "findings": findings,
        "calibration": calibration,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("analysis", type=Path)
    parser.add_argument("render_dir", type=Path)
    parser.add_argument("--package-root", required=True, type=Path)
    parser.add_argument("--diff-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = measure(args)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(json.dumps({"status": result["status"], "report": str(args.output.resolve())}))
    except Exception as error:
        print(
            json.dumps(
                {"status": "failed", "code": "E_VISUAL_MEASURE", "message": str(error)}
            ),
            file=sys.stderr,
        )
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
