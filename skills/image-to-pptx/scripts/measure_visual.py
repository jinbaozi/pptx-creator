#!/usr/bin/env python3
"""Measure source-to-render fidelity and propose bounded text calibration."""

from __future__ import annotations

import argparse
import importlib.util
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

REGION_CATEGORIES = ("text", "shape", "image", "background", "z-order")


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


def optional_perceptual_metrics(left: Image.Image, right: Image.Image) -> dict[str, Any]:
    """Use scikit-image when present, but never make it a runtime dependency."""
    if importlib.util.find_spec("skimage") is None:
        return {"perceptual": {"status": "unavailable", "provider": None}}
    try:
        import numpy as np
        from skimage.metrics import structural_similarity

        left_array = np.asarray(left.convert("L"), dtype=np.float32)
        right_array = np.asarray(right.convert("L"), dtype=np.float32)
        # Tiny crops can be smaller than skimage's default window.  Returning an
        # unavailable optional metric is preferable to changing the hard gates.
        if min(left_array.shape) < 7:
            return {"perceptual": {"status": "unavailable", "provider": "skimage"}}
        score = structural_similarity(left_array, right_array, data_range=255)
        return {
            "perceptual": {
                "status": "available",
                "provider": "skimage",
                "ssim": round(float(score), 8),
            }
        }
    except Exception as error:  # pragma: no cover - optional environment
        return {
            "perceptual": {
                "status": "unavailable",
                "provider": "skimage",
                "reason": str(error),
            }
        }


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
        result = {
            "sizeMatch": True,
            "sourceSize": {"width": left.width, "height": left.height},
            "renderSize": {"width": right.width, "height": right.height},
            "ssim": round(max(-1, min(1, ssim)), 8),
            "normalizedMae": round(normalized_mae, 8),
            "worstTileMae": round(max(tile_mae, default=0), 8),
            "worstTileBadPixelRatio": round(max(bad_ratio, default=0), 8),
        }
        result.update(optional_perceptual_metrics(left, right))
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
                "normalizedMae": None,
                "pixelCount": 0,
            }
        safe = _safe_box(box, left.width, left.height)
        if safe is None:
            return {
                "sizeMatch": True,
                "ssim": None,
                "normalizedMae": None,
                "pixelCount": 0,
            }
        source_crop = left.crop(safe)
        render_crop = right.crop(safe)
        difference = ImageChops.difference(source_crop, render_crop)
        normalized_mae = sum(ImageStat.Stat(difference).mean) / (3 * 255)
        ssim = windowed_ssim(
            source_crop.filter(ImageFilter.GaussianBlur(1)),
            render_crop.filter(ImageFilter.GaussianBlur(1)),
        )
        result = {
            "sizeMatch": True,
            "ssim": round(max(-1, min(1, ssim)), 8),
            "normalizedMae": round(normalized_mae, 8),
            "pixelCount": source_crop.width * source_crop.height,
        }
        result.update(optional_perceptual_metrics(source_crop, render_crop))
        return result


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
        "objectId": z_object,
        "dx": 0,
        "dy": 0,
        "dw": 0,
        "dh": 0,
        "zDelta": z_delta,
    })
    return objects, summary, adjustments


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
        # Text adjustments contain measured geometry and recognition evidence;
        # object-level diagnostics supply bounded repair metadata for the other
        # region categories without changing the hard thresholds.
        by_adjustment_id = {item.get("id"): item for item in adjustments}
        for item in region_adjustments:
            if item.get("id") in by_adjustment_id:
                existing = by_adjustment_id[item["id"]]
                # Keep measured text geometry authoritative; the generic
                # region record only contributes category/size/z-order knobs.
                existing.update({
                    key: value
                    for key, value in item.items()
                    if key not in {"dx", "dy", "fontScale", "charSpacingDeltaPt", "targetBox", "renderedBox", "iou", "textMatch", "recognizedText"}
                })
            else:
                adjustments.append(item)
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
                "objectDiagnostics": object_reports,
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
