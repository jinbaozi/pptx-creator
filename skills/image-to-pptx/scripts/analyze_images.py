#!/usr/bin/env python3
"""Analyze slide images into a source-bound, native-first reconstruction plan."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import sys
from collections import Counter, defaultdict, deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

try:
    from PIL import Image, ImageDraw
except ImportError as error:  # pragma: no cover - exercised by doctor/error tests
    raise SystemExit(
        json.dumps(
            {
                "status": "failed",
                "code": "E_OCR_RUNTIME",
                "message": f"Pillow is required: {error}",
            }
        )
    ) from error

try:
    import pytesseract
except ImportError:  # pragma: no cover - exercised by doctor/error tests
    pytesseract = None

VERSION = "1.0.0"
MAX_ENCODED_BYTES = 50 * 1024 * 1024
MAX_PIXELS = 16_000_000
MAX_SIDE = 8192
CANONICAL_WIDTH_PX = 1280
SLIDE_WIDTH_IN = 13.333


class AnalysisError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Box:
    x: int
    y: int
    w: int
    h: int

    @property
    def right(self) -> int:
        return self.x + self.w

    @property
    def bottom(self) -> int:
        return self.y + self.h

    @property
    def area(self) -> int:
        return self.w * self.h

    def clamp(self, width: int, height: int) -> "Box":
        x = max(0, min(self.x, width - 1))
        y = max(0, min(self.y, height - 1))
        right = max(x + 1, min(self.right, width))
        bottom = max(y + 1, min(self.bottom, height))
        return Box(x, y, right - x, bottom - y)

    def expand(self, pixels: int, width: int, height: int) -> "Box":
        return Box(
            self.x - pixels,
            self.y - pixels,
            self.w + pixels * 2,
            self.h + pixels * 2,
        ).clamp(width, height)

    def as_dict(self) -> dict[str, int]:
        return {"x": self.x, "y": self.y, "w": self.w, "h": self.h}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fail(code: str, message: str) -> None:
    raise AnalysisError(code, message)


def command_languages() -> set[str]:
    binary = shutil.which("tesseract")
    if not binary:
        fail("E_OCR_RUNTIME", "Tesseract is not available on PATH")
    try:
        output = __import__("subprocess").run(
            [binary, "--list-langs"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, __import__("subprocess").TimeoutExpired) as error:
        fail("E_OCR_RUNTIME", f"cannot inspect Tesseract languages: {error}")
    if output.returncode != 0:
        fail("E_OCR_RUNTIME", output.stderr.strip() or "cannot inspect Tesseract languages")
    return {
        line.strip()
        for line in output.stdout.splitlines()
        if line.strip() and not line.lower().startswith("list of available")
    }


def validate_ocr_runtime(langs: str) -> dict[str, Any]:
    if pytesseract is None:
        fail("E_OCR_RUNTIME", "pytesseract is required; install requirements.txt")
    available = command_languages()
    requested = {item for item in langs.split("+") if item}
    missing = sorted(requested - available)
    if missing:
        fail(
            "E_OCR_RUNTIME",
            f"Tesseract language data missing: {', '.join(missing)}; "
            f"available={', '.join(sorted(available))}",
        )
    version = str(pytesseract.get_tesseract_version()).splitlines()[0]
    return {
        "engine": "tesseract",
        "version": version,
        "langs": langs,
        "availableLanguages": sorted(available),
    }


def load_source(path: Path) -> Image.Image:
    if not path.is_file():
        fail("E_INPUT_FORMAT", f"image not found: {path}")
    size = path.stat().st_size
    if size > MAX_ENCODED_BYTES:
        fail("E_INPUT_LIMIT", f"image exceeds 50 MiB encoded limit: {path}")
    try:
        with Image.open(path) as opened:
            opened.verify()
        with Image.open(path) as opened:
            width, height = opened.size
            if (
                width <= 0
                or height <= 0
                or width > MAX_SIDE
                or height > MAX_SIDE
                or width * height > MAX_PIXELS
            ):
                fail(
                    "E_INPUT_LIMIT",
                    f"image exceeds decoded limit (8192px/side, 16MP): {path}",
                )
            return opened.convert("RGB")
    except AnalysisError:
        raise
    except Exception as error:
        fail("E_INPUT_FORMAT", f"unsupported or corrupt image {path}: {error}")


def rgb_hex(color: tuple[int, int, int]) -> str:
    return "#{:02X}{:02X}{:02X}".format(*color)


def color_distance(left: tuple[int, int, int], right: tuple[int, int, int]) -> float:
    return math.sqrt(sum((left[index] - right[index]) ** 2 for index in range(3)))


def dominant_palette(image: Image.Image, count: int = 10) -> list[dict[str, Any]]:
    sample = image.resize((160, max(1, round(160 * image.height / image.width))))
    quantized = sample.quantize(colors=count, method=Image.Quantize.MEDIANCUT)
    palette = quantized.getpalette() or []
    pixels = list(quantized.getdata())
    total = max(1, len(pixels))
    result = []
    for index, frequency in Counter(pixels).most_common(count):
        offset = index * 3
        color = tuple(palette[offset : offset + 3])
        if len(color) != 3:
            continue
        result.append(
            {
                "hex": rgb_hex(color),  # type: ignore[arg-type]
                "share": round(frequency / total, 6),
            }
        )
    return result


def edge_background(image: Image.Image) -> tuple[int, int, int]:
    rgb = image.load()
    width, height = image.size
    points: list[tuple[int, int, int]] = []
    step_x = max(1, width // 80)
    step_y = max(1, height // 45)
    for x in range(0, width, step_x):
        points.append(rgb[x, 0])
        points.append(rgb[x, height - 1])
    for y in range(0, height, step_y):
        points.append(rgb[0, y])
        points.append(rgb[width - 1, y])
    return Counter(points).most_common(1)[0][0]


def foreground_color(image: Image.Image, box: Box) -> str:
    crop = image.crop((box.x, box.y, box.right, box.bottom))
    colors = crop.getcolors(maxcolors=max(1, box.area)) or []
    if not colors:
        return "#172033"
    ordered = sorted(colors, reverse=True)
    background = ordered[0][1]
    candidates = [
        (frequency, color)
        for frequency, color in ordered[1:]
        if color_distance(color, background) >= 55
    ]
    selected = max(candidates, default=(0, (23, 32, 51)))[1]
    return rgb_hex(selected)


def ocr_lines(
    image: Image.Image,
    langs: str,
    threshold: float,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    assert pytesseract is not None
    def recognize_pass(
        source: Image.Image,
        pass_name: str,
    ) -> tuple[list[dict[str, Any]], list[tuple[dict[str, Any], list[dict[str, Any]]]]]:
        payload = pytesseract.image_to_data(
            source,
            lang=langs,
            config="--psm 11",
            output_type=pytesseract.Output.DICT,
        )
        pass_words: list[dict[str, Any]] = []
        grouped: dict[tuple[int, int, int], list[dict[str, Any]]] = defaultdict(list)
        count = len(payload.get("text", []))
        for index in range(count):
            text = str(payload["text"][index]).strip()
            if not text:
                continue
            try:
                confidence = max(0.0, min(1.0, float(payload["conf"][index]) / 100.0))
                box = Box(
                    int(payload["left"][index]),
                    int(payload["top"][index]),
                    int(payload["width"][index]),
                    int(payload["height"][index]),
                )
            except (KeyError, TypeError, ValueError):
                continue
            if box.w <= 0 or box.h <= 0:
                continue
            word = {
                "text": text,
                "confidence": round(confidence, 4),
                "pixelBox": box.as_dict(),
                "block": int(payload.get("block_num", [0] * count)[index]),
                "paragraph": int(payload.get("par_num", [0] * count)[index]),
                "line": int(payload.get("line_num", [0] * count)[index]),
                "recognitionPass": pass_name,
            }
            pass_words.append(word)
            grouped[(word["block"], word["paragraph"], word["line"])].append(word)

        pass_lines: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
        for values in grouped.values():
            values.sort(key=lambda item: item["pixelBox"]["x"])
            boxes = [item["pixelBox"] for item in values]
            x = min(item["x"] for item in boxes)
            y = min(item["y"] for item in boxes)
            right = max(item["x"] + item["w"] for item in boxes)
            bottom = max(item["y"] + item["h"] for item in boxes)
            total_weight = sum(max(1, len(item["text"])) for item in values)
            confidence = sum(
                item["confidence"] * max(1, len(item["text"])) for item in values
            ) / total_weight
            text = " ".join(item["text"] for item in values)
            box = Box(x, y, right - x, bottom - y)
            pass_lines.append(
                (
                    {
                        "text": text,
                        "confidence": round(confidence, 4),
                        "pixelBox": box.as_dict(),
                        "disposition": (
                            "editable-text" if confidence >= threshold else "local-crop"
                        ),
                        "recognitionPass": pass_name,
                    },
                    values,
                )
            )
        return pass_words, pass_lines

    words, primary_pairs = recognize_pass(image, "primary")
    lines = [line for line, _ in primary_pairs]

    # A second, deliberately narrow pass recovers small light/red labels that can
    # disappear into dark or saturated regions in the primary RGB OCR pass. Only
    # high-confidence, spatially new lines are admitted, so this cannot silently
    # replace primary text or invent overlapping alternatives.
    red_channel = image.convert("RGB").getchannel("R")
    red_binary = red_channel.point(lambda value: 255 if value > 130 else 0)
    _, secondary_pairs = recognize_pass(red_binary, "red-threshold-130")
    accepted_boxes = [
        Box(**line["pixelBox"])
        for line in lines
    ]
    secondary_threshold = max(threshold, 0.85)
    for line, line_words in secondary_pairs:
        box = Box(**line["pixelBox"])
        if line["confidence"] < secondary_threshold:
            continue
        if any(overlaps(box, existing, 0.35) for existing in accepted_boxes):
            continue
        line["disposition"] = "editable-text"
        lines.append(line)
        words.extend(line_words)
        accepted_boxes.append(box)

    lines.sort(key=lambda item: (item["pixelBox"]["y"], item["pixelBox"]["x"]))
    return words, lines


def exact_color_components(
    image: Image.Image, background: tuple[int, int, int]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    width, height = image.size
    pixels = image.load()
    seen = bytearray(width * height)
    shapes: list[dict[str, Any]] = []
    connectors: list[dict[str, Any]] = []
    minimum = max(80, round(width * height * 0.00008))

    for y in range(height):
        for x in range(width):
            start = y * width + x
            if seen[start]:
                continue
            color = pixels[x, y]
            stack = [start]
            seen[start] = 1
            count = 0
            min_x = max_x = x
            min_y = max_y = y
            while stack:
                current = stack.pop()
                px = current % width
                py = current // width
                count += 1
                min_x = min(min_x, px)
                max_x = max(max_x, px)
                min_y = min(min_y, py)
                max_y = max(max_y, py)
                for nx, ny in ((px - 1, py), (px + 1, py), (px, py - 1), (px, py + 1)):
                    if nx < 0 or ny < 0 or nx >= width or ny >= height:
                        continue
                    neighbor = ny * width + nx
                    if not seen[neighbor] and pixels[nx, ny] == color:
                        seen[neighbor] = 1
                        stack.append(neighbor)
            if count < minimum:
                continue
            box = Box(min_x, min_y, max_x - min_x + 1, max_y - min_y + 1)
            fill_ratio = count / max(1, box.area)
            spans_page = (
                (box.w >= width * 0.90 and box.h >= height * 0.90)
                or box.area >= width * height * 0.80
            )
            if spans_page or (color == background and box.area >= width * height * 0.70):
                continue
            base = {
                "pixelBox": box.as_dict(),
                "color": rgb_hex(color),
                "confidence": round(fill_ratio, 4),
            }
            if (box.w >= width * 0.20 and box.h <= 6) or (
                box.h >= height * 0.20 and box.w <= 6
            ):
                connectors.append(
                    {
                        **base,
                        "type": "connector",
                        "widthPx": max(1, min(box.w, box.h)),
                        "direction": "horizontal" if box.w >= box.h else "vertical",
                    }
                )
                continue
            if box.w < 8 or box.h < 8:
                continue
            if (
                (box.w >= width * 0.08 and box.h >= height * 0.025)
                or (box.w <= 16 and box.h >= height * 0.12)
                or (box.h <= 16 and box.w >= width * 0.12)
            ) and fill_ratio >= 0.90:
                shapes.append(
                    {
                        **base,
                        "type": "shape",
                        "shape": "rect",
                        "fill": True,
                        "borderWidthPx": 0,
                    }
                )
            elif (
                box.w >= width * 0.08
                and box.h >= height * 0.025
                and 0.004 <= fill_ratio <= 0.24
            ):
                ratio = box.w / max(1, box.h)
                shape = "ellipse" if 0.85 <= ratio <= 1.15 and fill_ratio >= 0.06 else "rect"
                perimeter = max(1, 2 * (box.w + box.h))
                shapes.append(
                    {
                        **base,
                        "type": "shape",
                        "shape": shape,
                        "fill": False,
                        "borderWidthPx": max(1, round(count / perimeter)),
                    }
                )
    return shapes, connectors


def hot_regions(image: Image.Image) -> list[dict[str, Any]]:
    width, height = image.size
    tile = 32
    cols = math.ceil(width / tile)
    rows = math.ceil(height / tile)
    hot: set[tuple[int, int]] = set()
    for row in range(rows):
        for col in range(cols):
            left, top = col * tile, row * tile
            crop = image.crop((left, top, min(width, left + tile), min(height, top + tile)))
            colors = crop.getcolors(maxcolors=257)
            if colors is None or len(colors) > 160:
                hot.add((col, row))
    regions: list[dict[str, Any]] = []
    remaining = set(hot)
    while remaining:
        seed = remaining.pop()
        queue: deque[tuple[int, int]] = deque([seed])
        group = {seed}
        while queue:
            col, row = queue.popleft()
            for neighbor in ((col - 1, row), (col + 1, row), (col, row - 1), (col, row + 1)):
                if neighbor in remaining:
                    remaining.remove(neighbor)
                    group.add(neighbor)
                    queue.append(neighbor)
        left = min(item[0] for item in group) * tile
        top = min(item[1] for item in group) * tile
        right = min(width, (max(item[0] for item in group) + 1) * tile)
        bottom = min(height, (max(item[1] for item in group) + 1) * tile)
        box = Box(left, top, right - left, bottom - top)
        if box.area < width * height * 0.004:
            continue
        regions.append(
            {
                "type": "image",
                "pixelBox": box.as_dict(),
                "reason": "high-local-color-complexity",
                "confidence": 1.0,
            }
        )
    regions.sort(key=lambda item: (item["pixelBox"]["y"], item["pixelBox"]["x"]))
    return regions


def overlaps(left: Box, right: Box, threshold: float = 0.5) -> bool:
    intersection = max(0, min(left.right, right.right) - max(left.x, right.x)) * max(
        0, min(left.bottom, right.bottom) - max(left.y, right.y)
    )
    return intersection / max(1, min(left.area, right.area)) >= threshold


def component_inferences(
    shapes: list[dict[str, Any]], connectors: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    horizontal = [
        item
        for item in connectors
        if item["direction"] == "horizontal"
    ]
    vertical = [
        item
        for item in connectors
        if item["direction"] == "vertical"
    ]
    if len(horizontal) >= 2 and len(vertical) >= 2:
        result.append(
            {
                "role": "table-grid",
                "confidence": 0.82,
                "renderedAs": "native-shapes-and-connectors",
                "factStatus": "inferred",
            }
        )
    by_color: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in shapes:
        if item.get("fill"):
            by_color[item["color"]].append(item)
    for color, values in by_color.items():
        candidates = [
            item
            for item in values
            if item["pixelBox"]["h"] >= 20 and item["pixelBox"]["w"] >= 8
        ]
        if len(candidates) < 3:
            continue
        bottoms = [item["pixelBox"]["y"] + item["pixelBox"]["h"] for item in candidates]
        if max(bottoms) - min(bottoms) <= 5:
            result.append(
                {
                    "role": "bar-chart",
                    "confidence": 0.76,
                    "renderedAs": "native-shapes",
                    "factStatus": "inferred",
                    "note": "No synthetic chart data was created; visible bars remain editable shapes.",
                    "color": color,
                }
            )
            break
    return result


def write_crop(
    image: Image.Image, box: Box, path: Path
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.crop((box.x, box.y, box.right, box.bottom)).save(path)


def relative(path: Path, root: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def analyze_slide(
    source: Path,
    normalized_path: Path,
    slide_index: int,
    root: Path,
    assets_dir: Path,
    annotations_dir: Path,
    langs: str,
    threshold: float,
    target_size: tuple[int, int],
) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    original = load_source(source)
    target_width, target_height = target_size
    normalized = original.resize(target_size, Image.Resampling.LANCZOS)
    normalized_path.parent.mkdir(parents=True, exist_ok=True)
    normalized.save(normalized_path)
    background = edge_background(normalized)
    palette = dominant_palette(normalized)
    words, lines = ocr_lines(normalized, langs, threshold)
    shapes, connectors = exact_color_components(normalized, background)
    residuals = hot_regions(normalized)
    slide_id = f"slide-{slide_index:03d}"
    objects: list[dict[str, Any]] = []
    degradations: list[dict[str, Any]] = []
    z = 0

    for number, item in enumerate(shapes, 1):
        objects.append(
            {
                **item,
                "id": f"{slide_id}-shape-{number:03d}",
                "z": z,
                "factStatus": "observed",
            }
        )
        z += 1
    for number, item in enumerate(connectors, 1):
        objects.append(
            {
                **item,
                "id": f"{slide_id}-connector-{number:03d}",
                "z": z,
                "factStatus": "observed",
            }
        )
        z += 1

    residual_boxes: list[Box] = []
    for number, item in enumerate(residuals, 1):
        box = Box(**item["pixelBox"])
        if (
            (box.w >= target_width * 0.90 and box.h >= target_height * 0.90)
            or box.area >= target_width * target_height * 0.80
        ):
            fail(
                "E_WHOLE_SLIDE_FALLBACK",
                f"{slide_id} is globally complex; a prohibited whole-slide raster would be required",
            )
        crop_path = assets_dir / slide_id / f"complex-{number:03d}.png"
        write_crop(normalized, box, crop_path)
        residual_boxes.append(box)
        object_id = f"{slide_id}-complex-{number:03d}"
        objects.append(
            {
                **item,
                "id": object_id,
                "asset": relative(crop_path, root),
                "z": z,
                "factStatus": "observed",
            }
        )
        degradations.append(
            {
                "id": f"degradation-{object_id}",
                "slideId": slide_id,
                "componentId": object_id,
                "reason": item["reason"],
                "editabilityImpact": "non-editable-region",
                "nativeAlternativesAttempted": [
                    "editable-text",
                    "native-shape",
                    "native-table",
                    "native-chart",
                    "connector",
                ],
            }
        )
        z += 1

    low_lines = []
    for number, line in enumerate(lines, 1):
        target_box = Box(**line["pixelBox"])
        object_id = f"{slide_id}-text-{number:03d}"
        if sum(character.isalnum() for character in line["text"]) < 2:
            line["disposition"] = "ignored-nonsemantic-glyph"
            continue
        compact_label = sum(character.isalnum() for character in line["text"]) <= 4
        effective_threshold = max(threshold, 0.80) if compact_label else threshold
        line["disposition"] = (
            "editable-text" if line["confidence"] >= effective_threshold else "local-crop"
        )
        if line["confidence"] >= effective_threshold:
            height = target_box.h
            render_box = Box(
                max(0, target_box.x - 1),
                max(0, round(target_box.y - height * 0.27)),
                min(target_width - max(0, target_box.x - 1), round(target_box.w * 1.62 + 16)),
                min(target_height - max(0, round(target_box.y - height * 0.27)), round(height * 1.62 + 2)),
            )
            letters = [character for character in line["text"] if character.isalpha()]
            uppercase = bool(letters) and sum(character.isupper() for character in letters) / len(letters) >= 0.85
            objects.append(
                {
                    "id": object_id,
                    "type": "text",
                    "text": line["text"],
                    "confidence": line["confidence"],
                    "recognitionPass": line.get("recognitionPass", "primary"),
                    "pixelBox": target_box.as_dict(),
                    "renderBox": render_box.as_dict(),
                    "style": {
                        "fontFamily": "Arial",
                        "fontSizePt": round(max(7.0, target_box.h * 1.04), 3),
                        "color": foreground_color(normalized, target_box),
                        "bold": (uppercase or compact_label) and target_box.h >= 14,
                        "charSpacingPt": 0,
                    },
                    "z": z,
                    "factStatus": "recognized",
                }
            )
            z += 1
        else:
            crop_box = target_box.expand(3, target_width, target_height)
            if any(overlaps(crop_box, residual, 0.80) for residual in residual_boxes):
                # The existing complex crop already preserves these pixels.
                asset = None
            else:
                crop_path = assets_dir / slide_id / f"low-confidence-{number:03d}.png"
                write_crop(normalized, crop_box, crop_path)
                asset = relative(crop_path, root)
                objects.append(
                    {
                        "id": object_id,
                        "type": "image",
                        "asset": asset,
                        "pixelBox": crop_box.as_dict(),
                        "confidence": line["confidence"],
                        "reason": "low-confidence-ocr",
                        "z": z,
                        "factStatus": "recognized",
                    }
                )
                z += 1
            low_lines.append({**line, "id": object_id, "asset": asset})
            degradations.append(
                {
                    "id": f"degradation-{object_id}",
                    "slideId": slide_id,
                    "componentId": object_id,
                    "reason": "low-confidence-ocr",
                    "editabilityImpact": "non-editable-region",
                    "nativeAlternativesAttempted": ["editable-text"],
                    "confidence": line["confidence"],
                }
            )

    annotated = normalized.copy()
    draw = ImageDraw.Draw(annotated)
    for line in low_lines:
        box = Box(**line["pixelBox"])
        draw.rectangle((box.x - 2, box.y - 2, box.right + 2, box.bottom + 2), outline="#E53935", width=3)
    annotation_path = annotations_dir / f"{slide_id}.png"
    annotation_path.parent.mkdir(parents=True, exist_ok=True)
    annotated.save(annotation_path)

    source_record = {
        "id": f"source-{slide_index:03d}",
        "kind": "user-image",
        "label": source.name,
        "factStatus": "provided",
        "path": relative(source, root),
        "sha256": sha256(source),
        "bytes": source.stat().st_size,
        "originalSize": {"width": original.width, "height": original.height},
        "normalizedPath": relative(normalized_path, root),
        "normalizedSha256": sha256(normalized_path),
        "normalizedSize": {"width": target_width, "height": target_height},
    }
    title = next(
        (
            line["text"]
            for line in lines
            if line["confidence"] >= threshold
        ),
        f"Reconstructed slide {slide_index}",
    )
    slide = {
        "id": slide_id,
        "order": slide_index,
        "title": title,
        "sourceRef": source_record["id"],
        "background": rgb_hex(background),
        "palette": palette,
        "sizePx": {"width": target_width, "height": target_height},
        "objects": objects,
        "componentInferences": component_inferences(shapes, connectors),
        "annotation": relative(annotation_path, root),
        "degradations": degradations,
    }
    ocr = {
        "slideId": slide_id,
        "sourceRef": source_record["id"],
        "status": "ok",
        "threshold": threshold,
        "words": words,
        "lines": lines,
        "lowConfidenceCount": len(low_lines),
        "annotation": relative(annotation_path, root),
    }
    return slide, ocr, [source_record]


def build_analysis(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any]]:
    if not args.images:
        fail("E_INPUT_REQUIRED", "at least one image is required")
    if not 0 <= args.ocr_threshold <= 1:
        fail("E_CONTRACT", "--ocr-threshold must be in [0,1]")
    root = args.package_root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    runtime = validate_ocr_runtime(args.langs)
    loaded = [(path, load_source(path)) for path in args.images]
    ratios = [image.width / image.height for _, image in loaded]
    if max(ratios) / min(ratios) > 1.01:
        fail(
            "E_PAGE_RATIO_MISMATCH",
            "all pages must share one aspect ratio within one percent",
        )
    ratio = ratios[0]
    target_height = round(CANONICAL_WIDTH_PX / ratio)
    target_size = (CANONICAL_WIDTH_PX, target_height)
    slide_height_in = SLIDE_WIDTH_IN / ratio
    slides: list[dict[str, Any]] = []
    ocr_slides: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    for index, (source, _) in enumerate(loaded, 1):
        normalized = root / "evidence" / "reference" / f"slide-{index:03d}.png"
        slide, ocr, source_records = analyze_slide(
            source.resolve(),
            normalized,
            index,
            root,
            args.assets_dir.resolve(),
            args.annotations_dir.resolve(),
            args.langs,
            args.ocr_threshold,
            target_size,
        )
        slides.append(slide)
        ocr_slides.append(ocr)
        sources.extend(source_records)
    all_palette = Counter(
        color["hex"] for slide in slides for color in slide["palette"][:5]
    )
    common = [item for item, _ in all_palette.most_common(6)]
    tokens = {
        "version": "1.0.0",
        "source": "extracted-from-reference-images",
        "colors": {
            "background": slides[0]["background"],
            "primary": next(
                (color for color in common if color != slides[0]["background"]),
                "#172033",
            ),
            "palette": common,
        },
        "typography": {"primary": "Arial", "fallbacks": ["Liberation Sans", "Noto Sans"]},
        "page": {
            "widthPx": target_size[0],
            "heightPx": target_size[1],
            "widthIn": round(SLIDE_WIDTH_IN, 4),
            "heightIn": round(slide_height_in, 4),
        },
    }
    degradations = [item for slide in slides for item in slide["degradations"]]
    analysis = {
        "version": VERSION,
        "kind": "image-reconstruction-analysis",
        "generator": "image-to-pptx",
        "deck": {
            "id": "image-reconstruction",
            "title": args.title,
            "size": {
                "widthPx": target_size[0],
                "heightPx": target_size[1],
                "widthIn": round(SLIDE_WIDTH_IN, 4),
                "heightIn": round(slide_height_in, 4),
            },
        },
        "ocr": {
            **runtime,
            "threshold": args.ocr_threshold,
            "policy": "visible text only; below-threshold text remains a local crop",
        },
        "sources": sources,
        "slides": slides,
        "designTokens": tokens,
        "degradations": degradations,
        "editabilityTarget": {"minimumLevel": 3, "wholeSlideRasterAllowed": False},
    }
    ocr_report = {
        "version": VERSION,
        "engine": runtime,
        "threshold": args.ocr_threshold,
        "slides": ocr_slides,
        "summary": {
            "lineCount": sum(len(item["lines"]) for item in ocr_slides),
            "lowConfidenceCount": sum(item["lowConfidenceCount"] for item in ocr_slides),
            "unverifiedTextCount": sum(item["lowConfidenceCount"] for item in ocr_slides),
        },
    }
    return analysis, ocr_report


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("images", nargs="+", type=Path)
    parser.add_argument("--package-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--ocr-report", required=True, type=Path)
    parser.add_argument("--assets-dir", required=True, type=Path)
    parser.add_argument("--annotations-dir", required=True, type=Path)
    parser.add_argument("--title", default="Image reconstruction")
    parser.add_argument("--langs", default="eng")
    parser.add_argument("--ocr-threshold", type=float, default=0.70)
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()
    try:
        analysis, ocr_report = build_analysis(args)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.ocr_report.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(analysis, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        args.ocr_report.write_text(
            json.dumps(ocr_report, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(
            json.dumps(
                {
                    "status": "ok",
                    "analysis": str(args.output.resolve()),
                    "ocrReport": str(args.ocr_report.resolve()),
                    "slideCount": len(analysis["slides"]),
                }
            )
        )
    except AnalysisError as error:
        print(
            json.dumps(
                {"status": "failed", "code": error.code, "message": str(error)}
            ),
            file=sys.stderr,
        )
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
