#!/usr/bin/env python3
"""Build the deterministic 55-sample image-to-pptx visual benchmark.

The benchmark is intentionally a source fixture, not a rendering result.  A
sample image and its truth record are produced from the same drawing spec in
this module.  No network, model, current time, or random facts are consulted.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path
from typing import Any, Callable

from PIL import Image, ImageDraw, ImageFont


SKILL_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FIXTURE_DIR = SKILL_ROOT / "tests" / "fixtures" / "visual-benchmark-matrix"
SEED = 20260807
GENERATOR_ID = "image-to-pptx-visual-benchmark-generator-v1"

CATEGORIES: tuple[tuple[str, str, int], ...] = (
    ("zh-dense", "中文密集排版", 10),
    ("en-info", "英文信息图", 5),
    ("mixed-language", "中英混排", 5),
    ("flowchart", "流程图", 5),
    ("table-dashboard", "表格和仪表盘", 5),
    ("photography", "摄影海报", 5),
    ("illustration", "手绘插画", 5),
    ("effects", "渐变、阴影、透明度", 5),
    ("low-resolution", "低分辨率和压缩图", 5),
    ("portrait-non16x9", "竖版或非 16:9 页面", 5),
)
QUOTAS = {category: ordinal_count for category, _, ordinal_count in CATEGORIES}

# These are policy floors and ceilings.  They are deliberately kept in one
# immutable literal so a test can reject a fixture that silently relaxes a
# gate.
THRESHOLDS: dict[str, dict[str, float | int | bool | str]] = {
    "ssim": {"operator": ">=", "value": 0.94},
    "cer": {"operator": "<=", "value": 0.02},
    "bboxIoU": {"operator": ">=", "value": 0.90},
    "nativeTextRecall": {"operator": ">=", "value": 0.90},
    "paletteDeltaE2000P95": {"operator": "<=", "value": 3.0},
    "editability": {"operator": ">=", "value": 3},
    "rasterAreaShare": {"operator": "<=", "value": 0.65},
    "wholeSlideRaster": {"operator": "==", "value": 0},
    "ownershipOverlap": {"operator": "==", "value": 0},
    "ownershipConflict": {"operator": "==", "value": 0},
    "sourceProvenance": {"operator": "==", "value": True},
    "complexPageEditability": {"operator": ">=", "value": 4},
    "complexPageRasterAreaShare": {"operator": "<=", "value": 0.35},
}

REQUIRED_TAGS = (
    "cjk",
    "latin",
    "text-dense",
    "mixed-script",
    "flowchart",
    "connectors",
    "table",
    "dashboard",
    "photo-like",
    "illustration",
    "gradient",
    "shadow",
    "transparency",
    "low-resolution",
    "compression",
    "portrait",
    "non-16:9",
)

FONT_RELATIVE_PATH = Path("fonts") / "NotoSansCJKSC-Subset.ttf"
FONT_LICENSE_RELATIVE_PATH = Path("fonts") / "NotoSansCJKSC-Subset.LICENSE"
_BUNDLED_FONT_PATH = Path(__file__).resolve().parent / "fixtures" / "visual-benchmark-matrix" / FONT_RELATIVE_PATH
_BUNDLED_FONT_LICENSE_PATH = Path(__file__).resolve().parent / "fixtures" / "visual-benchmark-matrix" / FONT_LICENSE_RELATIVE_PATH
_ACTIVE_FONT_PATH = _BUNDLED_FONT_PATH
FONT_FAMILY = "Noto Sans CJK SC"
FONT_UPSTREAM_URL = "https://github.com/notofonts/noto-cjk"
FONT_UPSTREAM_REVISION = "google-noto-cjk-fonts package 2017-06-02; NotoSansCJK-Regular.ttc face=2"
FONT_UPSTREAM_SHA256 = "e3c629cb9f416e2e57cfdfee7573d5cac3a06a681c105ec081ab9707c1f147e8"
FONT_GLYPH_SET_SHA256 = "ae866eb91a46945cd2f8e10faa67cf2bdab08c94579d515017f439b1109d8623"


def _font(size: int) -> ImageFont.FreeTypeFont:
    if not _ACTIVE_FONT_PATH.is_file():
        raise RuntimeError(f"benchmark font is missing: {_ACTIVE_FONT_PATH}")
    return ImageFont.truetype(str(_ACTIVE_FONT_PATH), size=size)


def _font_requirement() -> dict[str, str]:
    return {
        "path": FONT_RELATIVE_PATH.as_posix(),
        "family": FONT_FAMILY,
        "sha256": hashlib.sha256(_ACTIVE_FONT_PATH.read_bytes()).hexdigest(),
        "license": FONT_LICENSE_RELATIVE_PATH.as_posix(),
        "licenseId": "OFL-1.1",
    }


def _ensure_font_assets(fixture_dir: Path) -> tuple[Path, str]:
    """Copy the bundled OFL font to an output fixture using a relative path."""

    if not _BUNDLED_FONT_PATH.is_file() or not _BUNDLED_FONT_LICENSE_PATH.is_file():
        raise RuntimeError("bundled benchmark font and its license are required")
    target = fixture_dir / FONT_RELATIVE_PATH
    license_target = fixture_dir / FONT_LICENSE_RELATIVE_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.resolve() != _BUNDLED_FONT_PATH.resolve():
        shutil.copyfile(_BUNDLED_FONT_PATH, target)
        shutil.copyfile(_BUNDLED_FONT_LICENSE_PATH, license_target)
    global _ACTIVE_FONT_PATH
    _ACTIVE_FONT_PATH = target
    return target, hashlib.sha256(target.read_bytes()).hexdigest()


def _hex(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return tuple(int(value[index : index + 2], 16) for index in (0, 2, 4))  # type: ignore[return-value]


def _new_canvas(size: tuple[int, int], color: str = "#F6F8FB") -> tuple[Image.Image, ImageDraw.ImageDraw]:
    image = Image.new("RGB", size, color)
    return image, ImageDraw.Draw(image)


def _text(
    draw: ImageDraw.ImageDraw,
    truth: dict[str, Any],
    object_id: str,
    text: str,
    xy: tuple[int, int],
    size: int,
    color: str = "#172B4D",
    bold: bool = False,
) -> None:
    x, y = xy
    font = _font(size)
    draw.text((x, y), text, font=font, fill=color, anchor="lt", stroke_width=1 if bold else 0)
    left, top, right, bottom = draw.textbbox((x, y), text, font=font, anchor="lt", stroke_width=1 if bold else 0)
    box = {"x": int(left), "y": int(top), "w": max(1, int(right - left)), "h": max(1, int(bottom - top))}
    truth["objects"].append({"id": object_id, "kind": "text", "box": box, "text": text})
    truth["text"].append(text)


def _shape(
    draw: ImageDraw.ImageDraw,
    truth: dict[str, Any],
    object_id: str,
    box: tuple[int, int, int, int],
    fill: str,
    *,
    outline: str | None = None,
    width: int = 1,
    kind: str = "shape",
    opacity: float = 1.0,
) -> None:
    x, y, w, h = box
    xy = (x, y, x + w - 1, y + h - 1)
    fill_value: Any = fill
    outline_value: Any = outline
    if opacity < 1.0:
        alpha = max(0, min(255, round(255 * opacity)))
        fill_rgb = _hex(fill) if isinstance(fill, str) and fill.startswith("#") else (255, 255, 255)
        fill_value = (*fill_rgb, alpha)
        if outline is not None:
            outline_rgb = _hex(outline) if outline.startswith("#") else (255, 255, 255)
            outline_value = (*outline_rgb, alpha)
    draw.rectangle(xy, fill=fill_value, outline=outline_value, width=width)
    truth["objects"].append(
        {
            "id": object_id,
            "kind": kind,
            "box": {"x": x, "y": y, "w": w, "h": h},
            "fill": fill,
            "opacity": opacity,
        }
    )


def _circle(
    draw: ImageDraw.ImageDraw,
    truth: dict[str, Any],
    object_id: str,
    box: tuple[int, int, int, int],
    fill: str,
    *,
    outline: str | None = None,
    kind: str = "shape",
    opacity: float = 1.0,
) -> None:
    x, y, w, h = box
    draw.ellipse((x, y, x + w - 1, y + h - 1), fill=fill, outline=outline)
    truth["objects"].append(
        {
            "id": object_id,
            "kind": kind,
            "box": {"x": x, "y": y, "w": w, "h": h},
            "fill": fill,
            "opacity": opacity,
        }
    )


def _line(
    draw: ImageDraw.ImageDraw,
    truth: dict[str, Any],
    object_id: str,
    points: tuple[tuple[int, int], ...],
    fill: str,
    width: int = 2,
    *,
    kind: str = "connector",
) -> None:
    draw.line(points, fill=fill, width=width, joint="curve")
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    truth["objects"].append(
        {
            "id": object_id,
            "kind": kind,
            "box": {"x": min(xs), "y": min(ys), "w": max(xs) - min(xs) + width, "h": max(ys) - min(ys) + width},
        }
    )


def _truth(category: str, ordinal: int, size: tuple[int, int], tags: list[str]) -> dict[str, Any]:
    return {
        "source": "generated-input",
        "generator": GENERATOR_ID,
        "seed": SEED,
        "category": category,
        "ordinal": ordinal,
        "dimensions": {"width": size[0], "height": size[1], "unit": "px"},
        "scenarioTags": list(tags),
        "objects": [],
        "text": [],
    }


def _render_zh_dense(ordinal: int, size: tuple[int, int], sample_id: str, tags: list[str]) -> tuple[Image.Image, dict[str, Any]]:
    image, draw = _new_canvas(size, "#F4F7FB")
    truth = _truth("zh-dense", ordinal, size, tags)
    w, h = size
    _shape(draw, truth, f"{sample_id}-header", (0, 0, w, 72), "#12355B", kind="background")
    _text(draw, truth, f"{sample_id}-title", f"年度增长洞察 {ordinal:02d}", (28, 17), 27, "#FFFFFF", True)
    _text(draw, truth, f"{sample_id}-subtitle", "数据治理与客户体验的关键指标", (30, 50), 11, "#D9E8F5")
    _text(draw, truth, f"{sample_id}-section", "一、经营概览 / 二、问题定位 / 三、行动计划", (28, 87), 13, "#24496B", True)
    card_width = (w - 72) // 3
    labels = (("客户留存", "82%"), ("转化效率", "64%"), ("服务响应", "1.8h"))
    for index, (label, value) in enumerate(labels):
        x = 18 + index * (card_width + 18)
        _shape(draw, truth, f"{sample_id}-card-{index}", (x, 113, card_width, 82), "#FFFFFF", outline="#D4DEE9", width=2, kind="card")
        _text(draw, truth, f"{sample_id}-label-{index}", label, (x + 14, 126), 14, "#526A80")
        _text(draw, truth, f"{sample_id}-value-{index}", value, (x + 14, 153), 24, "#12355B", True)
    _shape(draw, truth, f"{sample_id}-body", (18, 214, w - 36, h - 238), "#FFFFFF", outline="#D4DEE9", width=2, kind="panel")
    rows = ("客户声音：续费意愿受交付稳定性影响", "风险提示：高峰期请求排队仍有波动", "下一步：本周完成三项流程自动化", "负责人：运营、产品、数据联合推进")
    for index, row in enumerate(rows):
        y = 233 + index * 29
        _shape(draw, truth, f"{sample_id}-bullet-{index}", (34, y + 5, 8, 8), "#2F80ED", kind="bullet")
        _text(draw, truth, f"{sample_id}-row-{index}", row, (52, y), 13, "#2C435A")
    for index in range(4):
        y = 234 + index * 22
        width = 150 + ((index + ordinal) * 23) % 150
        _shape(draw, truth, f"{sample_id}-bar-{index}", (335, y, width, 8), "#7FB3D5", kind="bar")
        _text(draw, truth, f"{sample_id}-bar-label-{index}", f"指标 {index + 1}", (w - 105, y - 1), 10, "#6A7F92")
    return image, truth


def _render_en_info(ordinal: int, size: tuple[int, int], sample_id: str, tags: list[str]) -> tuple[Image.Image, dict[str, Any]]:
    image, draw = _new_canvas(size, "#F7F8FA")
    truth = _truth("en-info", ordinal, size, tags)
    w, h = size
    _shape(draw, truth, f"{sample_id}-header", (0, 0, w, 68), "#1F2937", kind="background")
    _text(draw, truth, f"{sample_id}-title", f"PRODUCT SIGNALS {ordinal:02d}", (26, 16), 26, "#FFFFFF", True)
    _text(draw, truth, f"{sample_id}-subtitle", "A compact view of visible outcomes", (28, 46), 11, "#CBD5E1")
    for index, (label, value, color) in enumerate((("RETENTION", "82%", "#2F80ED"), ("ACTIVATION", "64%", "#16A085"), ("RESPONSE", "1.8 h", "#E67E22"))):
        x = 18 + index * 204
        _shape(draw, truth, f"{sample_id}-card-{index}", (x, 92, 184, 92), "#FFFFFF", outline="#D5DCE5", width=2, kind="card")
        _text(draw, truth, f"{sample_id}-label-{index}", label, (x + 13, 106), 11, "#64748B", True)
        _text(draw, truth, f"{sample_id}-value-{index}", value, (x + 13, 130), 24, color, True)
    _shape(draw, truth, f"{sample_id}-chart", (18, 207, w - 36, h - 228), "#FFFFFF", outline="#D5DCE5", width=2, kind="chart")
    _text(draw, truth, f"{sample_id}-chart-title", "WEEKLY MOVEMENT", (34, 222), 12, "#334155", True)
    _line(draw, truth, f"{sample_id}-axis", ((55, 320), (575, 320)), "#94A3B8", 2, kind="axis")
    values = (42, 75, 58, 108, 90, 132)
    for index, value in enumerate(values):
        x = 70 + index * 82
        _shape(draw, truth, f"{sample_id}-bar-{index}", (x, 320 - value, 42, value), "#2F80ED", kind="bar")
        _text(draw, truth, f"{sample_id}-bar-label-{index}", f"W{index + 1}", (x + 8, 330), 10, "#64748B")
    _text(draw, truth, f"{sample_id}-footer", "Observed geometry remains editable; values are visual facts.", (28, h - 18), 10, "#64748B")
    return image, truth


def _render_mixed(ordinal: int, size: tuple[int, int], sample_id: str, tags: list[str]) -> tuple[Image.Image, dict[str, Any]]:
    image, draw = _new_canvas(size, "#FFFDF8")
    truth = _truth("mixed-language", ordinal, size, tags)
    w, h = size
    _text(draw, truth, f"{sample_id}-title", f"增长 Growth {ordinal:02d}", (24, 20), 28, "#17324D", True)
    _text(draw, truth, f"{sample_id}-subtitle", "客户体验 Customer experience / 可见事实 Visible facts", (26, 58), 12, "#64748B")
    _shape(draw, truth, f"{sample_id}-panel", (20, 90, w - 40, h - 116), "#FFFFFF", outline="#E4D6C8", width=2, kind="panel")
    rows = (("客户 Retention", "82%"), ("实验 Experiments", "12"), ("下一步 Next", "3"), ("响应 Response", "1.8h"))
    for index, (label, value) in enumerate(rows):
        y = 112 + index * 43
        _text(draw, truth, f"{sample_id}-label-{index}", label, (42, y), 14, "#334155", index == 0)
        _text(draw, truth, f"{sample_id}-value-{index}", value, (w - 125, y), 18, "#C75B39", True)
        _line(draw, truth, f"{sample_id}-rule-{index}", ((42, y + 29), (w - 42, y + 29)), "#E7E0D8", 1, kind="divider")
    _text(draw, truth, f"{sample_id}-callout", "关键结论 / Key takeaway", (42, h - 56), 13, "#C75B39", True)
    return image, truth


def _render_flowchart(ordinal: int, size: tuple[int, int], sample_id: str, tags: list[str]) -> tuple[Image.Image, dict[str, Any]]:
    image, draw = _new_canvas(size, "#F8FAFC")
    truth = _truth("flowchart", ordinal, size, tags)
    w, h = size
    _text(draw, truth, f"{sample_id}-title", f"Decision flow / {ordinal:02d}", (24, 18), 25, "#0F172A", True)
    _text(draw, truth, f"{sample_id}-subtitle", "Trace the visible route from signal to action", (26, 51), 11, "#64748B")
    node_w, node_h = 142, 64
    nodes = ((42, 113, "Signal"), (249, 113, "Review"), (456, 113, "Approve"), (249, 243, "Action"), (456, 243, "Measure"))
    for index, (x, y, label) in enumerate(nodes):
        _shape(draw, truth, f"{sample_id}-node-{index}", (x, y, node_w, node_h), "#FFFFFF", outline="#2F80ED", width=3, kind="flow-node")
        _text(draw, truth, f"{sample_id}-node-text-{index}", label, (x + 35, y + 22), 15, "#1E3A5F", True)
    connectors = (((184, 145), (249, 145)), ((391, 145), (456, 145)), ((320, 177), (320, 243)), ((391, 275), (456, 275)))
    for index, points in enumerate(connectors):
        _line(draw, truth, f"{sample_id}-connector-{index}", points, "#64748B", 3)
        end_x, end_y = points[-1]
        draw.polygon(((end_x, end_y), (end_x - 8, end_y - 5), (end_x - 8, end_y + 5)), fill="#64748B")
    _shape(draw, truth, f"{sample_id}-legend", (42, 320, w - 84, 30), "#EAF3FF", kind="legend")
    _text(draw, truth, f"{sample_id}-legend-text", "Solid connectors indicate a deterministic visible relation.", (54, 328), 11, "#315A82")
    return image, truth


def _render_table_dashboard(ordinal: int, size: tuple[int, int], sample_id: str, tags: list[str]) -> tuple[Image.Image, dict[str, Any]]:
    image, draw = _new_canvas(size, "#F8FAFC")
    truth = _truth("table-dashboard", ordinal, size, tags)
    w, h = size
    _text(draw, truth, f"{sample_id}-title", f"Operations dashboard {ordinal:02d}", (22, 17), 24, "#172B4D", True)
    _text(draw, truth, f"{sample_id}-subtitle", "Closed grid, labels, and visible bars", (24, 48), 11, "#64748B")
    x0, y0, table_w, row_h, cols, rows = 24, 91, 370, 39, 4, 6
    _shape(draw, truth, f"{sample_id}-table", (x0, y0, table_w, row_h * rows), "#FFFFFF", outline="#B8C5D3", width=2, kind="table")
    for col in range(1, cols):
        _line(draw, truth, f"{sample_id}-vline-{col}", ((x0 + col * table_w // cols, y0), (x0 + col * table_w // cols, y0 + row_h * rows)), "#CBD5E1", 1, kind="grid-line")
    for row in range(1, rows):
        _line(draw, truth, f"{sample_id}-hline-{row}", ((x0, y0 + row * row_h), (x0 + table_w, y0 + row * row_h)), "#CBD5E1", 1, kind="grid-line")
    headers = ("Team", "Open", "Done", "Rate")
    for col, label in enumerate(headers):
        _text(draw, truth, f"{sample_id}-head-{col}", label, (x0 + 12 + col * table_w // cols, y0 + 10), 11, "#1E3A5F", True)
    for row in range(1, rows):
        values = (f"Unit {row}", str(4 + row), str(10 + row * 2), f"{58 + row * 5}%")
        for col, label in enumerate(values):
            _text(draw, truth, f"{sample_id}-cell-{row}-{col}", label, (x0 + 12 + col * table_w // cols, y0 + row * row_h + 11), 10, "#475569")
    _shape(draw, truth, f"{sample_id}-chart", (424, 91, w - 448, h - 116), "#FFFFFF", outline="#B8C5D3", width=2, kind="dashboard-chart")
    _text(draw, truth, f"{sample_id}-chart-title", "COMPLETION", (440, 108), 11, "#1E3A5F", True)
    for index, value in enumerate((48, 82, 62, 104, 73)):
        x = 442 + index * 36
        _shape(draw, truth, f"{sample_id}-bar-{index}", (x, 300 - value, 22, value), "#16A085", kind="bar")
    _line(draw, truth, f"{sample_id}-chart-axis", ((436, 300), (604, 300)), "#64748B", 2, kind="axis")
    return image, truth


def _render_photography(ordinal: int, size: tuple[int, int], sample_id: str, tags: list[str]) -> tuple[Image.Image, dict[str, Any]]:
    width, height = size
    image = Image.new("RGB", size)
    pixels = image.load()
    for y in range(height):
        ratio = y / max(1, height - 1)
        # A deterministic sky-to-horizon gradient gives the fixture a
        # photographic poster feel without importing an external asset.
        r = int(35 + 70 * ratio)
        g = int(104 + 70 * ratio)
        b = int(166 - 32 * ratio)
        for x in range(width):
            pixels[x, y] = (r + ((x + ordinal) % 3), g, b)
    draw = ImageDraw.Draw(image)
    truth = _truth("photography", ordinal, size, tags)
    _shape(draw, truth, f"{sample_id}-mountain-back", (0, 190, width, 170), "#34566E", kind="photo-backdrop")
    draw.polygon(((0, 310), (150, 205), (290, 292), (420, 180), (width, 295), (width, height), (0, height)), fill="#203B4D")
    truth["objects"].append({"id": f"{sample_id}-mountains", "kind": "photo-backdrop", "box": {"x": 0, "y": 180, "w": width, "h": height - 180}})
    _circle(draw, truth, f"{sample_id}-sun", (width - 132, 54, 66, 66), "#FFD166", kind="photo-light")
    tint = Image.new("RGBA", size, (12, 24, 40, 42))
    image = Image.alpha_composite(image.convert("RGBA"), tint).convert("RGB")
    draw = ImageDraw.Draw(image)
    _text(draw, truth, f"{sample_id}-title", "FIELD NOTES", (28, height - 94), 27, "#FFFFFF", True)
    _text(draw, truth, f"{sample_id}-caption", f"A procedural landscape / {ordinal:02d}", (30, height - 58), 12, "#E2E8F0")
    truth["photoAsset"] = {"kind": "procedural-photography", "external": False, "source": "generated-input"}
    return image, truth


def _render_illustration(ordinal: int, size: tuple[int, int], sample_id: str, tags: list[str]) -> tuple[Image.Image, dict[str, Any]]:
    image, draw = _new_canvas(size, "#FFF7E8")
    truth = _truth("illustration", ordinal, size, tags)
    w, h = size
    _text(draw, truth, f"{sample_id}-title", f"Small worlds {ordinal:02d}", (24, 18), 25, "#513B2C", True)
    _text(draw, truth, f"{sample_id}-subtitle", "A hand-drawn collection of editable shapes", (26, 51), 11, "#8B6E58")
    _circle(draw, truth, f"{sample_id}-sun", (54, 107, 74, 74), "#F4A261", kind="illustration")
    draw.polygon(((0, 332), (122, 214), (252, 315), (378, 198), (520, 333), (640, 236), (640, h), (0, h)), fill="#8AB17D")
    truth["objects"].append({"id": f"{sample_id}-hills", "kind": "illustration", "box": {"x": 0, "y": 198, "w": w, "h": h - 198}})
    _shape(draw, truth, f"{sample_id}-house", (270, 205, 118, 100), "#E76F51", kind="illustration")
    draw.polygon(((258, 207), (329, 152), (400, 207)), fill="#9C6644")
    truth["objects"].append({"id": f"{sample_id}-roof", "kind": "illustration", "box": {"x": 258, "y": 152, "w": 142, "h": 55}})
    _shape(draw, truth, f"{sample_id}-door", (317, 252, 25, 53), "#5B3A29", kind="illustration")
    _circle(draw, truth, f"{sample_id}-figure", (462, 252, 44, 44), "#2A9D8F", kind="illustration")
    _line(draw, truth, f"{sample_id}-path", ((329, 298), (340, 330), (460, 338)), "#E9C46A", 16, kind="illustration")
    _text(draw, truth, f"{sample_id}-caption", "SHAPE / COLOR / STORY", (26, h - 21), 10, "#765642", True)
    return image, truth


def _render_effects(ordinal: int, size: tuple[int, int], sample_id: str, tags: list[str]) -> tuple[Image.Image, dict[str, Any]]:
    width, height = size
    image = Image.new("RGB", size)
    pixels = image.load()
    for y in range(height):
        for x in range(width):
            ratio = (x + y + ordinal * 13) / max(1, width + height + 80)
            pixels[x, y] = (int(26 + 85 * ratio), int(35 + 45 * ratio), int(92 + 100 * ratio))
    overlay = Image.new("RGBA", size, (0, 0, 0, 0))
    odraw = ImageDraw.Draw(overlay)
    odraw.rounded_rectangle((28, 38, width - 28, height - 34), radius=20, fill=(255, 255, 255, 32), outline=(255, 255, 255, 110), width=2)
    odraw.ellipse((width - 190, 30, width - 36, 184), fill=(255, 192, 120, 74))
    odraw.ellipse((30, height - 170, 178, height - 22), fill=(104, 232, 210, 72))
    effect_truth = _truth("effects", ordinal, size, tags)
    _shape(odraw, effect_truth, f"{sample_id}-shadow", (76, 116, width - 152, 146), "#15224B", kind="shadow", opacity=0.42)
    _shape(odraw, effect_truth, f"{sample_id}-glass", (68, 106, width - 152, 146), "#FFFFFF", outline="#FFFFFF", width=2, kind="transparent-panel", opacity=0.22)
    image = Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")
    draw = ImageDraw.Draw(image)
    truth = effect_truth
    _text(draw, truth, f"{sample_id}-title", f"LAYERED LIGHT {ordinal:02d}", (94, 132), 23, "#FFFFFF", True)
    _text(draw, truth, f"{sample_id}-caption", "Gradient + shadow + alpha compositing", (96, 171), 12, "#E0E7FF")
    truth["effects"] = {"gradient": True, "shadow": True, "transparency": True, "alphaComposite": "deterministic"}
    return image, truth


def _render_low_resolution(ordinal: int, size: tuple[int, int], sample_id: str, tags: list[str]) -> tuple[Image.Image, dict[str, Any]]:
    image, draw = _new_canvas(size, "#EEF2F5")
    truth = _truth("low-resolution", ordinal, size, tags)
    width, height = size
    _shape(draw, truth, f"{sample_id}-header", (0, 0, width, 34), "#334E68", kind="background")
    _text(draw, truth, f"{sample_id}-title", f"LOW-RES SOURCE {ordinal:02d}", (10, 7), 13, "#FFFFFF", True)
    _shape(draw, truth, f"{sample_id}-pixel-card", (18, 50, width - 36, 74), "#FFFFFF", outline="#BCCCDC", width=1, kind="compressed-card")
    for index, color in enumerate(("#F94144", "#F9C74F", "#90BE6D", "#577590")):
        _shape(draw, truth, f"{sample_id}-pixel-{index}", (30 + index * 52, 68, 34, 34), color, kind="pixel-block")
    _text(draw, truth, f"{sample_id}-caption", "320 x 180 px / JPEG q48 / 4:2:0", (18, height - 37), 10, "#486581")
    _line(draw, truth, f"{sample_id}-scanline", ((18, height - 58), (width - 18, height - 58)), "#829AB1", 2, kind="scanline")
    truth["compression"] = {
        "format": "JPEG",
        "quality": 48,
        "subsampling": "4:2:0",
        "artifactPipeline": "generated RGB source -> JPEG quality=48, subsampling=2",
        "sourceResolution": [width, height],
    }
    return image, truth


def _render_portrait(ordinal: int, size: tuple[int, int], sample_id: str, tags: list[str]) -> tuple[Image.Image, dict[str, Any]]:
    image, draw = _new_canvas(size, "#FAF5EF")
    truth = _truth("portrait-non16x9", ordinal, size, tags)
    width, height = size
    _shape(draw, truth, f"{sample_id}-top", (0, 0, width, min(92, height // 4)), "#5B3A70", kind="background")
    _text(draw, truth, f"{sample_id}-title", f"POSTER / {ordinal:02d}", (18, 22), 22 if width < 500 else 25, "#FFFFFF", True)
    _text(draw, truth, f"{sample_id}-subtitle", "Vertical story" if height > width else "Wide story", (20, 56), 11, "#F1E8F6")
    section_top = min(122, height // 3)
    section_h = max(32, (height - section_top - 34) // 4)
    for index, (label, color) in enumerate((("OPEN", "#E07A5F"), ("LEARN", "#3D8B8B"), ("MAKE", "#E9C46A"), ("SHARE", "#457B9D"))):
        y = section_top + index * section_h
        _shape(draw, truth, f"{sample_id}-section-{index}", (18, y, width - 36, section_h - 8), color, kind="poster-section")
        _text(draw, truth, f"{sample_id}-section-label-{index}", label, (32, y + 11), 16 if width < 500 else 18, "#FFFFFF", True)
    _text(draw, truth, f"{sample_id}-footer", "Non-16:9 dimensions are part of the fixture.", (18, height - 24), 9, "#795548")
    return image, truth


RENDERERS: dict[str, Callable[[int, tuple[int, int], str, list[str]], tuple[Image.Image, dict[str, Any]]]] = {
    "zh-dense": _render_zh_dense,
    "en-info": _render_en_info,
    "mixed-language": _render_mixed,
    "flowchart": _render_flowchart,
    "table-dashboard": _render_table_dashboard,
    "photography": _render_photography,
    "illustration": _render_illustration,
    "effects": _render_effects,
    "low-resolution": _render_low_resolution,
    "portrait-non16x9": _render_portrait,
}


def _dimensions(category: str, ordinal: int) -> tuple[int, int]:
    if category == "low-resolution":
        return (320, 180)
    if category == "portrait-non16x9":
        return (360, 640) if ordinal <= 3 else (800, 500)
    return (640, 360)


def _tags(category: str, ordinal: int) -> list[str]:
    values = {
        "zh-dense": ["cjk", "text-dense", "multiline", "native-text"],
        "en-info": ["latin", "infographic", "native-text"],
        "mixed-language": ["cjk", "latin", "mixed-script", "native-text"],
        "flowchart": ["flowchart", "connectors", "nodes", "native-shapes"],
        "table-dashboard": ["table", "dashboard", "grid", "bars", "native-shapes"],
        "photography": ["photo-like", "raster-asset", "crop", "poster"],
        "illustration": ["illustration", "flat-shapes", "freeform", "native-shapes"],
        "effects": ["gradient", "shadow", "transparency", "layered"],
        "low-resolution": ["low-resolution", "compression", "small-source", "raster-asset"],
        "portrait-non16x9": ["portrait", "non-16:9", "vertical" if ordinal <= 3 else "wide"],
    }
    return values[category]


def _expected_features(category: str, tags: list[str]) -> dict[str, Any]:
    complex_page = category in {"zh-dense", "flowchart", "table-dashboard", "effects"}
    contains_raster = category in {"photography", "low-resolution"}
    return {
        "requiredSignals": list(tags),
        "textTreatment": "native-text" if "native-text" in tags else "none-or-localized",
        "complexPage": complex_page,
        "editabilityTarget": 4 if complex_page else 3,
        "wholeSlideRasterAllowed": False,
        "rasterAssetAllowed": contains_raster,
        "rasterAreaShareMax": 0.35 if complex_page else 0.65,
        "ownershipOverlapMax": 0,
        "ownershipConflictMax": 0,
    }


def _accepted_strategy(category: str) -> dict[str, Any]:
    if category in {"photography", "low-resolution"}:
        route = "native-plus-local-assets"
    elif category == "effects":
        route = "bounded-raster"
    else:
        route = "native-all"
    return {
        "route": route,
        "routeRationale": {
            "native-all": "visible text and geometry are emitted as native objects",
            "native-plus-local-assets": "only the generated local image asset may remain raster",
            "bounded-raster": "small effect region may be rasterized; whole-slide raster is forbidden",
        }[route],
        "text": "native-text" if category in {"zh-dense", "en-info", "mixed-language", "table-dashboard", "flowchart", "effects", "portrait-non16x9"} else "native-when-observed",
        "shapes": "native-shapes",
        "connectors": "native-connectors" if category == "flowchart" else "not-required",
        "rasterAssets": "local-source-only" if category in {"photography", "low-resolution"} else "none",
        "wholeSlideRaster": "forbidden",
    }


def _sample(category: str, ordinal: int, fixture_dir: Path) -> dict[str, Any]:
    sample_id = f"{category}-{ordinal:02d}"
    size = _dimensions(category, ordinal)
    tags = _tags(category, ordinal)
    image, truth = RENDERERS[category](ordinal, size, sample_id, tags)
    truth["objectCount"] = len(truth["objects"])
    truth["textObjectCount"] = len(truth["text"])
    truth["shapeObjectCount"] = truth["objectCount"] - truth["textObjectCount"]
    truth["inputSpec"] = {"generator": GENERATOR_ID, "seed": SEED, "category": category, "ordinal": ordinal}
    extension = ".jpg" if category == "low-resolution" else ".png"
    media_type = "image/jpeg" if extension == ".jpg" else "image/png"
    source_rel = Path("sources") / f"{sample_id}{extension}"
    source_path = fixture_dir / source_rel
    source_path.parent.mkdir(parents=True, exist_ok=True)
    if extension == ".jpg":
        image.save(source_path, format="JPEG", quality=48, subsampling=2, optimize=False, progressive=False)
    else:
        image.save(source_path, format="PNG", optimize=False, compress_level=9)
    digest = hashlib.sha256(source_path.read_bytes()).hexdigest()
    expected_features = _expected_features(category, tags)
    return {
        "id": sample_id,
        "category": category,
        "categoryLabel": dict((name, label) for name, label, _ in CATEGORIES)[category],
        "ordinal": ordinal,
        "dimensions": {
            "width": size[0],
            "height": size[1],
            "unit": "px",
            "aspectRatio": round(size[0] / size[1], 6),
            "orientation": "portrait" if size[1] > size[0] else "landscape",
        },
        "scenarioTags": tags,
        "source": {
            "path": source_rel.as_posix(),
            "sha256": digest,
            "mediaType": media_type,
            "origin": "programmatic-pillow",
            "generatedBy": GENERATOR_ID,
        },
        "truth": truth,
        "expectedFeatures": expected_features,
        "acceptedStrategy": _accepted_strategy(category),
        "goldenMetrics": {"status": "not-run", "thresholdRef": "manifest.thresholds", "results": None},
        "expectedEditabilityLevel": expected_features["editabilityTarget"],
        "maximumRasterShare": expected_features["rasterAreaShareMax"],
        "knownFontRequirements": [_font_requirement()],
        "failureRegressionTags": sorted(set(tags) | {"whole-slide-raster", "ownership-overlap", "ownership-conflict"}),
        "evaluation": {"status": "not-run", "metrics": None, "renderingResult": None},
    }


def build_manifest(fixture_dir: Path = DEFAULT_FIXTURE_DIR) -> dict[str, Any]:
    """Render all samples and return the source-bound manifest."""

    fixture_dir = Path(fixture_dir)
    fixture_dir.mkdir(parents=True, exist_ok=True)
    _, font_digest = _ensure_font_assets(fixture_dir)
    samples: list[dict[str, Any]] = []
    for category, _, count in CATEGORIES:
        for ordinal in range(1, count + 1):
            samples.append(_sample(category, ordinal, fixture_dir))
    observed_tags = sorted({tag for sample in samples for tag in sample["scenarioTags"]})
    font_metadata = {
        "path": FONT_RELATIVE_PATH.as_posix(),
        "family": FONT_FAMILY,
        "sha256": font_digest,
        "license": FONT_LICENSE_RELATIVE_PATH.as_posix(),
        "licenseId": "OFL-1.1",
        "source": "Noto Sans CJK SC Regular subset from google-noto-cjk-fonts",
        "upstreamUrl": FONT_UPSTREAM_URL,
        "upstreamRevision": FONT_UPSTREAM_REVISION,
        "upstreamSha256": FONT_UPSTREAM_SHA256,
        "glyphSetSha256": FONT_GLYPH_SET_SHA256,
        "generationCommand": "fontTools.subset.Subsetter(face=2, text=<generator Unicode>, glyph_names=True)",
    }
    manifest = {
        "kind": "image-to-pptx-visual-benchmark-matrix",
        "version": "1.0.0",
        "id": "image-to-pptx-visual-benchmark-v1",
        "deterministic": {
            "network": False,
            "model": None,
            "seed": SEED,
            "generator": GENERATOR_ID,
            "facts": "all truth records are emitted from the same drawing input used for each source image",
            "font": font_metadata,
        },
        "provenance": {
            "status": "complete",
            "sourceKind": "generated-input",
            "externalSourceImages": False,
            "bundledThirdPartyAssets": [font_metadata],
            "network": False,
            "model": None,
            "font": font_metadata,
        },
        "quotas": dict(QUOTAS),
        "counts": {"total": len(samples), "categories": dict(QUOTAS)},
        "categoryQuotas": dict(QUOTAS),
        "scenarioTagCoverage": {"required": list(REQUIRED_TAGS), "observed": observed_tags},
        "thresholds": THRESHOLDS,
        "evaluation": {
            "status": "not-run",
            "visualResults": None,
            "note": "Fixture metadata does not claim a LibreOffice or renderer pass.",
        },
        "samples": samples,
    }
    (fixture_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return manifest


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-root",
        type=Path,
        default=SKILL_ROOT,
        help="repository/skill root; fixture is written below tests/fixtures/visual-benchmark-matrix",
    )
    parser.add_argument(
        "--fixture-dir",
        type=Path,
        help="write directly to this fixture directory (useful for isolated checks)",
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    fixture_dir = args.fixture_dir or args.output_root / "tests" / "fixtures" / "visual-benchmark-matrix"
    manifest = build_manifest(fixture_dir)
    print(f"generated {manifest['counts']['total']} visual benchmark samples in {fixture_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
