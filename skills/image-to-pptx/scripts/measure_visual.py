#!/usr/bin/env python3
"""Measure source-to-render fidelity and propose bounded text calibration."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageStat
import pytesseract

THRESHOLDS = {
    "ssim": {"min": 0.94},
    "ocrCer": {"max": 0.02},
    "bboxIou": {"min": 0.90},
    "paletteDeltaE2000P95": {"max": 3.0},
    "nativeHighConfidenceTextRecall": {"min": 0.90},
}

SSIM_METRIC = "pptx-creator-ssim"
SSIM_VERSION = "2.0"
SSIM_CONFIG = {
    "implementation": "skimage.structural_similarity",
    "dataRange": 255,
    "gaussianWeights": True,
    "sigma": 1.5,
    "useSampleCovariance": False,
    "channelAxis": 2,
}

REGION_CATEGORIES = ("text", "shape", "image", "background", "z-order")

# Region QA is deliberately separate from the reconstruction planner's loss
# estimates.  These limits are part of the repair contract: a round may only
# inspect the five largest measured contributors, with a smaller page allowed
# when it has fewer than five regions.
MAX_ERROR_REGIONS = 5
MAX_REPAIR_CANDIDATES_PER_REGION = 4
SEVERITY_WEIGHTS = {
    "title": 1.40,
    "text-block": 1.30,
    "footer": 0.90,
    "chart": 1.20,
    "table": 1.20,
    "card-or-native-group": 1.10,
    "image": 1.00,
    "background": 0.80,
    "decor": 0.70,
}


def text_key(value: str) -> str:
    return "".join(character for character in value.upper() if character.isalnum())


def normalize_ocr_text(value: str) -> str:
    """Return a stable OCR string without making the reference self-derived.

    The reference and hypothesis are captured independently from the source and
    rendered images.  In particular, this function must not select text from
    the reconstruction analysis as a proxy for the rendered OCR result.
    """
    return " ".join(str(value or "").upper().split())


def cer(left: str, right: str) -> float:
    """Character error rate with both deletions and insertions charged.

    ``max(1, len(reference))`` is intentional: an empty reference with any
    recognized hypothesis is a full error rather than a free pass.  This also
    keeps inserted/missing characters visible to the gate when one OCR side is
    empty.
    """
    left = normalize_ocr_text(left)
    right = normalize_ocr_text(right)
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
    if not left:
        return 0.0 if not right else 1.0
    return previous[-1] / len(left)


def region_category(item: dict[str, Any]) -> str:
    object_type = str(item.get("type", "")).lower()
    if object_type == "text":
        return "text"
    if object_type in {"shape", "connector", "table"}:
        return "shape"
    if object_type == "image":
        return "image"
    return "shape"


def _safe_box(box: dict[str, Any], width: int, height: int) -> tuple[int, int, int, int] | None:
    left = max(0, min(width, math.floor(float(box.get("x", 0)))))
    top = max(0, min(height, math.floor(float(box.get("y", 0)))))
    right = max(left, min(width, math.ceil(float(box.get("x", 0) + box.get("w", 0)))))
    bottom = max(top, min(height, math.ceil(float(box.get("y", 0) + box.get("h", 0)))))
    if right <= left or bottom <= top:
        return None
    return left, top, right, bottom


def _rgb_distance(left: tuple[int, int, int], right: tuple[int, int, int]) -> float:
    return math.sqrt(sum((left[index] - right[index]) ** 2 for index in range(3)))


def _edge_colors(image: Image.Image, box: tuple[int, int, int, int]) -> list[tuple[int, int, int]]:
    left, top, right, bottom = box
    samples: list[tuple[int, int, int]] = []
    for y in range(max(0, top - 2), min(image.height, bottom + 2)):
        for x in range(max(0, left - 2), min(image.width, right + 2)):
            if left <= x < right and top <= y < bottom:
                continue
            samples.append(image.getpixel((x, y)))
    return [color for color, _ in Counter(samples).most_common(4)]


def _dominant_edge_color(image: Image.Image) -> tuple[int, int, int]:
    samples = []
    for x in range(0, image.width, max(1, image.width // 320)):
        samples.extend((image.getpixel((x, 0)), image.getpixel((x, image.height - 1))))
    for y in range(0, image.height, max(1, image.height // 180)):
        samples.extend((image.getpixel((0, y)), image.getpixel((image.width - 1, y))))
    return Counter(samples).most_common(1)[0][0]


def _hex_color(color: tuple[int, int, int]) -> str:
    return "#" + "".join(f"{value:02X}" for value in color)


def measured_region_box(
    source_image: Image.Image,
    render_image: Image.Image,
    box: dict[str, Any],
) -> tuple[dict[str, int] | None, dict[str, Any]]:
    """Locate a declared non-text region in the rendered page from source colors.

    The search is deliberately local and bounded. A weak or ambiguous color
    signature returns ``unavailable`` instead of fabricating a rendered box.
    """
    if source_image.size != render_image.size:
        return None, {"status": "unavailable", "method": "source-color-localization", "reason": "size-mismatch"}
    safe = _safe_box(box, source_image.width, source_image.height)
    if safe is None:
        return None, {"status": "unavailable", "method": "source-color-localization", "reason": "invalid-box"}
    left, top, right, bottom = safe
    crop = source_image.crop(safe)
    area = max(1, crop.width * crop.height)
    outside = _edge_colors(source_image, safe)
    minimum_frequency = max(2, math.ceil(area * 0.001))
    signature = [
        color
        for color, frequency in Counter(crop.getdata()).most_common(16)
        if frequency >= minimum_frequency
        and (not outside or min(_rgb_distance(color, candidate) for candidate in outside) >= 14)
    ][:8]
    if not signature:
        return None, {"status": "unavailable", "method": "source-color-localization", "reason": "no-distinct-source-colors"}

    padding = max(6, min(24, round(max(right - left, bottom - top) * 0.08)))
    search_box = (
        max(0, left - padding),
        max(0, top - padding),
        min(render_image.width, right + padding),
        min(render_image.height, bottom + padding),
    )
    search = render_image.crop(search_box)
    mask = Image.new("1", search.size, 0)
    matches = [
        1 if min(_rgb_distance(pixel, candidate) for candidate in signature) <= 14 else 0
        for pixel in search.getdata()
    ]
    mask.putdata(matches)
    localized = mask.getbbox()
    matched_pixels = sum(matches)
    if localized is None or matched_pixels / area < 0.005:
        return None, {"status": "unavailable", "method": "source-color-localization", "reason": "insufficient-render-evidence"}
    measured = {
        "x": search_box[0] + localized[0],
        "y": search_box[1] + localized[1],
        "w": localized[2] - localized[0],
        "h": localized[3] - localized[1],
    }
    width_ratio = measured["w"] / max(1, right - left)
    height_ratio = measured["h"] / max(1, bottom - top)
    if not (0.35 <= width_ratio <= 1.65 and 0.35 <= height_ratio <= 1.65):
        return None, {"status": "unavailable", "method": "source-color-localization", "reason": "ambiguous-bounds"}
    return measured, {
        "status": "measured",
        "method": "source-color-localization",
        "signatureColors": [_hex_color(color) for color in signature],
        "matchedPixelRatio": round(matched_pixels / area, 6),
        "searchPaddingPx": padding,
    }


def ssim_metadata() -> dict[str, Any]:
    """Return the versioned public SSIM contract used by every hard gate."""
    return {
        "metric": SSIM_METRIC,
        "version": SSIM_VERSION,
        "configuration": dict(SSIM_CONFIG),
    }


def ssim_v2(left: Image.Image, right: Image.Image) -> float:
    """Measure RGB SSIM with the single versioned pptx-creator configuration."""
    if left.size != right.size:
        raise ValueError("SSIM inputs must have identical dimensions")
    import numpy as np
    from skimage.metrics import structural_similarity

    left_array = np.asarray(left.convert("RGB"), dtype=np.uint8)
    right_array = np.asarray(right.convert("RGB"), dtype=np.uint8)
    # gaussian_weights=True uses an eleven-pixel support window by default.
    # Tiny diagnostic crops are reported as unavailable by the caller rather
    # than changing the public configuration with a different window size.
    if min(left_array.shape[:2]) < 11:
        raise ValueError("SSIM input is smaller than the configured support window")
    return float(
        structural_similarity(
            left_array,
            right_array,
            data_range=255,
            gaussian_weights=True,
            sigma=1.5,
            use_sample_covariance=False,
            channel_axis=2,
        )
    )


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
            recognized_words = []
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
                recognized_words.append({"text": text, "pixelBox": box})
            expected_word_count = max(1, len(str(item.get("text", "")).split()))
            selected_words = recognized_words
            if recognized_words:
                best: tuple[float, int, int] | None = None
                minimum_length = max(1, expected_word_count - 1)
                maximum_length = min(len(recognized_words), expected_word_count + 2)
                for length in range(minimum_length, maximum_length + 1):
                    for start in range(0, len(recognized_words) - length + 1):
                        candidate = " ".join(
                            word["text"]
                            for word in recognized_words[start : start + length]
                        )
                        score = cer(text_key(item.get("text", "")), text_key(candidate))
                        score += abs(length - expected_word_count) * 0.02
                        choice = (score, start, length)
                        if best is None or choice < best:
                            best = choice
                if best is not None:
                    _, start, length = best
                    selected_words = recognized_words[start : start + length]
            words = [word["text"] for word in selected_words]
            boxes = [word["pixelBox"] for word in selected_words]
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
                    "rawText": " ".join(word["text"] for word in recognized_words),
                    "pixelBox": pixel_box,
                    "recognitionPass": item.get("recognitionPass", "primary"),
                }
            )
    return measured


def merge_ocr_evidence(global_text: str, localized: list[dict[str, Any]]) -> str:
    """Merge independent global and region OCR without double-counting lines.

    Sparse global OCR can miss small labels, while region OCR cannot see text
    outside declared native boxes. Taking the maximum observed multiplicity of
    each token keeps both evidence sources: missing or extra global text still
    contributes to CER, and small labels recovered locally are not treated as
    absent merely because page-level OCR skipped them.
    """

    global_tokens = str(global_text).split()
    localized_tokens = " ".join(
        str(item.get("text", "")) for item in localized
    ).split()
    counts = Counter(global_tokens)
    localized_seen: Counter[str] = Counter()
    merged = list(global_tokens)
    for token in localized_tokens:
        localized_seen[token] += 1
        if localized_seen[token] > counts[token]:
            merged.append(token)
    return " ".join(merged)


def ocr_evidence_cer(
    source_global: str,
    render_global: str,
    source_localized: list[dict[str, Any]],
    render_localized: list[dict[str, Any]],
) -> float:
    """Score missing/extra OCR evidence without page-level reading-order noise."""

    def evidence_counter(global_text: str, localized: list[dict[str, Any]]) -> Counter[str]:
        global_counts = Counter(
            token for token in (text_key(value) for value in global_text.split()) if token
        )
        localized_counts = Counter(
            token
            for item in localized
            for token in (text_key(value) for value in str(item.get("text", "")).split())
            if token
        )
        return Counter(
            {
                token: max(global_counts[token], localized_counts[token])
                for token in set(global_counts) | set(localized_counts)
            }
        )

    def weight(token: str) -> float:
        # One- and two-character chart labels are intrinsically noisy under
        # sparse OCR (Q1/I/1). They remain charged, but do not outweigh a whole
        # missing word or sentence.
        return len(token) * (0.25 if len(token) <= 2 else 1.0)

    source = evidence_counter(source_global, source_localized)
    render = evidence_counter(render_global, render_localized)
    numerator = sum(
        abs(source[token] - render[token]) * weight(token)
        for token in set(source) | set(render)
    )
    denominator = max(
        1.0,
        sum(count * weight(token) for token, count in source.items()),
        sum(count * weight(token) for token, count in render.items()),
    )
    return min(1.0, numerator / denominator)


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
                "ssimStatus": {"status": "unavailable", "reason": "size-mismatch"},
                "ssimMetric": ssim_metadata(),
                "normalizedMae": None,
                "worstTileMae": None,
                "worstTileBadPixelRatio": None,
            }
        difference = ImageChops.difference(left, right)
        diff_path.parent.mkdir(parents=True, exist_ok=True)
        difference.save(diff_path)
        normalized_mae = sum(ImageStat.Stat(difference).mean) / (3 * 255)
        try:
            ssim = ssim_v2(left, right)
            ssim_status = {"status": "available"}
        except Exception as error:
            ssim = None
            ssim_status = {"status": "unavailable", "reason": str(error)}
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
        result = {
            "sizeMatch": True,
            "sourceSize": {"width": left.width, "height": left.height},
            "renderSize": {"width": right.width, "height": right.height},
            "ssim": round(max(-1, min(1, ssim)), 8) if ssim is not None else None,
            "ssimStatus": ssim_status,
            "ssimMetric": ssim_metadata(),
            "normalizedMae": round(normalized_mae, 8),
            "worstTileMae": round(max(tile_mae, default=0), 8),
            "worstTileBadPixelRatio": round(max(bad_ratio, default=0), 8),
        }
        return result


def region_pixel_metrics(source: Path, render: Path, box: dict[str, Any]) -> dict[str, Any]:
    """Compare one source-bound region without adding a new hard gate."""
    with Image.open(source) as source_image, Image.open(render) as render_image:
        left = source_image.convert("RGB")
        right = render_image.convert("RGB")
        if left.size != right.size:
            return {
                "sizeMatch": False,
                "ssim": None,
                "ssimStatus": {"status": "unavailable", "reason": "size-mismatch"},
                "ssimMetric": ssim_metadata(),
                "normalizedMae": None,
                "pixelCount": 0,
            }
        safe = _safe_box(box, left.width, left.height)
        if safe is None:
            return {
                "sizeMatch": True,
                "ssim": None,
                "ssimStatus": {"status": "unavailable", "reason": "invalid-box"},
                "ssimMetric": ssim_metadata(),
                "normalizedMae": None,
                "pixelCount": 0,
            }
        source_crop = left.crop(safe)
        render_crop = right.crop(safe)
        difference = ImageChops.difference(source_crop, render_crop)
        normalized_mae = sum(ImageStat.Stat(difference).mean) / (3 * 255)
        try:
            ssim = ssim_v2(source_crop, render_crop)
            ssim_status = {"status": "available"}
        except Exception as error:
            ssim = None
            ssim_status = {"status": "unavailable", "reason": str(error)}
        result = {
            "sizeMatch": True,
            "ssim": round(max(-1, min(1, ssim)), 8) if ssim is not None else None,
            "ssimStatus": ssim_status,
            "ssimMetric": ssim_metadata(),
            "normalizedMae": round(normalized_mae, 8),
            "pixelCount": source_crop.width * source_crop.height,
        }
        return result


def _metric_unavailable(reason: str, method: str = "source-render-crop") -> dict[str, Any]:
    """Return explicit unavailable evidence for a regional metric.

    A missing visual dependency, a tiny crop, or an unobservable object is not
    a planner estimate.  Keeping the reason next to the status prevents the
    repair loop from treating an absent measurement as a zero error.
    """

    return {"status": "unavailable", "method": method, "reason": str(reason)}


def _region_severity(profile: dict[str, Any]) -> float:
    raw = profile.get("severityWeight")
    try:
        value = float(raw)
    except (TypeError, ValueError):
        value = SEVERITY_WEIGHTS.get(str(profile.get("role", "decor")), 1.0)
    return round(clamp(value, 0.1, 4.0), 6)


def _crop_text(path: Path, box: dict[str, Any], langs: str) -> tuple[str, dict[str, Any]]:
    """Run independent OCR on exactly one source/render crop."""

    try:
        with Image.open(path) as opened:
            image = opened.convert("RGB")
            safe = _safe_box(box, image.width, image.height)
            if safe is None:
                return "", _metric_unavailable("invalid-box", "regional-ocr")
            crop = image.crop(safe)
            if crop.width < 2 or crop.height < 2:
                return "", _metric_unavailable("empty-crop", "regional-ocr")
            text = pytesseract.image_to_string(
                crop,
                lang=langs,
                config="--psm 6",
            )
            return normalize_ocr_text(text), {"status": "measured", "method": "regional-ocr-psm-6"}
    except Exception as error:
        return "", _metric_unavailable(str(error), "regional-ocr")


def _region_palette(path: Path, box: dict[str, Any]) -> tuple[list[tuple[int, int, int]], dict[str, Any]]:
    """Collect a bounded dominant palette from a real crop."""

    try:
        with Image.open(path) as opened:
            image = opened.convert("RGB")
            safe = _safe_box(box, image.width, image.height)
            if safe is None:
                return [], _metric_unavailable("invalid-box", "regional-palette")
            crop = image.crop(safe)
            if crop.width < 1 or crop.height < 1:
                return [], _metric_unavailable("empty-crop", "regional-palette")
            # Keep runtime bounded while retaining stable semantic colours.
            area = max(1, crop.width * crop.height)
            stride = max(1, math.ceil(math.sqrt(area / 4096)))
            samples = [crop.getpixel((x, y)) for y in range(0, crop.height, stride) for x in range(0, crop.width, stride)]
            if not samples:
                return [], _metric_unavailable("no-pixels", "regional-palette")
            minimum = max(1, math.ceil(len(samples) * 0.002))
            colors = [
                color
                for color, frequency in Counter(samples).most_common(8)
                if frequency >= minimum
            ]
            if not colors:
                return [], _metric_unavailable("no-dominant-colors", "regional-palette")
            return colors, {"status": "measured", "method": "regional-dominant-palette", "sampleStride": stride}
    except Exception as error:
        return [], _metric_unavailable(str(error), "regional-palette")


def _regional_palette_delta(source: Path, render: Path, box: dict[str, Any]) -> tuple[float | None, dict[str, Any], dict[str, Any]]:
    source_palette, source_status = _region_palette(source, box)
    render_palette, render_status = _region_palette(render, box)
    if not source_palette:
        return None, {"status": "unavailable", "reason": source_status.get("reason", "source-palette-unavailable")}, {"status": "unavailable", "reason": source_status.get("reason", "source-palette-unavailable")}
    if not render_palette:
        return None, {"status": "unavailable", "reason": render_status.get("reason", "render-palette-unavailable")}, {"status": "unavailable", "reason": render_status.get("reason", "render-palette-unavailable")}
    deltas = [min(delta_e_2000(color, candidate) for candidate in render_palette) for color in source_palette]
    ordered_deltas = sorted(deltas)
    p95 = ordered_deltas[max(0, math.ceil(len(ordered_deltas) * 0.95) - 1)] if ordered_deltas else None
    return (
        round(p95, 6) if p95 is not None else None,
        {"status": "measured", "method": "regional-delta-e-2000-p95", "sourceColors": [_hex_color(color) for color in source_palette], "renderColors": [_hex_color(color) for color in render_palette]},
        {"status": "measured", "method": "regional-delta-e-2000-p95"},
    )


def _region_bbox_iou(
    profile: dict[str, Any],
    slide_objects: list[dict[str, Any]],
    object_reports: list[dict[str, Any]],
) -> tuple[float | None, dict[str, Any]]:
    """Aggregate measured object boxes belonging to one RegionProfile."""

    object_by_id = {str(item.get("id")): item for item in slide_objects}
    report_by_id = {str(item.get("id")): item for item in object_reports if item.get("id")}
    values: list[float] = []
    missing: list[str] = []
    for ref in profile.get("objectRefs", []):
        key = str(ref)
        source = object_by_id.get(key)
        measured = report_by_id.get(key)
        if not source or not measured or not measured.get("renderedBox"):
            missing.append(key)
            continue
        source_box = source.get("pixelBox") or source.get("renderBox")
        render_box = measured.get("renderedBox")
        if not source_box or not render_box:
            missing.append(key)
            continue
        values.append(tolerant_iou(source_box, render_box))
    if missing:
        return None, {
            "status": "unavailable",
            "reason": "missing-member-boxes",
            "metric": "regional-object-bbox",
            "missingMembers": sorted(missing),
            "measuredCount": len(values),
            "memberCount": len(profile.get("objectRefs", [])),
        }
    if not values:
        return None, _metric_unavailable("no-measured-member-boxes", "regional-object-bbox")
    status = {"status": "measured", "method": "regional-member-object-bbox", "measuredCount": len(values), "memberCount": len(profile.get("objectRefs", []))}
    if missing:
        status["unavailableMembers"] = sorted(missing)
    return round(sum(values) / len(values), 6), status


def measure_region_profile(
    source_path: Path,
    render_path: Path,
    profile: dict[str, Any],
    slide: dict[str, Any],
    object_reports: list[dict[str, Any]],
    langs: str,
) -> dict[str, Any]:
    """Measure one RegionProfile from independent source/render crops.

    The returned fields intentionally carry no ``estimatedFrom=analysis``
    marker.  Planner candidates remain estimates; this record is the measured
    QA evidence used to rank bounded repair work.
    """

    box = profile.get("pixelBox") or profile.get("box") or {}
    width = int(slide.get("sizePx", {}).get("widthPx", slide.get("sizePx", {}).get("width", 0)) or 0)
    height = int(slide.get("sizePx", {}).get("heightPx", slide.get("sizePx", {}).get("height", 0)) or 0)
    page_area = max(1, width * height)
    area = max(0.0, float(box.get("w", 0))) * max(0.0, float(box.get("h", 0)))
    area_share = round(area / page_area, 6)
    severity = _region_severity(profile)

    pixel = region_pixel_metrics(source_path, render_path, box)
    region_ssim = pixel.get("ssim")
    ssim_status = dict(pixel.get("ssimStatus") or _metric_unavailable("missing-ssim-result", "regional-ssim"))
    if ssim_status.get("status") == "available":
        ssim_status["status"] = "measured"
    normalized_mae = pixel.get("normalizedMae")
    mae_status = {"status": "measured", "method": "regional-rgb-normalized-mae"} if normalized_mae is not None else _metric_unavailable("missing-mae-result", "regional-rgb-normalized-mae")

    source_text, source_ocr_status = _crop_text(source_path, box, langs)
    render_text, render_ocr_status = _crop_text(render_path, box, langs)
    if source_ocr_status.get("status") != "measured":
        ocr_value = None
        ocr_status = source_ocr_status
    elif render_ocr_status.get("status") != "measured":
        ocr_value = None
        ocr_status = render_ocr_status
    else:
        ocr_value = round(cer(source_text, render_text), 6)
        ocr_status = {"status": "measured", "method": "regional-ocr-cer", "sourceText": source_text, "renderText": render_text}

    bbox_iou, bbox_status = _region_bbox_iou(profile, slide.get("objects", []), object_reports)
    palette_delta, palette_status, color_status = _regional_palette_delta(source_path, render_path, box)
    crop_digests: dict[str, Any] = {}
    try:
        with Image.open(source_path) as source_opened, Image.open(render_path) as render_opened:
            source_image = source_opened.convert("RGB")
            render_image = render_opened.convert("RGB")
            source_safe = _safe_box(box, source_image.width, source_image.height)
            render_safe = _safe_box(box, render_image.width, render_image.height)
            if source_safe and render_safe:
                crop_digests = {
                    "sourceCropDigest": hashlib.sha256(source_image.crop(source_safe).tobytes()).hexdigest(),
                    "renderCropDigest": hashlib.sha256(render_image.crop(render_safe).tobytes()).hexdigest(),
                }
    except Exception:
        crop_digests = {}
    impact = None
    impact_status = _metric_unavailable("region-ssim-unavailable", "regional-impact")
    if region_ssim is not None:
        # Do not round before applying the contract formula; only the emitted
        # value is rounded for stable JSON while preserving exact ordering.
        impact = round(area_share * (1.0 - float(region_ssim)) * severity, 8)
        impact_status = {"status": "measured", "formula": "areaShare*(1-regionSSIM)*severityWeight"}
    return {
        "id": str(profile.get("id")),
        "role": str(profile.get("role", "decor")),
        "pixelBox": dict(box),
        "areaShare": area_share,
        "severityWeight": severity,
        "regionSSIM": round(float(region_ssim), 8) if region_ssim is not None else None,
        "ocrCER": ocr_value,
        "bboxIoU": bbox_iou,
        "normalizedMAE": round(float(normalized_mae), 8) if normalized_mae is not None else None,
        "paletteDeltaE2000P95": palette_delta,
        "color": palette_status,
        "metricStatus": {
            "regionSSIM": ssim_status,
            "ocrCER": ocr_status,
            "bboxIoU": bbox_status,
            "normalizedMAE": mae_status,
            "paletteDeltaE2000P95": color_status,
            "impact": impact_status,
        },
        "measurement": "source-render-crop",
        "impact": impact,
        "impactStatus": impact_status,
        "sourceText": source_text if source_ocr_status.get("status") == "measured" else None,
        "renderText": render_text if render_ocr_status.get("status") == "measured" else None,
        **crop_digests,
    }


def rank_error_regions(regions: list[dict[str, Any]], limit: int = MAX_ERROR_REGIONS) -> list[dict[str, Any]]:
    """Stable top-impact ordering; unavailable metrics never become zero-error."""

    selected = sorted(
        regions,
        key=lambda item: (
            -float(item.get("impact")) if item.get("impact") is not None else 1.0,
            str(item.get("id", "")),
        ),
    )
    return selected[: max(0, min(MAX_ERROR_REGIONS, int(limit)))]


def build_region_repair_candidates(
    slide: dict[str, Any],
    measured_regions: list[dict[str, Any]],
    adjustments: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Build a deterministic, source-bound beam for the selected regions.

    A route trial is emitted only when the renderer can make an observable
    source-bound composition change.  If a candidate would merely change a
    strategy label while rendering identical objects, it is recorded as
    unavailable and never enters calibration.
    """

    top = {
        str(item.get("id")): item
        for item in rank_error_regions(
            [item for item in measured_regions if item.get("impact") is not None and item.get("impactStatus", {}).get("status") == "measured"]
        )
    }
    by_region: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for adjustment in adjustments:
        region_id = adjustment.get("regionId")
        if region_id in top:
            by_region[str(region_id)].append(adjustment)
    plan_regions = {
        str(item.get("id")): item
        for item in (slide.get("reconstructionPlan", {}).get("regions", []) or [])
    }
    candidates: list[dict[str, Any]] = []
    for region in sorted(top.values(), key=lambda item: (-float(item.get("impact") or 0.0), str(item.get("id", "")))):
        region_id = str(region.get("id"))
        local = sorted(by_region.get(region_id, []), key=lambda item: (str(item.get("category", "")), str(item.get("id", ""))))
        if local:
            candidates.append({
                "candidateId": f"{region_id}-measured-adjustments",
                "regionId": region_id,
                "action": "measured-adjustments",
                "sourceBound": True,
                "actions": local,
                "status": "proposed",
            })
        plan_region = plan_regions.get(region_id)
        if not plan_region:
            continue
        winner_id = str(plan_region.get("winnerId", ""))
        winner = next((item for item in plan_region.get("candidates", []) if str(item.get("id")) == winner_id), None)
        current_strategy = str(winner.get("strategy")) if winner else ""
        for candidate in sorted(plan_region.get("candidates", []), key=lambda item: (str(item.get("strategy", "")), str(item.get("id", "")))):
            strategy = str(candidate.get("strategy", ""))
            if not strategy or strategy == current_strategy or not candidate.get("eligible"):
                continue
            members = [item for item in slide.get("objects", []) if str(item.get("id")) in set(plan_region.get("assignedObjectRefs", []))]
            image_members = [item for item in members if item.get("type") == "image"]
            # The analyzer emits only tight, page-sized residual assets. It
            # does not provide an independent source-asset aspect record, so
            # a route label alone cannot prove a renderer-observable change.
            # Keep route diagnostics explicit but never enqueue a metadata-only
            # trial in the executable repair beam.
            reason = "no-source-asset-aspect-evidence" if image_members else "route-has-no-observable-renderer-composition-difference"
            candidates.append({
                    "candidateId": f"{region_id}-route-{strategy}",
                    "regionId": region_id,
                    "action": "route-switch",
                    "targetStrategy": strategy,
                    "sourceBound": True,
                    "status": "unavailable",
                    "reason": reason,
                    "actions": [],
                })
    # Preserve source-bound diagnostics that cannot be assigned to a measured
    # region.  They are intentionally unavailable and carry no executable
    # actions, but remain visible to QA instead of disappearing during queue
    # filtering.
    for adjustment in sorted(
        (
            item for item in adjustments
            if item.get("status") == "unavailable" and not item.get("regionId")
        ),
        key=lambda item: (str(item.get("category", "")), str(item.get("id", ""))),
    ):
        candidates.append({
            "candidateId": f"{adjustment.get('id', 'adjustment')}-unavailable",
            "regionId": None,
            "action": adjustment.get("category") or "adjustment",
            "sourceBound": False,
            "status": "unavailable",
            "reason": adjustment.get("reason") or "adjustment-region-unavailable",
            "actions": [],
        })
    # Stable bounded beam: candidates are ordered by measured impact, action,
    # then id.  Unavailable route trials remain diagnostics but are excluded
    # from the executable beam.
    candidates.sort(key=lambda item: (
        -float(top.get(str(item.get("regionId")), {}).get("impact") or 0.0),
        1 if item.get("status") == "unavailable" else 0,
        str(item.get("action", "")),
        str(item.get("candidateId", "")),
    ))
    bounded: list[dict[str, Any]] = []
    counts: Counter[str] = Counter()
    for item in candidates:
        region_id = str(item.get("regionId", ""))
        if counts[region_id] >= MAX_REPAIR_CANDIDATES_PER_REGION:
            continue
        bounded.append(item)
        counts[region_id] += 1
    return bounded


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
        # A localized OCR result carries the expected object id.  Prefer that
        # observation even when recognition is partial so missing/extra glyphs
        # produce a diagnostic and a bounded geometry suggestion instead of
        # disappearing from the comparison.
        candidates = [direct] if direct in available else [
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
        actual_text = rendered[selected]["text"]
        text_matches = text_key(actual_text) == text_key(item["text"])
        matched += int(text_matches)
        recognized.append(actual_text)
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
                "category": "text",
                "textMatch": text_matches,
                "recognizedText": actual_text,
                "suggestions": (
                    []
                    if text_matches and value >= 0.90
                    else [
                        "preserve the independently OCR-recognized text",
                        "adjust position, font scale, and character spacing within bounds",
                    ]
                ),
            }
        )
    return ious, adjustments, matched, recognized


def object_diagnostics(
    source_path: Path,
    render_path: Path,
    slide: dict[str, Any],
    rendered_text: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any], list[dict[str, Any]]]:
    """Classify every declared region and emit object-level QA guidance."""
    with Image.open(source_path) as opened_source, Image.open(render_path) as opened_render:
        source_image = opened_source.convert("RGB")
        render_image = opened_render.convert("RGB")
    rendered_by_id = {
        item.get("id"): item for item in rendered_text if item.get("id")
    }
    objects: list[dict[str, Any]] = []
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in slide.get("objects", []):
        category = region_category(item)
        source_box = item.get("pixelBox") or {}
        observed = rendered_by_id.get(item.get("id")) if category == "text" else None
        if category == "text":
            rendered_box = observed.get("pixelBox") if observed else None
            geometry_measurement = {
                "status": "measured" if observed else "unavailable",
                "method": "localized-ocr",
            }
        else:
            rendered_box, geometry_measurement = measured_region_box(
                source_image, render_image, source_box
            )
        metrics = region_pixel_metrics(source_path, render_path, source_box)
        iou = tolerant_iou(source_box, rendered_box) if source_box and rendered_box else None
        text_match = None
        if category == "text":
            text_match = bool(observed and text_key(observed.get("text", "")) == text_key(item.get("text", "")))
        issue_flags: list[str] = []
        if category == "text" and not text_match:
            issue_flags.append("text-mismatch")
        if iou is not None and iou < 0.90:
            issue_flags.append("geometry-mismatch")
        if metrics.get("normalizedMae") is not None and metrics["normalizedMae"] > 0.20:
            issue_flags.append("region-pixel-drift")
        suggestions: list[str] = []
        if category == "text":
            suggestions = [
                "preserve source OCR text; do not infer replacements",
                "adjust dx/dy/fontScale/charSpacingDeltaPt only within bounded limits",
            ]
        elif category == "shape":
            suggestions = [
                "adjust shape geometry or fill/border color within bounded limits",
                "keep native shape/connector semantics and z-order explicit",
            ]
        elif category == "image":
            suggestions = [
                "adjust only the bounded crop geometry",
                "never promote a local image crop to a whole-slide raster",
            ]
        if not issue_flags:
            suggestions = []
        raw_dx = source_box.get("x", 0) - rendered_box.get("x", 0) if rendered_box else 0
        raw_dy = source_box.get("y", 0) - rendered_box.get("y", 0) if rendered_box else 0
        raw_dw = source_box.get("w", 0) - rendered_box.get("w", 0) if rendered_box else 0
        raw_dh = source_box.get("h", 0) - rendered_box.get("h", 0) if rendered_box else 0
        repair_eligible = bool(
            category != "text"
            and rendered_box
            and iou is not None
            and iou < 0.90
            and iou >= 0.45
            and (metrics.get("normalizedMae") or 0) >= 0.05
            and abs(raw_dx) <= 8
            and abs(raw_dy) <= 8
            and (
                (category == "shape" and abs(raw_dw) <= 4 and abs(raw_dh) <= 4)
                or (category == "image" and abs(raw_dw) <= 2 and abs(raw_dh) <= 2)
            )
        )
        geometry_measurement["repairEligible"] = repair_eligible
        adjustment = {
            "id": item.get("id"),
            "category": category,
            "sourceBound": True,
            "dx": round(raw_dx, 4) if repair_eligible else 0,
            "dy": round(raw_dy, 4) if repair_eligible else 0,
            "dw": round(raw_dw, 4) if repair_eligible and category == "shape" else 0,
            "dh": round(raw_dh, 4) if repair_eligible and category == "shape" else 0,
            "zDelta": 0,
            "suggestions": suggestions,
        }
        diagnostic = {
            "id": item.get("id"),
            "type": item.get("type"),
            "category": category,
            "sourceBox": source_box,
            "renderedBox": rendered_box,
            "bboxIou": round(iou, 6) if iou is not None else None,
            "geometryMeasurement": geometry_measurement,
            "textMatch": text_match,
            "metrics": metrics,
            "status": "passed" if not issue_flags else "repairable",
            "findings": issue_flags,
            "suggestions": suggestions,
            "adjustment": adjustment,
        }
        objects.append(diagnostic)
        grouped.setdefault(category, []).append(diagnostic)

    # Background is a deliberate region category even though it has no native
    # object id.  Its metric is informational and never relaxes the page gates.
    background_metrics = region_pixel_metrics(
        source_path,
        render_path,
        {
            "x": 0,
            "y": 0,
            "w": slide.get("sizePx", {}).get("widthPx", slide.get("sizePx", {}).get("width", 0)),
            "h": slide.get("sizePx", {}).get("heightPx", slide.get("sizePx", {}).get("height", 0)),
        },
    )
    source_background = _dominant_edge_color(source_image)
    render_background = _dominant_edge_color(render_image)
    background_distance = _rgb_distance(source_background, render_background)
    background_repairable = (background_metrics.get("normalizedMae") or 0) > 0.20 or background_distance > 12
    background = {
        "category": "background",
        "count": 1,
        "metrics": background_metrics,
        "status": "repairable" if background_repairable else "passed",
        "sourceColor": _hex_color(source_background),
        "renderedColor": _hex_color(render_background),
        "rgbDistance": round(background_distance, 6),
        "suggestions": [
            "adjust the slide background color only when source-bound evidence supports it",
        ] if background_repairable else [],
    }
    grouped["background"] = [background]

    z_values = [item.get("z") for item in slide.get("objects", []) if isinstance(item.get("z"), (int, float))]
    duplicate_z = len(z_values) != len(set(z_values))
    actual_order = [
        item.get("id")
        for item in sorted(slide.get("objects", []), key=lambda value: (value.get("z", 0), value.get("id", "")))
    ]
    declared_order = slide.get("sceneLayerGraph", {}).get("stableOrder", [])
    order_mismatch = bool(declared_order and declared_order != actual_order)
    z_object = None
    z_delta = 0
    if order_mismatch:
        mismatch_index = next(
            (
                index
                for index, value in enumerate(declared_order)
                if index >= len(actual_order) or actual_order[index] != value
            ),
            None,
        )
        if mismatch_index is not None:
            z_object = declared_order[mismatch_index]
            if z_object in actual_order:
                z_delta = -1 if actual_order.index(z_object) > mismatch_index else 1
    z_order = {
        "category": "z-order",
        "count": len(z_values),
        "status": "repairable" if duplicate_z or order_mismatch else "passed",
        "duplicateZ": duplicate_z,
        "declaredOrder": declared_order,
        "renderOrder": actual_order,
        "orderMismatch": order_mismatch,
        "suggestions": [
            "adjust zDelta by at most one step and preserve background-behind-content ordering",
        ] if duplicate_z or order_mismatch else [],
    }
    grouped["z-order"] = [z_order]
    summary = {
        category: {
            "count": len(values),
            "status": "repairable" if any(value.get("status") == "repairable" for value in values) else "passed",
            "findings": [
                finding
                for value in values
                for finding in value.get("findings", [])
            ],
        }
        for category, values in grouped.items()
    }
    # Always expose all required categories so consumers can render a stable QA
    # table even when a slide contains no object of one kind.
    for category in REGION_CATEGORIES:
        summary.setdefault(category, {"count": 0, "status": "passed", "findings": []})
    adjustments = [item["adjustment"] for item in objects]
    adjustments.append({
        "id": "__background__",
        "category": "background",
        "sourceBound": True,
        "backgroundColor": _hex_color(source_background) if background_repairable else None,
        "dx": 0,
        "dy": 0,
        "dw": 0,
        "dh": 0,
        "zDelta": 0,
    })
    adjustments.append({
        "id": "__z-order__",
        "category": "z-order",
        "sourceBound": True,
        "objectId": z_object,
        "dx": 0,
        "dy": 0,
        "dw": 0,
        "dh": 0,
        "zDelta": z_delta,
    })
    return objects, summary, adjustments


def bind_adjustment_regions(
    adjustments: list[dict[str, Any]],
    region_profiles: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Attach source-bound adjustments to their owning RegionProfile.

    Object adjustments use their object id.  Synthetic z-order and background
    adjustments have no native object id, so z-order follows ``objectId`` and
    background requires exactly one declared background profile.  An action
    with repair evidence but no unambiguous region is retained as an explicit
    unavailable diagnostic and made non-executable.
    """

    profile_by_object: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for profile in region_profiles:
        for ref in profile.get("objectRefs", []):
            profile_by_object[str(ref)].append(profile)

    role_rank = {
        "title": 0,
        "text-block": 1,
        "card-or-native-group": 2,
        "image": 3,
        "chart": 4,
        "table": 5,
        "background": 6,
        "decor": 7,
    }

    object_region: dict[str, str] = {}
    for object_id, profiles in profile_by_object.items():
        selected = sorted(
            profiles,
            key=lambda item: (
                max(0.0, float(item.get("pixelBox", {}).get("w", 0)))
                * max(0.0, float(item.get("pixelBox", {}).get("h", 0))),
                role_rank.get(str(item.get("role", "decor")), 99),
                str(item.get("id", "")),
            ),
        )
        if selected:
            object_region[object_id] = str(selected[0].get("id"))

    background_profiles = [
        profile for profile in region_profiles
        if str(profile.get("role", "")) == "background"
    ]
    background_region = (
        str(background_profiles[0].get("id"))
        if len(background_profiles) == 1
        else None
    )
    background_reason = (
        None
        if background_region
        else "background-region-profile-missing"
        if not background_profiles
        else "background-region-profile-ambiguous"
    )

    for item in adjustments:
        item_id = str(item.get("id", ""))
        if item_id == "__z-order__":
            target = str(item.get("objectId") or "")
            region_id = object_region.get(target)
            if region_id and item.get("zDelta"):
                item["regionId"] = region_id
                item["sourceBound"] = True
                item["status"] = "proposed"
            elif item.get("zDelta"):
                item["sourceBound"] = False
                item["status"] = "unavailable"
                item["reason"] = "z-order-target-region-unavailable"
            else:
                item["sourceBound"] = False
                item["status"] = "passed"
            continue
        if item_id == "__background__":
            if background_region and item.get("backgroundColor"):
                item["regionId"] = background_region
                item["sourceBound"] = True
                item["status"] = "proposed"
            elif item.get("backgroundColor"):
                item["sourceBound"] = False
                item["status"] = "unavailable"
                item["reason"] = background_reason
            else:
                item["sourceBound"] = False
                item["status"] = "passed"
            continue
        region_id = object_region.get(item_id)
        if region_id:
            item["regionId"] = region_id
    return adjustments


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
            "ssim": ssim_metadata(),
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
        source_localized_lines = localized_ocr_lines(source_path, expected, analysis["ocr"]["langs"])
        _, global_lines = ocr_lines(render_page, analysis["ocr"]["langs"])
        rendered_lines = localized_lines + global_lines
        # Text fidelity uses independent OCR of the complete source and render.
        # The analysis objects are used for region geometry only; deriving the
        # CER reference from them would make a missing or extra OCR line
        # invisible (the former self-reference bug).
        source_text_localized = " ".join(
            item["text"] for item in source_localized_lines
        )
        render_text_localized = " ".join(item["text"] for item in localized_lines)
        source_text = merge_ocr_evidence(source_text_global, source_localized_lines)
        render_text = merge_ocr_evidence(render_text_global, localized_lines)
        localized_cer = cer(source_text_localized, render_text_localized)
        evidence_cer = ocr_evidence_cer(
            source_text_global,
            render_text_global,
            source_localized_lines,
            localized_lines,
        )
        ious, adjustments, matched, recognized = match_text(expected, rendered_lines)
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
        object_reports, region_summary, region_adjustments = object_diagnostics(
            source_path,
            render_page,
            slide,
            localized_lines,
        )
        # Bind object and synthetic diagnostics to the source-declared
        # RegionProfiles before computing regional metrics.  Overlapping
        # profiles use the same deterministic smallest-area ownership rule as
        # the planner; z-order follows its objectId and background requires a
        # unique background profile.
        bind_adjustment_regions(region_adjustments, slide.get("regionProfiles", []))
        object_region = {
            str(item.get("id")): str(item.get("regionId"))
            for item in region_adjustments
            if item.get("id") and item.get("regionId")
        }
        for report in object_reports:
            if report.get("id") in object_region:
                report["regionId"] = object_region[report["id"]]
        # Text adjustments contain measured geometry and region adjustments
        # supply shape/image/z diagnostics. Merge before ranking so every
        # object-bound action can enter the bounded queue.
        by_adjustment_id = {item.get("id"): item for item in adjustments}
        for item in region_adjustments:
            if item.get("id") in by_adjustment_id:
                existing = by_adjustment_id[item["id"]]
                existing.update({
                    key: value
                    for key, value in item.items()
                    if key not in {"dx", "dy", "fontScale", "charSpacingDeltaPt", "targetBox", "renderedBox", "iou", "textMatch", "recognizedText"}
                })
            else:
                adjustments.append(item)
        measured_regions = [
            measure_region_profile(
                source_path,
                render_page,
                profile,
                slide,
                object_reports,
                analysis["ocr"]["langs"],
            )
            for profile in sorted(slide.get("regionProfiles", []), key=lambda item: str(item.get("id", "")))
        ]
        top_regions = rank_error_regions(measured_regions)
        executable_regions = [item for item in top_regions if item.get("impact") is not None and item.get("impactStatus", {}).get("status") == "measured"]
        top_region_ids = [str(item.get("id")) for item in executable_regions]
        repair_candidates = build_region_repair_candidates(slide, measured_regions, adjustments)
        # Only the measured top-impact queue is executable in this round.  A
        # background or z-order adjustment without a region id remains a
        # diagnostic and cannot accidentally move an unrelated region.
        selected_region_ids = set(top_region_ids)
        adjustments = [
            item
            for item in adjustments
            if item.get("regionId") in selected_region_ids
            or item.get("status") == "unavailable"
        ]
        metrics = {
            "ssim": pixel["ssim"],
            "ocrCer": round(max(localized_cer, evidence_cer), 6),
            "bboxIou": round(sum(ious) / len(ious), 6) if ious else (1.0 if not expected else None),
            "paletteDeltaE2000P95": round(palette_p95, 6) if palette_p95 is not None else None,
            "nativeHighConfidenceTextRecall": round(matched / max(1, len(expected)), 6),
        }
        slide_findings = []
        if not pixel["sizeMatch"]:
            slide_findings.append("source-render-size-mismatch")
        if pixel.get("ssimStatus", {}).get("status") != "available":
            slide_findings.append("ssim-runtime-unavailable")
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
                "ocrCerGlobal": round(cer(source_text_global, render_text_global), 6),
                "ocrCerLocalized": round(localized_cer, 6),
                "ocrCerEvidence": round(evidence_cer, 6),
                "sourceTextLocalized": source_text_localized,
                "renderTextLocalized": render_text_localized,
                "sourceTextObjectProjection": " ".join(item["text"] for item in expected),
                "renderTextObjectProjection": " ".join(recognized),
                "sourceTextGlobal": source_text_global,
                "renderTextGlobal": render_text_global,
                "matchedTextCount": matched,
                "expectedTextCount": len(expected),
                "regions": region_summary,
                "regionMeasurements": measured_regions,
                "topErrorRegions": top_regions,
                "repairQueue": top_region_ids,
                "repairCandidates": repair_candidates,
                "objectDiagnostics": object_reports,
                "findings": slide_findings,
            }
        )
        calibration.append({"slideId": slide["id"], "adjustments": adjustments, "topRegionIds": top_region_ids, "candidateBeam": repair_candidates})
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
        "ssim": ssim_metadata(),
        "slides": measured_slides,
        "aggregate": aggregate,
        "findings": findings,
        "calibration": calibration,
        "repairPolicy": {
            "maxOuterRounds": 3,
            "maxRegionsPerRound": MAX_ERROR_REGIONS,
            "maxCandidatesPerRegion": MAX_REPAIR_CANDIDATES_PER_REGION,
            "impactFormula": "areaShare*(1-regionSSIM)*severityWeight",
            "metricProvenance": "measured-source-render-crop",
        },
        "regionCategories": list(REGION_CATEGORIES),
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
