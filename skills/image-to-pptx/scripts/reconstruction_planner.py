"""Deterministic, source-bound region route planning for image-to-pptx."""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections import defaultdict
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable


PLAN_VERSION = "1.0.0"
LOSS_VERSION = "1.0.0"
REGION_RASTER_MAX_SHARE = 0.35
NEAR_WHOLE_RASTER_SHARE = 0.65
ROUTE_PRIORITY = {
    "native-all": 0,
    "native-plus-local-assets": 1,
    "bounded-raster": 2,
}
GATE_IDS = (
    "ownership-conflict",
    "unassigned-pixel-budget",
    "route-object-coverage",
    "hybrid-asset-present",
    "bounded-asset-present",
    "near-whole-slide-raster",
    "large-region-raster",
    "raster-high-confidence-text-overlap",
    "native-image-decomposition",
    "observed-content-only",
    "structured-content-traceability",
    "asset-provenance",
)
LOSS_WEIGHTS = {
    "visualMismatch": 4.0,
    "ocrCer": 3.0,
    "bboxIoU": 2.0,
    "normalizedMAE": 1.5,
    "rasterAreaShare": 1.0,
    "objectComplexity": 0.5,
    "overlapPenalty": 1.0,
    "provenancePenalty": 1.0,
}
HEX_DIGEST = re.compile(r"^[0-9a-f]{64}$", re.IGNORECASE)


class ReconstructionPlanError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _area(box: dict[str, Any]) -> float:
    return max(0.0, float(box.get("w", 0))) * max(0.0, float(box.get("h", 0)))


def _intersection(left: dict[str, Any], right: dict[str, Any]) -> float:
    x1 = max(float(left.get("x", 0)), float(right.get("x", 0)))
    y1 = max(float(left.get("y", 0)), float(right.get("y", 0)))
    x2 = min(float(left.get("x", 0)) + float(left.get("w", 0)), float(right.get("x", 0)) + float(right.get("w", 0)))
    y2 = min(float(left.get("y", 0)) + float(left.get("h", 0)), float(right.get("y", 0)) + float(right.get("h", 0)))
    return max(0.0, x2 - x1) * max(0.0, y2 - y1)


def _overlap_ratio(left: dict[str, Any], right: dict[str, Any]) -> float:
    return _intersection(left, right) / max(1.0, min(_area(left), _area(right)))


def _safe_asset_path(asset: dict[str, Any], package_root: str | Path | None) -> Path | None:
    if package_root is None:
        return None
    raw = str(asset.get("mask", ""))
    if not raw or "\x00" in raw:
        return None
    path = Path(raw)
    if path.is_absolute() or ".." in path.parts:
        return None
    root = Path(package_root).resolve()
    resolved = (root / path).resolve()
    try:
        resolved.relative_to(root)
    except ValueError:
        return None
    return resolved


def _mask_alpha(asset: dict[str, Any], package_root: str | Path | None) -> tuple[int, int, bytes] | None:
    """Read a source-bound mask only after path and persisted digest checks."""

    path = _safe_asset_path(asset, package_root)
    if path is None or not path.is_file():
        return None
    try:
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest().lower() != str(asset.get("maskDigest", "")).lower():
            return None
        from PIL import Image  # Pillow is a declared Skill dependency.

        with Image.open(path) as opened:
            mask = opened.convert("L")
            origin = asset.get("originPagePixelBox") or {}
            expected_width = max(1, round(float(origin.get("w", 0))))
            expected_height = max(1, round(float(origin.get("h", 0))))
            if mask.size != (expected_width, expected_height):
                return None
            return mask.width, mask.height, bytes(mask.tobytes())
    except Exception:
        return None


def _asset_text_overlap(
    asset: dict[str, Any],
    text_boxes: list[dict[str, Any]],
    package_root: str | Path | None = None,
) -> tuple[bool, float]:
    """Return visible mask/text overlap after the asset's current transform."""

    page_box = asset.get("pagePixelBox", {})
    origin = asset.get("originPagePixelBox") or {}
    if float(origin.get("w", 0)) <= 0 or float(origin.get("h", 0)) <= 0:
        return True, 1.0
    fallback = max((_overlap_ratio(page_box, box) for box in text_boxes), default=0.0)
    loaded = _mask_alpha(asset, package_root)
    if loaded is None:
        return fallback > 0.0, fallback
    width, height, alpha = loaded
    page_width = float(page_box.get("w", 0))
    page_height = float(page_box.get("h", 0))
    if page_width <= 0 or page_height <= 0:
        return False, 0.0
    overlap_area = 0.0
    for y in range(height):
        for x in range(width):
            if alpha[y * width + x] < 128:
                continue
            cell = {
                "x": float(page_box.get("x", 0)) + x * page_width / width,
                "y": float(page_box.get("y", 0)) + y * page_height / height,
                "w": page_width / width,
                "h": page_height / height,
            }
            overlap_area += max((_intersection(cell, text_box) for text_box in text_boxes), default=0.0)
    denominator = max(1.0, min(_area(page_box), min((_area(box) for box in text_boxes), default=1.0)))
    ratio = overlap_area / denominator
    return overlap_area > 0.0, ratio


def _same_page_box(left: dict[str, Any], right: dict[str, Any]) -> bool:
    return all(abs(float(left.get(key, 0)) - float(right.get(key, 0))) <= 1e-9 for key in ("x", "y", "w", "h"))


def _box_union(refs: Iterable[dict[str, Any]]) -> dict[str, int]:
    boxes = [item.get("pixelBox", item.get("box", {})) for item in refs if item.get("pixelBox", item.get("box"))]
    if not boxes:
        return {"x": 0, "y": 0, "w": 1, "h": 1}
    left = min(float(box.get("x", 0)) for box in boxes)
    top = min(float(box.get("y", 0)) for box in boxes)
    right = max(float(box.get("x", 0)) + float(box.get("w", 0)) for box in boxes)
    bottom = max(float(box.get("y", 0)) + float(box.get("h", 0)) for box in boxes)
    return {"x": round(left), "y": round(top), "w": max(1, round(right - left)), "h": max(1, round(bottom - top))}


def _route_editability(strategy: str, raster_count: int) -> dict[str, Any]:
    if strategy == "native-all":
        return {"level": 5, "mode": "fully-native", "rasterObjectCount": 0}
    if strategy == "native-plus-local-assets":
        return {"level": 4, "mode": "native-plus-transparent-local-assets", "rasterObjectCount": raster_count}
    return {"level": 2, "mode": "bounded-transparent-local-asset", "rasterObjectCount": raster_count}


def _asset_valid(asset: dict[str, Any], sources: dict[str, dict[str, Any]], root: str | None = None) -> tuple[bool, str]:
    path = str(asset.get("asset", ""))
    if not path or path.startswith(("/", "\\")) or ".." in path.replace("\\", "/").split("/"):
        return False, "asset-path-is-absolute-or-traversal"
    origin = asset.get("originPagePixelBox") or {}
    if float(origin.get("w", 0)) <= 0 or float(origin.get("h", 0)) <= 0:
        return False, "asset-origin-page-box-is-missing-or-invalid"
    if not HEX_DIGEST.fullmatch(str(asset.get("assetDigest", ""))) or not HEX_DIGEST.fullmatch(str(asset.get("maskDigest", ""))):
        return False, "asset-digest-is-missing-or-invalid"
    source = sources.get(str(asset.get("sourceRef", "")))
    if not source:
        return False, "asset-source-ref-is-unbound"
    expected_digest = str(source.get("normalizedSha256") or source.get("sha256") or "")
    if expected_digest and (str(asset.get("sourceDigest", "")) != str(asset.get("normalizedSourceDigest", ""))
        or str(asset.get("normalizedSourceDigest", "")) != expected_digest):
        return False, "asset-source-digest-is-unbound"
    return True, "asset-provenance-is-source-bound"


def _source_provenance(
    objects: list[dict[str, Any]],
    assets: list[dict[str, Any]],
    sources: dict[str, dict[str, Any]],
    fallback_source_ref: str | None = None,
) -> dict[str, Any]:
    refs = {str(item.get("sourceRef")) for item in objects + assets if item.get("sourceRef") in sources}
    if fallback_source_ref and fallback_source_ref in sources:
        refs.add(fallback_source_ref)
    source_refs = sorted(refs)
    source_digests = sorted({
        str(sources[ref].get("normalizedSha256") or sources[ref].get("sha256"))
        for ref in source_refs
        if HEX_DIGEST.fullmatch(str(sources[ref].get("normalizedSha256") or sources[ref].get("sha256") or ""))
    })
    asset_digests = sorted({str(item.get("assetDigest")) for item in assets if HEX_DIGEST.fullmatch(str(item.get("assetDigest", "")))})
    return {
        "sourceRefs": source_refs,
        "sourceDigests": source_digests,
        "assetDigests": asset_digests,
        "status": "observed-or-recognized-source-bound",
    }


def _geometry_digest(objects: list[dict[str, Any]], assets: list[dict[str, Any]]) -> str:
    """Digest current object/asset geometry so calibration cannot reuse a
    byte-identical reconstruction plan after a geometry, z, or crop change."""

    object_keys = (
        "id", "type", "z", "pixelBox", "renderBox", "style", "color", "fill",
        "borderColor", "borderWidthPx", "fillOpacity", "transparency", "opacity",
        "rotation", "rotationDeg", "rotate", "flipH", "flipV", "sizing", "crop",
        "asset", "src", "path", "imageShape", "rounding", "text", "fontFamily",
        "fontSizePt", "fontWeight", "bold", "italic", "charSpacingPt", "lineHeightPt",
        "textBoxWidthPx", "lineCount", "paragraph", "paragraphs", "runs", "align",
        "verticalAlign", "margin", "shape", "gradient", "shadow", "line",
    )
    def number_text(value: float | int) -> str:
        if isinstance(value, float):
            if not math.isfinite(value):
                return "null"
            if value == 0.0:
                return "0"
            if value.is_integer() and abs(value) < 1e21:
                return str(int(value))
            text = repr(value)
            magnitude = abs(value)
            # Match ECMAScript Number::toString's decimal/scientific boundary:
            # fixed notation is used for [1e-6, 1e21), scientific notation
            # outside it. Decimal expands Python's padded exponent (e-06)
            # without introducing binary-float artifacts.
            if 1e-6 <= magnitude < 1e21:
                try:
                    text = format(Decimal(text), "f").rstrip("0").rstrip(".")
                    if text in {"", "-0"}:
                        text = "0"
                except (InvalidOperation, ValueError):
                    pass
            elif "e" in text or "E" in text:
                mantissa, exponent = re.split("[eE]", text)
                text = f"{mantissa}e{int(exponent):+d}"
            return text
        return str(value)

    def digest_serialize(value: Any) -> str:
        if value is None:
            return "null"
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, (int, float)):
            return number_text(value)
        if isinstance(value, str):
            return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        if isinstance(value, dict):
            return "{" + ",".join(
                f"{json.dumps(str(key), ensure_ascii=False)}:{digest_serialize(item)}"
                for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
            ) + "}"
        if isinstance(value, (list, tuple)):
            return "[" + ",".join(digest_serialize(item) for item in value) + "]"
        return digest_serialize(str(value))

    payload = {
        "objects": [
            {key: (str(item.get(key)) if key == "id" else (item.get(key) if item.get(key) is not None else 0) if key == "z" else item.get(key)) for key in object_keys}
            for item in sorted(objects, key=lambda value: str(value.get("id", "")))
        ],
        "assets": [
            {
                key: item.get(key)
                for key in ("objectId", "pagePixelBox", "originPagePixelBox", "asset", "mask", "assetDigest", "maskDigest", "sourceRef", "sourceDigest", "normalizedSourceDigest")
            }
            for item in sorted(assets, key=lambda value: str(value.get("objectId", "")))
        ],
    }
    serialized = digest_serialize(payload)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _repair_safety(
    objects: list[dict[str, Any]],
    assets: list[dict[str, Any]],
    ownership: dict[str, Any],
    page_size: tuple[int, int],
    package_root: str | Path | None = None,
) -> dict[str, Any]:
    """Recheck geometry/ownership invariants after every repair mutation."""

    width, height = page_size
    out_of_bounds: list[str] = []
    for item in objects:
        box = item.get("renderBox") if item.get("type") == "text" else item.get("pixelBox")
        if not box:
            continue
        left, top = float(box.get("x", 0)), float(box.get("y", 0))
        right, bottom = left + float(box.get("w", 0)), top + float(box.get("h", 0))
        if left < 0 or top < 0 or right > width or bottom > height or right <= left or bottom <= top:
            out_of_bounds.append(str(item.get("id")))
    text_boxes = [
        item.get("renderBox") or item.get("pixelBox") or {}
        for item in objects
        if item.get("type") == "text" and float(item.get("confidence", 0.0)) >= 0.70
    ]
    overlap_refs: list[str] = []
    for asset in assets:
        # The baseline ownership report is computed from mutually exclusive
        # pixel masks.  Reuse that strict evidence while the asset remains at
        # its immutable origin; a broad text layout box must not create a
        # false conflict for transparent residual pixels.
        if _same_page_box(asset.get("pagePixelBox", {}), asset.get("originPagePixelBox", {})) \
                and float(ownership.get("rasterNativeOverlapPixels", 0)) == 0:
            continue
        overlap, _ = _asset_text_overlap(asset, text_boxes, package_root)
        if overlap:
            overlap_refs.append(str(asset.get("objectId")))
    ownership_conflict = (
        str(ownership.get("status")) == "failed"
        or float(ownership.get("conflictPixels", 0)) > 0
        or float(ownership.get("rasterNativeOverlapPixels", 0)) > 0
        or float(ownership.get("duplicateVisibleContent", 0)) > 0
        or float(ownership.get("unassignedShare", 0.0)) > float(ownership.get("unassignedBudget", 0.0))
    )
    failures = sorted(set(out_of_bounds + overlap_refs))
    return {
        "status": "passed" if not failures and not ownership_conflict else "failed",
        "outOfBoundsObjectRefs": sorted(set(out_of_bounds)),
        "rasterNativeOverlapObjectRefs": sorted(set(overlap_refs)),
        "duplicateRouteClaims": [],
        "ownershipConflict": bool(ownership_conflict),
        "checkedObjectCount": len(objects),
        "checkedAssetCount": len(assets),
    }


def _loss(strategy: str, profile: dict[str, Any], has_text: bool, has_asset: bool, page_area: float, assets: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    role = str(profile.get("role", "decor"))
    complexity = min(1.0, max(0.0, float(profile.get("complexity", {}).get("score", 0.0))))
    image_only = role == "image" and not has_text
    if strategy == "native-all":
        ssim = 0.94 - 0.10 * complexity if not has_asset else 0.72
        cer = 0.0
        bbox = 0.96
        mae = 0.04 + 0.06 * complexity
    elif strategy == "native-plus-local-assets":
        ssim = 0.91 - 0.04 * complexity
        if image_only:
            ssim = 0.74
        cer = 0.0
        bbox = 0.95
        mae = 0.05 + 0.04 * complexity
    else:
        ssim = 0.90 if image_only else 0.78
        cer = 1.0 if has_text else 0.0
        bbox = 0.90
        mae = 0.08
    area_share = (
        sum(_area(item.get("pagePixelBox", {})) for item in (assets or [])) / max(1.0, page_area)
        if has_asset else 0.0
    )
    values = {
        "visualMismatch": round(max(0.0, 1.0 - ssim), 6),
        "ocrCer": round(cer, 6),
        "bboxIoU": round(bbox, 6),
        "normalizedMAE": round(mae, 6),
        "rasterAreaShare": round(area_share, 6),
        "objectComplexity": round(complexity, 6),
        "overlapPenalty": 0.0,
        "provenancePenalty": 0.0,
    }
    total = (
        LOSS_WEIGHTS["visualMismatch"] * values["visualMismatch"]
        + LOSS_WEIGHTS["ocrCer"] * values["ocrCer"]
        + LOSS_WEIGHTS["bboxIoU"] * max(0.0, 1.0 - values["bboxIoU"])
        + LOSS_WEIGHTS["normalizedMAE"] * values["normalizedMAE"]
        + LOSS_WEIGHTS["rasterAreaShare"] * values["rasterAreaShare"]
        + LOSS_WEIGHTS["objectComplexity"] * values["objectComplexity"]
        + LOSS_WEIGHTS["overlapPenalty"] * values["overlapPenalty"]
        + LOSS_WEIGHTS["provenancePenalty"] * values["provenancePenalty"]
    )
    return {
        "version": LOSS_VERSION,
        "estimatedFrom": "analysis",
        "values": values,
        "weights": dict(LOSS_WEIGHTS),
        "total": round(total, 8),
    }


def _gate(gate_id: str, passed: bool, blocking: bool, detail: str) -> dict[str, Any]:
    return {"id": gate_id, "passed": bool(passed), "blocking": bool(blocking), "detail": detail}


def _candidate_gates(
    strategy: str,
    profile: dict[str, Any],
    objects: list[dict[str, Any]],
    assets: list[dict[str, Any]],
    ownership: dict[str, Any],
    sources: dict[str, dict[str, Any]],
    page_area: float,
    assigned_refs: list[str],
    package_root: str | Path | None = None,
) -> list[dict[str, Any]]:
    gates: list[dict[str, Any]] = []
    object_refs = sorted(str(item.get("id")) for item in objects)
    asset_refs = sorted(str(item.get("objectId")) for item in assets)
    high_conf_text = [item for item in objects if item.get("type") == "text" and float(item.get("confidence", 0.0)) >= 0.70]
    has_asset = bool(assets)
    has_text = bool(high_conf_text)
    conflict = any(float(ownership.get(key, 0)) > 0 for key in ("conflictPixels", "rasterNativeOverlapPixels", "duplicateVisibleContent")) or ownership.get("status") == "failed"
    gates.append(_gate("ownership-conflict", not conflict, True, "ownership report has no blocking conflict" if not conflict else "ownership report contains conflict or duplicate claim"))
    gates.append(_gate("unassigned-pixel-budget", float(ownership.get("unassignedShare", 0.0)) <= float(ownership.get("unassignedBudget", 0.0)), True, "ownership unassigned share is within budget"))
    bounded_binding = (
        bool(assets)
        and all(item.get("type") == "image" for item in objects)
        and len(asset_refs) == len(object_refs) == len(set(asset_refs))
        and set(asset_refs) == set(object_refs)
    )
    route_coverage = object_refs == sorted(set(assigned_refs)) and (
        strategy != "bounded-raster" or bounded_binding
    )
    gates.append(_gate("route-object-coverage", route_coverage, True, "route retains every assigned object exactly once" if route_coverage else "route drops or duplicates assigned objects"))
    gates.append(_gate("hybrid-asset-present", strategy != "native-plus-local-assets" or has_asset, True, "hybrid route has at least one local asset" if strategy != "native-plus-local-assets" or has_asset else "hybrid route has no local asset"))
    gates.append(_gate("bounded-asset-present", strategy != "bounded-raster" or bounded_binding, True, "bounded route has one local asset per image object" if strategy != "bounded-raster" or bounded_binding else "bounded route cannot preserve non-image or unbound objects"))
    raster_share = sum(_area(asset.get("pagePixelBox", {})) for asset in assets) / max(1.0, page_area)
    gates.append(_gate("near-whole-slide-raster", raster_share < NEAR_WHOLE_RASTER_SHARE, True, f"asset area share {raster_share:.6f} is below near-whole threshold"))
    gates.append(_gate("large-region-raster", raster_share <= REGION_RASTER_MAX_SHARE, True, f"asset area share {raster_share:.6f} is below bounded threshold"))
    text_boxes = [item.get("renderBox") or item.get("pixelBox") or {} for item in high_conf_text]
    overlap = max((
        0.0
        if _same_page_box(asset.get("pagePixelBox", {}), asset.get("originPagePixelBox", {}))
        and float(ownership.get("rasterNativeOverlapPixels", 0)) == 0
        else _asset_text_overlap(asset, text_boxes, package_root)[1]
        for asset in assets
    ), default=0.0)
    gates.append(_gate("raster-high-confidence-text-overlap", overlap == 0.0, True, "transparent asset does not overlap high-confidence editable text" if overlap == 0.0 else f"asset/text overlap ratio {overlap:.6f}"))
    assets_valid = all(_asset_valid(asset, sources)[0] for asset in assets)
    gates.append(_gate("native-image-decomposition", strategy != "native-all" or not has_asset, True, "native route contains no undecomposed local asset" if strategy != "native-all" or not has_asset else "native-all cannot silently replace an observed local asset"))
    unbound = [item for item in objects if str(item.get("factStatus", "observed")) not in {"provided", "observed", "recognized"}]
    gates.append(_gate("observed-content-only", not unbound, True, "all objects are observed/provided/recognized" if not unbound else "candidate includes inferred or unknown content"))
    structured = [item for item in objects if item.get("type") in {"chart", "table"}]
    traceable = all(bool(item.get("sourceData") and item.get("sourceRef") and item.get("sourceSha256")) for item in structured)
    gates.append(_gate("structured-content-traceability", traceable, True, "chart/table content is source-bound" if traceable else "chart/table data has no source-bound evidence"))
    gates.append(_gate("asset-provenance", assets_valid, True, "all referenced assets are source-bound" if assets_valid else "candidate contains an untraceable asset"))
    if [item["id"] for item in gates] != list(GATE_IDS):
        raise ReconstructionPlanError("E_RECONSTRUCTION_GATES", f"{profile.get('id')} gate universe is not deterministic")
    return gates


def _candidate(
    strategy: str,
    profile: dict[str, Any],
    objects: list[dict[str, Any]],
    assets: list[dict[str, Any]],
    ownership: dict[str, Any],
    sources: dict[str, dict[str, Any]],
    page_area: float,
    assigned_refs: list[str],
    package_root: str | Path | None = None,
) -> dict[str, Any]:
    region_id = str(profile["id"])
    object_refs = sorted(str(item["id"]) for item in objects)
    asset_refs = [str(item.get("objectId")) for item in assets]
    classes = sorted({"raster_asset" if item.get("type") == "image" else "native_text" if item.get("type") == "text" else "native_shape" for item in objects} | ({"raster_asset"} if assets else set()))
    mask_refs = []
    for class_name in classes:
        record = ownership.get("classes", {}).get(class_name, {})
        if record.get("path") and record.get("maskDigest"):
            mask_refs.append({"class": class_name, "path": record["path"], "digest": record["maskDigest"]})
    z_values = [int(item.get("z", 0)) for item in objects]
    gates = _candidate_gates(strategy, profile, objects, assets, ownership, sources, page_area, assigned_refs, package_root)
    eligible = not any(item["blocking"] and not item["passed"] for item in gates)
    loss = _loss(strategy, profile, bool([item for item in objects if item.get("type") == "text"]), bool(assets), page_area, assets)
    return {
        "id": f"{region_id}-{strategy}",
        "strategy": strategy,
        "objectRefs": sorted(set(object_refs)),
        "assetRefs": sorted(set(asset_refs)),
        "pixelBox": dict(profile.get("pixelBox", {})),
        "ownershipClasses": classes,
        "maskRefs": mask_refs,
        "zRange": {"min": min(z_values) if z_values else 0, "max": max(z_values) if z_values else 0},
        "provenance": _source_provenance(objects, assets, sources, str(profile.get("sourceRef", ""))),
        "geometryDigest": _geometry_digest(objects, assets),
        "editability": _route_editability(strategy, len(asset_refs) if strategy != "native-all" else 0),
        "metrics": {"estimatedFrom": "analysis", "regionSSIM": round(1.0 - loss["values"]["visualMismatch"], 6), "ocrCER": loss["values"]["ocrCer"], "bboxIoU": loss["values"]["bboxIoU"], "normalizedMAE": loss["values"]["normalizedMAE"]},
        "lossBreakdown": loss,
        "gateResults": gates,
        "eligible": eligible,
    }


def build_reconstruction_plan(
    slide_id: str,
    page_size: tuple[int, int],
    region_profiles: list[dict[str, Any]],
    objects: list[dict[str, Any]],
    ownership_report: dict[str, Any],
    sources: list[dict[str, Any]],
    route_overrides: dict[str, str] | None = None,
    package_root: str | Path | None = None,
) -> dict[str, Any]:
    """Build a complete page plan; raise instead of silently falling back."""

    width, height = page_size
    page_area = max(1.0, float(width * height))
    source_by_id = {str(item.get("id")): item for item in sources if item.get("id")}
    source_ids = set(source_by_id)
    if not source_by_id:
        raise ReconstructionPlanError("E_RECONSTRUCTION_PROVENANCE", f"{slide_id} has no source-bound source record")
    object_by_id = {str(item.get("id")): item for item in objects if item.get("id")}
    ownership_assets = [item for item in ownership_report.get("assets", []) if item.get("objectId")]
    asset_ids = [str(item.get("objectId")) for item in ownership_assets]
    if len(set(asset_ids)) != len(asset_ids):
        raise ReconstructionPlanError("E_RECONSTRUCTION_COVERAGE", f"{slide_id} ownership assets are duplicated")
    assets_by_object = {str(item.get("objectId")): item for item in ownership_assets}

    # Stable ownership assignment: the smallest containing region wins, then
    # role priority and region id. This prevents overlapping profiles from
    # competing for the same object or asset.
    role_rank = {"title": 0, "text-block": 1, "card-or-native-group": 2, "image": 3, "chart": 4, "table": 5, "background": 6, "decor": 7}
    profiles_by_ref: dict[str, list[dict[str, Any]]] = defaultdict(list)
    profile_ids = [str(profile.get("id")) for profile in region_profiles]
    if len(set(profile_ids)) != len(profile_ids):
        raise ReconstructionPlanError("E_RECONSTRUCTION_COVERAGE", f"{slide_id} region profile ids are duplicated")
    for profile in region_profiles:
        for ref in profile.get("objectRefs", []):
            profiles_by_ref[str(ref)].append(profile)
    profile_refs = {str(ref) for profile in region_profiles for ref in profile.get("objectRefs", [])}
    unknown_profile_refs = sorted(profile_refs - set(object_by_id))
    unknown_asset_refs = sorted(set(assets_by_object) - set(object_by_id))
    if unknown_profile_refs or unknown_asset_refs:
        raise ReconstructionPlanError("E_RECONSTRUCTION_COVERAGE", f"{slide_id} contains untraceable object or asset refs")
    assignment: dict[str, str] = {}
    for ref, profiles in profiles_by_ref.items():
        item = object_by_id.get(ref)
        ranked = sorted(profiles, key=lambda profile: (_area(profile.get("pixelBox", {})), role_rank.get(str(profile.get("role", "decor")), 99), str(profile.get("id", ""))))
        if ranked:
            assignment[ref] = str(ranked[0]["id"])
    owned_assets: dict[str, str] = {ref: assignment[ref] for ref in assets_by_object if ref in assignment}
    unassigned_objects = sorted(set(object_by_id) - set(assignment))
    unassigned_assets = sorted(set(assets_by_object) - set(owned_assets))

    route_overrides = {
        str(key): str(value)
        for key, value in (route_overrides or {}).items()
        if str(key) and str(value) in ROUTE_PRIORITY
    }
    invalid_override_refs = sorted(set(route_overrides) - set(profile_ids))
    if invalid_override_refs:
        raise ReconstructionPlanError("E_RECONSTRUCTION_ROUTE", f"{slide_id} route override references unknown regions: {invalid_override_refs}")
    regions = []
    selected_objects: list[str] = []
    selected_assets: list[str] = []
    for profile in sorted(region_profiles, key=lambda item: str(item.get("id", ""))):
        region_id = str(profile["id"])
        refs = sorted(ref for ref in profile.get("objectRefs", []) if assignment.get(str(ref)) == region_id)
        assets = [assets_by_object[ref] for ref in refs if ref in assets_by_object]
        members = [object_by_id[ref] for ref in refs if ref in object_by_id]
        candidates = [_candidate(strategy, profile, members, assets, ownership_report, source_by_id, page_area, refs, package_root) for strategy in ("native-all", "native-plus-local-assets", "bounded-raster")]
        eligible = [item for item in candidates if item["eligible"]]
        if not eligible:
            raise ReconstructionPlanError("E_RECONSTRUCTION_NO_ELIGIBLE", f"{slide_id}/{region_id} has no eligible reconstruction candidate")
        ranked_eligible = sorted(eligible, key=lambda item: (float(item["lossBreakdown"]["total"]), -int(item["editability"]["level"]), ROUTE_PRIORITY[item["strategy"]], str(item["id"])))
        requested_strategy = route_overrides.get(region_id)
        requested = next((item for item in ranked_eligible if item["strategy"] == requested_strategy), None)
        # A route override is accepted only for an eligible candidate.  The
        # visual repair loop records the measured before/after evidence; this
        # planner remains source-bound and never invents a missing route.
        if requested_strategy and requested is None:
            raise ReconstructionPlanError("E_RECONSTRUCTION_ROUTE", f"{slide_id}/{region_id} route override is not an eligible candidate: {requested_strategy}")
        winner = requested or ranked_eligible[0]
        selected_objects.extend(winner["objectRefs"])
        selected_assets.extend(winner["assetRefs"])
        regions.append({
            "id": region_id,
            "role": profile.get("role", "decor"),
            "pixelBox": dict(profile.get("pixelBox", {})),
            "assignedObjectRefs": refs,
            "assignedAssetRefs": sorted({str(item.get("objectId")) for item in assets}),
            "unassignedObjectRefs": sorted(set(str(ref) for ref in profile.get("objectRefs", [])) - set(refs)),
            "candidates": candidates,
            "winnerId": winner["id"],
        })
    selected_set = sorted(set(selected_objects))
    duplicate_objects = sorted(ref for ref in selected_set if selected_objects.count(ref) > 1)
    selected_asset_set = sorted(set(selected_assets))
    duplicate_assets = sorted(ref for ref in selected_asset_set if selected_assets.count(ref) > 1)
    page_gates = [
        _gate("region-ownership-unique", not duplicate_objects and not duplicate_assets, True, "objects and assets have one selected region winner" if not duplicate_objects and not duplicate_assets else "selected winners overlap object or asset ownership"),
        _gate("page-object-coverage", not unassigned_objects, True, "all observed objects are assigned to a region" if not unassigned_objects else f"unassigned object refs: {unassigned_objects}"),
        _gate("page-asset-coverage", not unassigned_assets, True, "all residual assets are assigned to a region" if not unassigned_assets else f"unassigned asset refs: {unassigned_assets}"),
        _gate("selected-object-coverage", selected_set == sorted(object_by_id) and not duplicate_objects, True, "selected winners cover each slide object exactly once" if selected_set == sorted(object_by_id) and not duplicate_objects else "selected winner object refs do not exactly cover slide objects"),
        _gate("selected-asset-coverage", selected_asset_set == sorted(assets_by_object) and not duplicate_assets, True, "selected winners cover each ownership asset exactly once" if selected_asset_set == sorted(assets_by_object) and not duplicate_assets else "selected winner asset refs do not exactly cover ownership assets"),
    ]
    if any(item["blocking"] and not item["passed"] for item in page_gates):
        raise ReconstructionPlanError("E_RECONSTRUCTION_COVERAGE", f"{slide_id} reconstruction plan coverage gate failed")
    repair_safety = _repair_safety(objects, ownership_report.get("assets", []), ownership_report, (width, height), package_root)
    if repair_safety["status"] != "passed":
        raise ReconstructionPlanError("E_RECONSTRUCTION_OWNERSHIP", f"{slide_id} repair safety check failed")
    return {
        "version": PLAN_VERSION,
        "slideId": slide_id,
        "lossConfig": {"version": LOSS_VERSION, "weights": dict(LOSS_WEIGHTS), "estimatedFrom": "analysis", "regionRasterMaxShare": REGION_RASTER_MAX_SHARE, "nearWholeRasterShare": NEAR_WHOLE_RASTER_SHARE},
        "regions": regions,
        "pageGates": page_gates,
        "selectedObjectRefs": sorted(set(selected_objects)),
        "selectedAssetRefs": sorted(set(selected_assets)),
        "coverage": {"objectRefs": selected_set, "assetRefs": selected_asset_set, "unassignedObjectRefs": unassigned_objects, "unassignedAssetRefs": unassigned_assets, "duplicateObjectRefs": duplicate_objects, "duplicateAssetRefs": duplicate_assets},
        "provenance": {"sourceRefs": sorted(source_ids), "sourceDigests": sorted({str(item.get("normalizedSha256") or item.get("sha256")) for item in source_by_id.values()}), "ownershipVersion": ownership_report.get("version", "1.0.0")},
        "repairSafety": repair_safety,
        **({"routeOverrides": {key: route_overrides[key] for key in sorted(route_overrides)}} if route_overrides else {}),
    }
