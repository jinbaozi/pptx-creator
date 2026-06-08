#!/usr/bin/env python3
import json
import sys
from pathlib import Path


HEX = "0123456789abcdefABCDEF"
CHART_KINDS = {"bar", "line", "pie", "stackedBar", "horizontalBar", "groupedBar", "kpiGroup", "sparkline"}


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def require(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def is_color_or_token(value: object) -> bool:
    if not isinstance(value, str):
        return False
    if value.startswith("{") and value.endswith("}"):
        return True
    return len(value) == 7 and value[0] == "#" and all(char in HEX for char in value[1:])


def load_manifest(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        fail(f"invalid json: {error}")


def validate_design_system(data: dict, manifest_path: Path) -> None:
    design = data.get("designSystem")
    require(isinstance(design, dict), "designSystem must be an object")
    require(design.get("mode") in {"strict", "balanced", "creative"}, "designSystem.mode must be strict, balanced, or creative")
    source = design.get("source")
    require(isinstance(source, str) and source, "designSystem.source is required")
    design_path = (manifest_path.parent / source).resolve()
    require(design_path.exists(), f"designSystem.source missing: {source}")


def validate_deck(data: dict) -> tuple[float, float]:
    require(data.get("version") == "0.1.1", "version must be 0.1.1")
    deck = data.get("deck")
    require(isinstance(deck, dict), "deck must be an object")
    size = deck.get("size")
    require(isinstance(size, dict), "deck.size must be an object")
    require(size.get("unit") == "in", "deck.size.unit must be in")
    width = size.get("width")
    height = size.get("height")
    require(isinstance(width, (int, float)) and width > 0, "deck.size.width must be positive")
    require(isinstance(height, (int, float)) and height > 0, "deck.size.height must be positive")
    return float(width), float(height)


def validate_assets(data: dict, manifest_path: Path) -> None:
    for asset in data.get("assets", []):
        require(isinstance(asset, dict), "asset must be an object")
        require(asset.get("id"), "asset.id is required")
        require_local_file(asset.get("src"), manifest_path, f"asset/{asset['id']}")


def is_remote_src(src: str) -> bool:
    return src.startswith("http://") or src.startswith("https://")


def require_local_file(src: object, manifest_path: Path, label: str) -> None:
    require(isinstance(src, str) and src, f"{label}: src is required")
    require(not is_remote_src(src), f"{label}: remote src must be downloaded before validation: {src}")
    file_path = (manifest_path.parent / src).resolve()
    require(file_path.exists(), f"{label}: file missing: {src}")


def validate_element(element: dict, slide_id: str, width: float, height: float, manifest_path: Path) -> None:
    require(element.get("type") in {"text", "shape", "image", "table", "line", "chart", "icon"}, f"{slide_id}: unsupported element type")
    require(isinstance(element.get("id"), str) and element["id"], f"{slide_id}: element id is required")
    for key in ["x", "y", "w", "h"]:
        require(isinstance(element.get(key), (int, float)), f"{slide_id}/{element['id']}: {key} must be numeric")
    x, y, w, h = float(element["x"]), float(element["y"]), float(element["w"]), float(element["h"])
    require(w > 0 and h > 0, f"{slide_id}/{element['id']}: w and h must be positive")
    require(x >= 0 and y >= 0 and x + w <= width and y + h <= height, f"{slide_id}/{element['id']}: outside slide bounds")
    if element["type"] == "text":
        require(isinstance(element.get("text"), str), f"{slide_id}/{element['id']}: text is required")
    if element["type"] == "shape":
        require(element.get("shape") in {"rect", "roundRect", "ellipse"}, f"{slide_id}/{element['id']}: unsupported shape")
    if element["type"] == "image":
        require_local_file(element.get("src"), manifest_path, f"{slide_id}/{element['id']}")
    if element["type"] == "table":
        require(isinstance(element.get("rows"), list), f"{slide_id}/{element['id']}: rows are required")
    if element["type"] == "chart":
        require(element.get("kind") in CHART_KINDS, f"{slide_id}/{element['id']}: chart.kind must be one of {', '.join(sorted(CHART_KINDS))}")
        data = element.get("data")
        require(isinstance(data, list) and data, f"{slide_id}/{element['id']}: chart.data is required")
        for index, point in enumerate(data):
            require(isinstance(point, dict), f"{slide_id}/{element['id']}: chart.data[{index}] must be an object")
            require(isinstance(point.get("label"), str) and point["label"], f"{slide_id}/{element['id']}: chart.data[{index}].label is required")
            if "series" in point:
                require(isinstance(point["series"], dict) and point["series"], f"{slide_id}/{element['id']}: chart.data[{index}].series must be a non-empty object")
                for series_name, series_value in point["series"].items():
                    require(isinstance(series_name, str) and series_name, f"{slide_id}/{element['id']}: chart.data[{index}].series keys must be non-empty strings")
                    require(isinstance(series_value, (int, float)), f"{slide_id}/{element['id']}: chart.data[{index}].series.{series_name} must be numeric")
            else:
                require(isinstance(point.get("value"), (int, float)), f"{slide_id}/{element['id']}: chart.data[{index}].value must be numeric")
    if element["type"] == "icon":
        require(element.get("name") in {"check", "x", "info", "arrow-right"}, f"{slide_id}/{element['id']}: unsupported icon name")
    if "style" in element:
        require(isinstance(element["style"], dict), f"{slide_id}/{element['id']}: style must be an object")


def validate_slides(data: dict, width: float, height: float, manifest_path: Path) -> None:
    slides = data.get("slides")
    require(isinstance(slides, list) and slides, "slides must be a non-empty array")
    seen_slides = set()
    for slide in slides:
        require(isinstance(slide, dict), "slide must be an object")
        slide_id = slide.get("id")
        require(isinstance(slide_id, str) and slide_id.startswith("slide-"), "slide.id must start with slide-")
        require(slide_id not in seen_slides, f"duplicate slide id: {slide_id}")
        seen_slides.add(slide_id)
        background = slide.get("background")
        require(isinstance(background, dict), f"{slide_id}: background must be an object")
        require(background.get("type") in {"solid", "image"}, f"{slide_id}: unsupported background type")
        if background.get("type") == "solid":
            require(is_color_or_token(background.get("color")), f"{slide_id}: solid background requires #RRGGBB color or token")
        if background.get("type") == "image":
            require_local_file(background.get("src"), manifest_path, slide_id)
        seen_elements = set()
        for element in slide.get("elements", []):
            element_id = element.get("id")
            require(element_id not in seen_elements, f"{slide_id}: duplicate element id: {element_id}")
            seen_elements.add(element_id)
            validate_element(element, slide_id, width, height, manifest_path)


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: validate-manifest.py <deck.manifest.json>")
    manifest_path = Path(sys.argv[1])
    data = load_manifest(manifest_path)
    validate_design_system(data, manifest_path)
    width, height = validate_deck(data)
    validate_assets(data, manifest_path)
    validate_slides(data, width, height, manifest_path)
    print("manifest valid")


if __name__ == "__main__":
    main()
