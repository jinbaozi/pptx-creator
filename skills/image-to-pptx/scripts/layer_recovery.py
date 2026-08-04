#!/usr/bin/env python3
"""Deterministic masks, local layer evidence, and guarded background repair.

This module intentionally does not perform semantic image generation.  It only
derives evidence from pixels supplied by the caller.  The public
``analyze_layers`` entry point returns JSON-compatible dictionaries so that the
image analyzer can attach the result to its existing source-bound report.

The implementation uses Pillow and the Python standard library.  OpenCV is not
required; no model, network request, or implicit asset download is made.
"""

from __future__ import annotations

import hashlib
import math
from collections import Counter, deque
from dataclasses import dataclass
from statistics import median
from typing import Any, Iterable, Iterator, Mapping, Sequence

try:  # Pillow is a declared Skill dependency, but keep imports graceful.
    from PIL import Image
except ImportError:  # pragma: no cover - exercised only in dependency errors
    Image = None  # type: ignore[assignment]


VERSION = "1.0.0"
DEFAULT_TOLERANCE = 24.0
DEFAULT_ALPHA_THRESHOLD = 8
DEFAULT_MIN_COMPONENT_AREA = 4
DEFAULT_MAX_HOLE_RATIO = 0.0025
DEFAULT_MAX_TOTAL_REPAIR_RATIO = 0.02
DEFAULT_MAX_CONTOUR_POINTS = 512


class LayerRecoveryError(ValueError):
    """Raised for invalid image or mask inputs."""


@dataclass(frozen=True)
class PixelBox:
    """Inclusive-left/top, exclusive-right/bottom pixel bounds."""

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
        return max(0, self.w) * max(0, self.h)

    def as_dict(self) -> dict[str, int]:
        return {"x": int(self.x), "y": int(self.y), "w": int(self.w), "h": int(self.h)}


@dataclass(frozen=True)
class BackgroundRepairResult:
    """Result of a guarded repair pass.

    ``image`` and ``mask`` are Pillow objects for direct callers.  ``to_dict``
    deliberately omits them and is safe to pass to :mod:`json`.
    """

    image: Any
    mask: Any
    status: str
    repairs: tuple[dict[str, Any], ...]
    degradations: tuple[dict[str, Any], ...]
    provenance: dict[str, Any]

    @property
    def output(self) -> Any:
        """Alias used by callers that call the result an output image."""

        return self.image

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "repairs": [dict(item) for item in self.repairs],
            "degradations": [dict(item) for item in self.degradations],
            "provenance": dict(self.provenance),
        }

    def __iter__(self) -> Iterator[Any]:
        """Permit the convenient ``image, report = result`` form."""

        yield self.image
        yield self.to_dict()


def _require_pillow() -> None:
    if Image is None:  # pragma: no cover - depends on environment
        raise LayerRecoveryError("Pillow is required for layer recovery")


def _require_image(image: Any) -> Any:
    _require_pillow()
    if not isinstance(image, Image.Image):
        raise LayerRecoveryError("expected a PIL.Image.Image")
    width, height = image.size
    if width <= 0 or height <= 0:
        raise LayerRecoveryError("image dimensions must be positive")
    return image


def _coerce_rgb(color: Any) -> tuple[int, int, int]:
    if isinstance(color, str):
        value = color.strip().lstrip("#")
        named = {
            "black": "000000",
            "white": "FFFFFF",
            "red": "FF0000",
            "green": "008000",
            "blue": "0000FF",
            "yellow": "FFFF00",
            "gray": "808080",
            "grey": "808080",
            "transparent": "000000",
        }
        value = named.get(value.lower(), value)
        if len(value) == 3:
            value = "".join(char * 2 for char in value)
        if len(value) != 6:
            raise LayerRecoveryError(f"invalid RGB color: {color!r}")
        try:
            return tuple(int(value[index : index + 2], 16) for index in (0, 2, 4))  # type: ignore[return-value]
        except ValueError as error:
            raise LayerRecoveryError(f"invalid RGB color: {color!r}") from error
    try:
        values = tuple(int(round(float(value))) for value in color)
    except (TypeError, ValueError) as error:
        raise LayerRecoveryError(f"invalid RGB color: {color!r}") from error
    if len(values) != 3 or any(value < 0 or value > 255 for value in values):
        raise LayerRecoveryError(f"invalid RGB color: {color!r}")
    return values  # type: ignore[return-value]


def color_distance(left: Sequence[float], right: Sequence[float]) -> float:
    """Euclidean RGB distance, exposed for callers choosing tolerances."""

    values_left = tuple(float(value) for value in left)
    values_right = tuple(float(value) for value in right)
    if len(values_left) != len(values_right):
        raise LayerRecoveryError("colors must have equal dimensions")
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(values_left, values_right)))


def _image_digest(image: Any) -> str:
    image = _require_image(image)
    # Include mode and dimensions so equal pixel bytes from different layouts
    # cannot accidentally share a provenance digest.
    payload = (
        image.mode.encode("ascii", "replace")
        + b"\0"
        + f"{image.width}x{image.height}".encode("ascii")
        + b"\0"
        + image.tobytes()
    )
    return hashlib.sha256(payload).hexdigest()


def image_digest(image: Any) -> str:
    """Return the stable digest used in repair and analysis provenance."""

    return _image_digest(image)


def _sample_edge(image: Any, *, max_samples: int = 2048) -> list[tuple[int, int, int]]:
    rgb = _require_image(image).convert("RGB")
    width, height = rgb.size
    # Keep sample count bounded for very large source images while retaining all
    # four edges and a deterministic order.
    perimeter = max(1, 2 * (width + height) - 4)
    stride = max(1, math.ceil(perimeter / max(1, max_samples)))
    points: list[tuple[int, int]] = []
    points.extend((x, 0) for x in range(0, width, stride))
    if height > 1:
        points.extend((x, height - 1) for x in range(0, width, stride))
    points.extend((0, y) for y in range(stride, max(stride, height - 1), stride))
    if width > 1:
        points.extend((width - 1, y) for y in range(stride, max(stride, height - 1), stride))
    pixels = rgb.load()
    return [tuple(int(value) for value in pixels[x, y]) for x, y in points]


def _estimate_background(image: Any, *, tolerance: float = DEFAULT_TOLERANCE) -> dict[str, Any]:
    rgb = _require_image(image).convert("RGB")
    samples = _sample_edge(rgb)
    if not samples:
        samples = [tuple(int(value) for value in rgb.getpixel((0, 0)))]
    # Quantization makes anti-aliased edge colors vote for the same candidate;
    # medians restore a representative color without inventing a palette.
    bin_width = max(1, int(round(max(1.0, tolerance) / 3.0)))
    bins: Counter[tuple[int, int, int]] = Counter()
    for sample in samples:
        key = tuple(min(255, max(0, int(round(value / bin_width) * bin_width))) for value in sample)
        bins[key] += 1
    key, dominant_count = bins.most_common(1)[0]
    in_cluster = [sample for sample in samples if color_distance(sample, key) <= max(1.0, tolerance)]
    color = tuple(int(round(median([sample[index] for sample in in_cluster]))) for index in range(3))
    mean_distance = sum(color_distance(sample, color) for sample in in_cluster) / max(1, len(in_cluster))
    confidence = min(1.0, max(0.0, (dominant_count / max(1, len(samples))) * (1.0 - mean_distance / 255.0)))
    return {
        "rgb": color,
        "hex": "#{:02X}{:02X}{:02X}".format(*color),
        "samples": len(samples),
        "dominantShare": round(dominant_count / max(1, len(samples)), 6),
        "meanDistance": round(mean_distance, 4),
        "confidence": round(confidence, 6),
        "source": "edge-samples",
    }


def estimate_background_color(image: Any, *, tolerance: float = DEFAULT_TOLERANCE) -> tuple[int, int, int]:
    """Estimate a solid background color from deterministic edge samples."""

    return tuple(_estimate_background(image, tolerance=tolerance)["rgb"])  # type: ignore[return-value]


# Short aliases are intentionally kept for direct imports from older callers.
background_color = estimate_background_color


def _alpha_values(image: Any) -> Any:
    image = _require_image(image)
    if "A" in image.getbands():
        return image.getchannel("A")
    return None


def alpha_mask(image: Any, *, alpha_threshold: int = DEFAULT_ALPHA_THRESHOLD) -> Any:
    """Return a binary foreground mask from an image alpha channel.

    Images without alpha are treated as fully opaque; use ``foreground_mask``
    when RGB background subtraction is desired.
    """

    image = _require_image(image)
    if not 0 <= int(alpha_threshold) <= 255:
        raise LayerRecoveryError("alpha_threshold must be between 0 and 255")
    alpha = _alpha_values(image)
    if alpha is None:
        return Image.new("L", image.size, 255)
    threshold = int(alpha_threshold)
    return alpha.point(lambda value: 255 if value > threshold else 0, mode="L")


def foreground_mask(
    image: Any,
    *,
    background: Sequence[int] | str | None = None,
    tolerance: float = DEFAULT_TOLERANCE,
    alpha_threshold: int = DEFAULT_ALPHA_THRESHOLD,
) -> Any:
    """Build a conservative binary foreground mask.

    Explicit alpha is authoritative for transparent pixels.  Opaque RGB pixels
    are compared with a solid edge-derived background using ``tolerance``.
    """

    image = _require_image(image)
    if tolerance < 0:
        raise LayerRecoveryError("tolerance must be non-negative")
    # An existing alpha channel is stronger evidence than RGB edge subtraction
    # (transparent PNGs often carry arbitrary RGB bytes).  Callers can still
    # request RGB background subtraction explicitly by supplying ``background``.
    if _alpha_values(image) is not None and background is None:
        return alpha_mask(image, alpha_threshold=alpha_threshold)
    rgb = image.convert("RGB")
    bg = _coerce_rgb(background) if background is not None else estimate_background_color(rgb, tolerance=tolerance)
    alpha = _alpha_values(image)
    rgb_pixels = rgb.load()
    alpha_pixels = alpha.load() if alpha is not None else None
    result = bytearray(image.width * image.height)
    for y in range(image.height):
        row_offset = y * image.width
        for x in range(image.width):
            index = row_offset + x
            if alpha_pixels is not None and int(alpha_pixels[x, y]) <= int(alpha_threshold):
                result[index] = 0
            else:
                result[index] = 255 if color_distance(rgb_pixels[x, y], bg) > float(tolerance) else 0
    return Image.frombytes("L", image.size, bytes(result))


# ``build_*`` is a descriptive alias used by integration callers.
build_foreground_mask = foreground_mask
build_alpha_mask = alpha_mask


def _coerce_box(value: Any, width: int, height: int) -> PixelBox | None:
    if isinstance(value, PixelBox):
        box = value
    elif isinstance(value, Mapping):
        payload = value.get("pixelBox", value.get("box", value))
        if not isinstance(payload, Mapping):
            return None
        try:
            box = PixelBox(int(payload["x"]), int(payload["y"]), int(payload["w"]), int(payload["h"]))
        except (KeyError, TypeError, ValueError):
            return None
    elif all(hasattr(value, name) for name in ("x", "y", "w", "h")):
        try:
            box = PixelBox(int(value.x), int(value.y), int(value.w), int(value.h))
        except (TypeError, ValueError):
            return None
    else:
        try:
            x, y, w, h = value
            box = PixelBox(int(x), int(y), int(w), int(h))
        except (TypeError, ValueError):
            return None
    x = max(0, min(width, box.x))
    y = max(0, min(height, box.y))
    right = max(x, min(width, box.right))
    bottom = max(y, min(height, box.bottom))
    if right <= x or bottom <= y:
        return None
    return PixelBox(x, y, right - x, bottom - y)


def _binary_mask(mask: Any, *, threshold: int = 128) -> Any:
    _require_pillow()
    if not isinstance(mask, Image.Image):
        raise LayerRecoveryError("expected a PIL image mask")
    if mask.mode != "L":
        mask = mask.convert("L")
    return mask.point(lambda value: 255 if value >= int(threshold) else 0, mode="L")


def _sampled_contour(points: Sequence[tuple[int, int]], max_points: int) -> list[list[int]]:
    if max_points <= 0 or len(points) <= max_points:
        return [[int(x), int(y)] for x, y in points]
    stride = math.ceil(len(points) / max_points)
    sampled = points[::stride][:max_points]
    return [[int(x), int(y)] for x, y in sampled]


def label_components(
    mask: Any,
    *,
    threshold: int = 128,
    connectivity: int = 8,
    min_area: int = DEFAULT_MIN_COMPONENT_AREA,
    max_contour_points: int = DEFAULT_MAX_CONTOUR_POINTS,
) -> list[dict[str, Any]]:
    """Label binary mask components and return deterministic JSON records."""

    binary = _binary_mask(mask, threshold=threshold)
    if connectivity not in (4, 8):
        raise LayerRecoveryError("connectivity must be 4 or 8")
    if min_area < 1:
        raise LayerRecoveryError("min_area must be positive")
    width, height = binary.size
    pixels = binary.load()
    visited = bytearray(width * height)
    neighbor_deltas = ((-1, 0), (1, 0), (0, -1), (0, 1))
    if connectivity == 8:
        neighbor_deltas = neighbor_deltas + ((-1, -1), (-1, 1), (1, -1), (1, 1))
    raw: list[dict[str, Any]] = []

    for y in range(height):
        for x in range(width):
            start = y * width + x
            if visited[start] or int(pixels[x, y]) < 128:
                continue
            visited[start] = 1
            queue: deque[int] = deque([start])
            points: list[tuple[int, int]] = []
            min_x = max_x = x
            min_y = max_y = y
            while queue:
                current = queue.popleft()
                px, py = current % width, current // width
                points.append((px, py))
                min_x, max_x = min(min_x, px), max(max_x, px)
                min_y, max_y = min(min_y, py), max(max_y, py)
                for dx, dy in neighbor_deltas:
                    nx, ny = px + dx, py + dy
                    if nx < 0 or ny < 0 or nx >= width or ny >= height:
                        continue
                    index = ny * width + nx
                    if not visited[index] and int(pixels[nx, ny]) >= 128:
                        visited[index] = 1
                        queue.append(index)
            area = len(points)
            if area < min_area:
                continue
            point_set = set(points)
            boundary = [
                (px, py)
                for px, py in points
                if any((px + dx, py + dy) not in point_set for dx, dy in neighbor_deltas[:4])
            ]
            box = PixelBox(min_x, min_y, max_x - min_x + 1, max_y - min_y + 1)
            perimeter = len(boundary)
            raw.append(
                {
                    "_top": min_y,
                    "_left": min_x,
                    "_area": area,
                    "box": box,
                    "area": area,
                    "centroid": {
                        "x": round(sum(px for px, _ in points) / area, 4),
                        "y": round(sum(py for _, py in points) / area, 4),
                    },
                    "fillRatio": round(area / max(1, box.area), 6),
                    "perimeterPx": perimeter,
                    "contour": _sampled_contour(boundary, max_contour_points),
                }
            )

    raw.sort(key=lambda item: (item["_top"], item["_left"], -item["_area"]))
    result: list[dict[str, Any]] = []
    for index, item in enumerate(raw, 1):
        box = item.pop("box")
        item.pop("_top", None)
        item.pop("_left", None)
        item.pop("_area", None)
        item["id"] = f"component-{index:03d}"
        item["box"] = box.as_dict()
        item["pixelBox"] = box.as_dict()
        item["maskConfidence"] = round(min(1.0, max(0.0, float(item["fillRatio"]))), 6)
        result.append(item)
    return result


def _color_components(
    image: Any,
    *,
    tolerance: float = DEFAULT_TOLERANCE,
    connectivity: int = 4,
    min_area: int = DEFAULT_MIN_COMPONENT_AREA,
    max_contour_points: int = DEFAULT_MAX_CONTOUR_POINTS,
) -> list[dict[str, Any]]:
    source = _require_image(image).convert("RGB")
    if tolerance < 0:
        raise LayerRecoveryError("tolerance must be non-negative")
    width, height = source.size
    pixels = source.load()
    visited = bytearray(width * height)
    deltas = [(-1, 0), (1, 0), (0, -1), (0, 1)]
    if connectivity == 8:
        deltas.extend(((-1, -1), (-1, 1), (1, -1), (1, 1)))
    if connectivity not in (4, 8):
        raise LayerRecoveryError("connectivity must be 4 or 8")
    records: list[dict[str, Any]] = []
    for y in range(height):
        for x in range(width):
            start = y * width + x
            if visited[start]:
                continue
            seed = tuple(int(value) for value in pixels[x, y])
            visited[start] = 1
            queue: deque[int] = deque([start])
            points: list[tuple[int, int]] = []
            while queue:
                current = queue.popleft()
                px, py = current % width, current // width
                points.append((px, py))
                for dx, dy in deltas:
                    nx, ny = px + dx, py + dy
                    if nx < 0 or ny < 0 or nx >= width or ny >= height:
                        continue
                    index = ny * width + nx
                    if visited[index]:
                        continue
                    candidate = tuple(int(value) for value in pixels[nx, ny])
                    if color_distance(seed, candidate) <= float(tolerance):
                        visited[index] = 1
                        queue.append(index)
            if len(points) < min_area:
                continue
            point_set = set(points)
            boundary = [
                (px, py)
                for px, py in points
                if any((px + dx, py + dy) not in point_set for dx, dy in deltas[:4])
            ]
            min_x, max_x = min(px for px, _ in points), max(px for px, _ in points)
            min_y, max_y = min(py for _, py in points), max(py for _, py in points)
            box = PixelBox(min_x, min_y, max_x - min_x + 1, max_y - min_y + 1)
            records.append(
                {
                    "_top": min_y,
                    "_left": min_x,
                    "_area": len(points),
                    "box": box,
                    "area": len(points),
                    "centroid": {
                        "x": round(sum(px for px, _ in points) / len(points), 4),
                        "y": round(sum(py for _, py in points) / len(points), 4),
                    },
                    "fillRatio": round(len(points) / max(1, box.area), 6),
                    "perimeterPx": len(boundary),
                    "contour": _sampled_contour(boundary, max_contour_points),
                    "meanColor": [
                        round(sum(pixels[px, py][channel] for px, py in points) / len(points), 4)
                        for channel in range(3)
                    ],
                }
            )
    records.sort(key=lambda item: (item["_top"], item["_left"], -item["_area"]))
    output: list[dict[str, Any]] = []
    for index, item in enumerate(records, 1):
        box = item.pop("box")
        item.pop("_top", None)
        item.pop("_left", None)
        item.pop("_area", None)
        item["id"] = f"component-{index:03d}"
        item["box"] = box.as_dict()
        item["pixelBox"] = box.as_dict()
        item["maskConfidence"] = round(min(1.0, max(0.0, float(item["fillRatio"]))), 6)
        output.append(item)
    return output


def connected_components(
    source: Any,
    *,
    tolerance: float = DEFAULT_TOLERANCE,
    connectivity: int = 8,
    min_area: int = DEFAULT_MIN_COMPONENT_AREA,
    max_contour_points: int = DEFAULT_MAX_CONTOUR_POINTS,
) -> list[dict[str, Any]]:
    """Label a mask or an image using deterministic, tolerance-aware flooding.

    Pillow ``L`` masks are treated as binary masks.  RGB/RGBA images use color
    distance to the component seed, which is useful for simple flat assets and
    does not require OpenCV.
    """

    _require_pillow()
    if isinstance(source, Image.Image) and source.mode in {"1", "L", "LA", "I", "F"}:
        return label_components(
            source,
            connectivity=connectivity,
            min_area=min_area,
            max_contour_points=max_contour_points,
        )
    return _color_components(
        source,
        tolerance=tolerance,
        connectivity=connectivity,
        min_area=min_area,
        max_contour_points=max_contour_points,
    )


tolerant_components = connected_components
extract_components = connected_components
find_connected_components = connected_components


def contours(mask: Any, *, threshold: int = 128, connectivity: int = 8, min_area: int = 1) -> list[list[list[int]]]:
    """Return bounded row-major contour point lists for a binary mask."""

    return [item["contour"] for item in label_components(mask, threshold=threshold, connectivity=connectivity, min_area=min_area)]


find_contours = contours


def _intersection(left: PixelBox, right: PixelBox) -> int:
    return max(0, min(left.right, right.right) - max(left.x, right.x)) * max(
        0, min(left.bottom, right.bottom) - max(left.y, right.y)
    )


def _contains(outer: PixelBox, inner: PixelBox) -> bool:
    return (
        outer.x <= inner.x
        and outer.y <= inner.y
        and outer.right >= inner.right
        and outer.bottom >= inner.bottom
        and outer.area > inner.area
    )


def _layer_records(components: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for index, item in enumerate(components):
        box = _coerce_box(item, 10**12, 10**12)
        if box is None:
            continue
        identifier = str(item.get("id") or f"component-{index + 1:03d}")
        explicit_z: float | None
        try:
            explicit_z = float(item["z"]) if item.get("z") is not None else None
        except (TypeError, ValueError):
            explicit_z = None
        item_type = str(item.get("type") or item.get("role") or "component").lower()
        records.append(
            {
                "id": identifier,
                "box": box,
                "area": int(item.get("area") or box.area),
                "type": item_type,
                "explicitZ": explicit_z,
                "source": item,
            }
        )
    return records


def infer_layers(components: Sequence[Mapping[str, Any]], *, image_size: tuple[int, int] | None = None) -> dict[str, Any]:
    """Infer conservative occlusion edges and a stable back-to-front order.

    Pixel evidence cannot prove hidden geometry.  Edges are therefore emitted
    only for bounding-box containment, explicit source ``z`` values, or a
    text-overlap convention; uncertain partial overlaps are recorded with low
    confidence but never used to fabricate content.
    """

    records = _layer_records(components)
    role_rank = {"background": 0, "image": 10, "photo": 10, "shape": 20, "component": 20, "connector": 30, "line": 30, "text": 40}
    base_key = lambda record: (
        record["explicitZ"] is None,
        record["explicitZ"] if record["explicitZ"] is not None else role_rank.get(record["type"], 20),
        -record["area"],
        record["box"].y,
        record["box"].x,
        record["id"],
    )
    edge_map: dict[tuple[str, str], dict[str, Any]] = {}

    def add_edge(behind: dict[str, Any], front: dict[str, Any], confidence: float, reason: str) -> None:
        if behind["id"] == front["id"]:
            return
        key = (behind["id"], front["id"])
        candidate = {
            "behind": behind["id"],
            "front": front["id"],
            "confidence": round(float(confidence), 6),
            "reason": reason,
            "factStatus": "inferred",
        }
        previous = edge_map.get(key)
        if previous is None or candidate["confidence"] > previous["confidence"]:
            edge_map[key] = candidate

    for index, left in enumerate(records):
        for right in records[index + 1 :]:
            if left["explicitZ"] is not None and right["explicitZ"] is not None and left["explicitZ"] != right["explicitZ"]:
                add_edge(left, right, 1.0, "explicit-z") if left["explicitZ"] < right["explicitZ"] else add_edge(right, left, 1.0, "explicit-z")
                continue
            overlap = _intersection(left["box"], right["box"])
            if overlap <= 0:
                continue
            if _contains(left["box"], right["box"]):
                add_edge(left, right, 0.88, "strict-containment")
            elif _contains(right["box"], left["box"]):
                add_edge(right, left, 0.88, "strict-containment")
            elif left["type"] == "text" or right["type"] == "text":
                text, other = (left, right) if left["type"] == "text" else (right, left)
                add_edge(other, text, 0.72, "text-overlap")
            else:
                ratio = overlap / max(1, min(left["box"].area, right["box"].area))
                if ratio >= 0.20:
                    behind, front = (left, right) if left["area"] >= right["area"] else (right, left)
                    add_edge(behind, front, min(0.65, 0.45 + ratio / 5.0), "partial-overlap-area-order")

    # Stable topological sort: high-confidence evidence is represented by edges,
    # while queue tie-breaking remains deterministic for disconnected objects.
    by_id = {record["id"]: record for record in records}
    outgoing: dict[str, set[str]] = {record["id"]: set() for record in records}
    incoming: dict[str, set[str]] = {record["id"]: set() for record in records}
    for edge in edge_map.values():
        if edge["behind"] in outgoing and edge["front"] in incoming:
            outgoing[edge["behind"]].add(edge["front"])
            incoming[edge["front"]].add(edge["behind"])
    queue = sorted((identifier for identifier, dependencies in incoming.items() if not dependencies), key=lambda identifier: base_key(by_id[identifier]))
    order: list[str] = []
    while queue:
        identifier = queue.pop(0)
        order.append(identifier)
        for child in sorted(outgoing[identifier], key=lambda value: base_key(by_id[value])):
            incoming[child].discard(identifier)
            if not incoming[child]:
                queue.append(child)
        queue.sort(key=lambda value: base_key(by_id[value]))
    cycle = len(order) != len(records)
    if cycle:
        # A contradictory inferred graph is unsafe to resolve semantically.  Use
        # only the documented stable fallback and expose the finding to callers.
        remaining = sorted((identifier for identifier in by_id if identifier not in order), key=lambda identifier: base_key(by_id[identifier]))
        order.extend(remaining)

    layers: list[dict[str, Any]] = []
    for z, identifier in enumerate(order):
        source = by_id[identifier]["source"]
        item = {key: value for key, value in source.items() if key not in {"z", "pixelBox", "box"}}
        box_dict = by_id[identifier]["box"].as_dict()
        item.update({"id": identifier, "box": box_dict, "pixelBox": box_dict, "z": z})
        item["maskConfidence"] = round(float(source.get("maskConfidence", source.get("confidence", 0.5))), 6)
        layers.append(item)

    findings: list[dict[str, Any]] = []
    if cycle:
        findings.append({"code": "OCCLUSION_CYCLE", "severity": "degraded", "message": "Inferred occlusion edges contained a cycle; stable fallback order used", "factStatus": "inferred"})
    return {
        "layers": layers,
        "occlusionEdges": sorted(edge_map.values(), key=lambda edge: (edge["behind"], edge["front"])),
        "stableOrder": order,
        "findings": findings,
        "stable": not cycle,
    }


stable_z_order = infer_layers
infer_occlusion = infer_layers
infer_occlusion_layers = infer_layers
build_occlusion_graph = infer_layers


def find_mask_holes(mask: Any, *, threshold: int = 128, connectivity: int = 4, min_area: int = 1) -> list[dict[str, Any]]:
    """Find enclosed background regions in a binary foreground mask."""

    binary = _binary_mask(mask, threshold=threshold)
    if connectivity not in (4, 8):
        raise LayerRecoveryError("connectivity must be 4 or 8")
    width, height = binary.size
    pixels = binary.load()
    visited = bytearray(width * height)
    deltas = [(-1, 0), (1, 0), (0, -1), (0, 1)]
    if connectivity == 8:
        deltas.extend(((-1, -1), (-1, 1), (1, -1), (1, 1)))
    holes: list[dict[str, Any]] = []
    for y in range(height):
        for x in range(width):
            start = y * width + x
            if visited[start] or int(pixels[x, y]) >= 128:
                continue
            visited[start] = 1
            queue: deque[int] = deque([start])
            points: list[tuple[int, int]] = []
            touches_boundary = False
            while queue:
                current = queue.popleft()
                px, py = current % width, current // width
                points.append((px, py))
                if px in (0, width - 1) or py in (0, height - 1):
                    touches_boundary = True
                for dx, dy in deltas:
                    nx, ny = px + dx, py + dy
                    if nx < 0 or ny < 0 or nx >= width or ny >= height:
                        continue
                    index = ny * width + nx
                    if not visited[index] and int(pixels[nx, ny]) < 128:
                        visited[index] = 1
                        queue.append(index)
            if touches_boundary or len(points) < min_area:
                continue
            min_x, max_x = min(px for px, _ in points), max(px for px, _ in points)
            min_y, max_y = min(py for _, py in points), max(py for _, py in points)
            box = PixelBox(min_x, min_y, max_x - min_x + 1, max_y - min_y + 1)
            holes.append({"_top": min_y, "_left": min_x, "_area": len(points), "box": box, "area": len(points), "pixels": points})
    holes.sort(key=lambda item: (item["_top"], item["_left"], -item["_area"]))
    output: list[dict[str, Any]] = []
    for index, hole in enumerate(holes, 1):
        box = hole.pop("box")
        hole.pop("_top", None)
        hole.pop("_left", None)
        hole.pop("_area", None)
        hole["id"] = f"hole-{index:03d}"
        hole["box"] = box.as_dict()
        hole["pixelBox"] = box.as_dict()
        # Keep internal points private; callers can inspect area/box while report
        # builders avoid accidentally emitting a large pixel list.
        hole.pop("pixels", None)
        output.append(hole)
    return output


def _hole_points(mask: Any, *, threshold: int = 128, connectivity: int = 4) -> list[tuple[dict[str, Any], list[tuple[int, int]]]]:
    """Internal hole finder retaining point lists for a repair pass."""

    binary = _binary_mask(mask, threshold=threshold)
    width, height = binary.size
    pixels = binary.load()
    visited = bytearray(width * height)
    deltas = [(-1, 0), (1, 0), (0, -1), (0, 1)]
    if connectivity == 8:
        deltas.extend(((-1, -1), (-1, 1), (1, -1), (1, 1)))
    results: list[tuple[dict[str, Any], list[tuple[int, int]]]] = []
    for y in range(height):
        for x in range(width):
            start = y * width + x
            if visited[start] or int(pixels[x, y]) >= 128:
                continue
            visited[start] = 1
            queue: deque[int] = deque([start])
            points: list[tuple[int, int]] = []
            touches = False
            while queue:
                current = queue.popleft()
                px, py = current % width, current // width
                points.append((px, py))
                touches = touches or px in (0, width - 1) or py in (0, height - 1)
                for dx, dy in deltas:
                    nx, ny = px + dx, py + dy
                    if 0 <= nx < width and 0 <= ny < height:
                        index = ny * width + nx
                        if not visited[index] and int(pixels[nx, ny]) < 128:
                            visited[index] = 1
                            queue.append(index)
            if touches:
                continue
            min_x, max_x = min(px for px, _ in points), max(px for px, _ in points)
            min_y, max_y = min(py for _, py in points), max(py for _, py in points)
            results.append(({"area": len(points), "box": PixelBox(min_x, min_y, max_x - min_x + 1, max_y - min_y + 1)}, points))
    return results


def _median_color(colors: Sequence[Sequence[int]]) -> tuple[int, int, int] | None:
    if not colors:
        return None
    return tuple(int(round(median([int(color[index]) for color in colors]))) for index in range(3))  # type: ignore[return-value]


def _ring_colors(image: Any, points: set[tuple[int, int]], box: PixelBox) -> list[tuple[int, int, int]]:
    rgb = image.convert("RGB")
    pixels = rgb.load()
    colors: list[tuple[int, int, int]] = []
    # A one-pixel ring around the component's bounds is intentionally used: it
    # avoids touching arbitrary pixels far away and remains deterministic.
    for y in range(max(0, box.y - 1), min(rgb.height, box.bottom + 1)):
        for x in range(max(0, box.x - 1), min(rgb.width, box.right + 1)):
            if (x, y) in points:
                continue
            if x in (box.x - 1, box.right) or y in (box.y - 1, box.bottom):
                colors.append(tuple(int(value) for value in pixels[x, y]))
    return colors


def _box_intersects_any(box: PixelBox, boxes: Iterable[Any], width: int, height: int) -> bool:
    return any((candidate := _coerce_box(value, width, height)) is not None and _intersection(box, candidate) > 0 for value in boxes)


def _set_pixels(image: Any, points: Sequence[tuple[int, int]], color: tuple[int, int, int]) -> Any:
    output = image.copy()
    if "A" in output.getbands():
        rgba = output.convert("RGBA")
        pixels = rgba.load()
        for x, y in points:
            pixels[x, y] = (color[0], color[1], color[2], 255)
        return rgba.convert(output.mode)
    rgb = output.convert("RGB")
    pixels = rgb.load()
    for x, y in points:
        pixels[x, y] = color
    return rgb.convert(output.mode)


def repair_background_holes(
    image: Any,
    mask: Any | None = None,
    *,
    text_boxes: Iterable[Any] = (),
    background: Sequence[int] | str | None = None,
    tolerance: float = DEFAULT_TOLERANCE,
    max_hole_ratio: float = DEFAULT_MAX_HOLE_RATIO,
    max_hole_area: int | None = None,
    max_total_ratio: float = DEFAULT_MAX_TOTAL_REPAIR_RATIO,
    source_ref: str | None = None,
    source_sha256: str | None = None,
) -> BackgroundRepairResult:
    """Repair only enclosed, flat, non-text holes; otherwise fail closed.

    The repair is a solid local median-color fill.  Large, boundary-touching,
    text-overlapping, or high-variance regions are returned as explicit
    degradations and left unchanged.
    """

    source = _require_image(image)
    if tolerance < 0 or max_hole_ratio < 0 or max_total_ratio < 0:
        raise LayerRecoveryError("tolerance and hole ratios must be non-negative")
    binary = _binary_mask(mask if mask is not None else foreground_mask(source, background=background, tolerance=tolerance))
    hole_candidates = _hole_points(binary)
    output = source.copy()
    repair_mask = Image.new("L", source.size, 0)
    repairs: list[dict[str, Any]] = []
    degradations: list[dict[str, Any]] = []
    repaired_area = 0
    # Keep tiny unit-test/assets useful while retaining a ratio guard on normal
    # slides.  The explicit keyword limits still take precedence when a caller
    # needs stricter policy.
    area_limit = max_hole_area if max_hole_area is not None else max(16, int(round(source.width * source.height * max_hole_ratio)))
    total_limit = max(64, int(round(source.width * source.height * max_total_ratio)))
    text_boxes_list = list(text_boxes)
    digest = source_sha256 or _image_digest(source)

    for index, (hole, points) in enumerate(hole_candidates, 1):
        box = hole["box"]
        area = int(hole["area"])
        record_base = {
            "id": f"repair-hole-{index:03d}",
            "box": box.as_dict(),
            "pixelBox": box.as_dict(),
            "area": area,
            "factStatus": "observed",
        }
        reason: str | None = None
        # Text exclusion is checked first so a text-overlapping region is never
        # silently summarized as merely "large"; this preserves the strongest
        # safety reason in the audit trail.
        if _box_intersects_any(box, text_boxes_list, source.width, source.height):
            reason = "text-overlap"
        elif area > area_limit:
            reason = "hole-too-large"
        elif repaired_area + area > total_limit:
            reason = "repair-area-budget-exceeded"
        else:
            ring = _ring_colors(source, set(points), box)
            candidate = _coerce_rgb(background) if background is not None else _median_color(ring)
            if candidate is None or len(ring) < 4:
                reason = "insufficient-background-evidence"
            else:
                spread = max(color_distance(color, candidate) for color in ring)
                if spread > max(1.0, tolerance * 1.5):
                    reason = "background-variance-too-high"
        if reason is not None:
            degradation = {
                **record_base,
                "status": "degraded",
                "reason": reason,
                "editabilityImpact": "unrepaired-region",
                "repairAttempted": True,
                "provenance": {"sourceRef": source_ref, "sourceSha256": digest, "algorithm": "local-median-fill", "version": VERSION},
            }
            degradations.append(degradation)
            continue

        # ``candidate`` and ``ring`` are assigned in the safe branch above.
        points_tuple = tuple(points)
        output = _set_pixels(output, points_tuple, candidate)  # type: ignore[arg-type]
        repair_pixels = repair_mask.load()
        for x, y in points_tuple:
            repair_pixels[x, y] = 255
        repaired_area += area
        repairs.append(
            {
                **record_base,
                "status": "repaired",
                "method": "local-median-fill",
                "fillColor": "#{:02X}{:02X}{:02X}".format(*candidate),  # type: ignore[arg-type]
                "fillRgb": list(candidate),  # type: ignore[arg-type]
                "confidence": round(max(0.0, min(1.0, 1.0 - spread / max(1.0, tolerance * 1.5))), 6),
                "provenance": {"sourceRef": source_ref, "sourceSha256": digest, "algorithm": "local-median-fill", "version": VERSION},
            }
        )

    if repairs and degradations:
        status = "partial"
    elif repairs:
        status = "repaired"
    elif degradations:
        status = "degraded"
    else:
        status = "unchanged"
    provenance = {
        "sourceRef": source_ref,
        "sourceSha256": digest,
        "algorithm": "local-median-fill",
        "version": VERSION,
        "maskDigest": hashlib.sha256(binary.tobytes()).hexdigest(),
        "parameters": {
            "tolerance": float(tolerance),
            "maxHoleRatio": float(max_hole_ratio),
            "maxHoleArea": int(area_limit),
            "maxTotalRatio": float(max_total_ratio),
        },
    }
    return BackgroundRepairResult(output, repair_mask, status, tuple(repairs), tuple(degradations), provenance)


repair_background = repair_background_holes
controlled_background_repair = repair_background_holes
recover_background = repair_background_holes


def analyze_layers(
    image: Any,
    *,
    mask: Any | None = None,
    text_boxes: Iterable[Any] = (),
    background: Sequence[int] | str | None = None,
    tolerance: float = DEFAULT_TOLERANCE,
    alpha_threshold: int = DEFAULT_ALPHA_THRESHOLD,
    min_component_area: int = DEFAULT_MIN_COMPONENT_AREA,
    repair: bool = True,
    source_ref: str | None = None,
    source_sha256: str | None = None,
) -> dict[str, Any]:
    """Analyze one image into a JSON-serializable layer evidence record."""

    source = _require_image(image)
    estimate = _estimate_background(source, tolerance=tolerance)
    effective_background = _coerce_rgb(background) if background is not None else tuple(estimate["rgb"])
    effective_mask = _binary_mask(mask) if mask is not None else foreground_mask(source, background=effective_background, tolerance=tolerance, alpha_threshold=alpha_threshold)
    components = label_components(effective_mask, min_area=min_component_area)
    layer_info = infer_layers(components, image_size=source.size)
    repair_result = repair_background_holes(
        source,
        effective_mask,
        text_boxes=text_boxes,
        background=effective_background,
        tolerance=tolerance,
        source_ref=source_ref,
        source_sha256=source_sha256,
    ) if repair else BackgroundRepairResult(source, Image.new("L", source.size, 0), "disabled", (), (), {"sourceRef": source_ref, "sourceSha256": source_sha256 or _image_digest(source), "algorithm": "local-median-fill", "version": VERSION})

    findings = list(layer_info["findings"])
    for record in repair_result.repairs:
        findings.append({"code": "BACKGROUND_REPAIR_APPLIED", "severity": "info", "componentId": record["id"], "message": "Small enclosed non-text hole repaired with local median color", "factStatus": "observed"})
    for record in repair_result.degradations:
        findings.append({"code": "BACKGROUND_REPAIR_BLOCKED", "severity": "degraded", "componentId": record["id"], "reason": record["reason"], "message": "Unsafe hole left unchanged (fail-closed)", "factStatus": "observed"})

    foreground_pixels = sum(effective_mask.histogram()[128:])
    mask_digest = hashlib.sha256(effective_mask.tobytes()).hexdigest()
    provenance = {
        "sourceRef": source_ref,
        "sourceSha256": source_sha256 or _image_digest(source),
        "imageDigest": _image_digest(source),
        "algorithm": "layer-recovery",
        "version": VERSION,
        "coordinateSpace": "pixels",
        "parameters": {
            "tolerance": float(tolerance),
            "alphaThreshold": int(alpha_threshold),
            "minComponentArea": int(min_component_area),
            "repair": bool(repair),
        },
    }
    background_record = {
        "mode": "solid",
        "color": estimate["hex"] if background is None else "#{:02X}{:02X}{:02X}".format(*effective_background),
        "rgb": list(effective_background),
        "asset": None,
        "source": estimate["source"] if background is None else "caller",
        "confidence": estimate["confidence"],
        "repairStatus": repair_result.status,
        "repair": {
            "status": repair_result.status,
            "appliedCount": len(repair_result.repairs),
            "blockedCount": len(repair_result.degradations),
        },
    }
    return {
        "version": VERSION,
        "kind": "image-layer-analysis",
        "background": background_record,
        "mask": {
            "mode": "L",
            "size": {"width": source.width, "height": source.height},
            "digest": mask_digest,
            "foregroundPixels": foreground_pixels,
            "foregroundShare": round(foreground_pixels / max(1, source.width * source.height), 6),
            "source": "alpha" if _alpha_values(source) is not None else "edge-background-distance",
        },
        "components": components,
        "layers": layer_info["layers"],
        "occlusionEdges": layer_info["occlusionEdges"],
        "stableOrder": layer_info["stableOrder"],
        "findings": findings,
        "repairs": [dict(item) for item in repair_result.repairs],
        "degradations": [dict(item) for item in repair_result.degradations],
        "provenance": provenance,
    }


analyze_image_layers = analyze_layers


__all__ = [
    "VERSION",
    "LayerRecoveryError",
    "PixelBox",
    "BackgroundRepairResult",
    "color_distance",
    "image_digest",
    "estimate_background_color",
    "background_color",
    "alpha_mask",
    "build_alpha_mask",
    "foreground_mask",
    "build_foreground_mask",
    "label_components",
    "connected_components",
    "tolerant_components",
    "extract_components",
    "find_connected_components",
    "contours",
    "find_contours",
    "infer_layers",
    "stable_z_order",
    "infer_occlusion",
    "infer_occlusion_layers",
    "build_occlusion_graph",
    "find_mask_holes",
    "repair_background_holes",
    "repair_background",
    "controlled_background_repair",
    "recover_background",
    "analyze_layers",
    "analyze_image_layers",
]
