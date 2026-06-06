#!/usr/bin/env python3
"""Generate examples/image-input/business-slide.png (deterministic sample)."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "lib"))

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("Pillow is required: pip install -r requirements.txt", file=sys.stderr)
    raise SystemExit(1)

OUTPUT = ROOT / "examples" / "image-input" / "business-slide.png"
WIDTH, HEIGHT = 1920, 1080

COLORS = {
    "bg": "#FFFFFF",
    "header": "#2563EB",
    "card": "#EFF6FF",
    "card_border": "#DBEAFE",
    "text": "#111827",
    "muted": "#64748B",
}


def hex_color(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def main() -> None:
    img = Image.new("RGB", (WIDTH, HEIGHT), hex_color(COLORS["bg"]))
    draw = ImageDraw.Draw(img)

    draw.rectangle((0, 0, WIDTH, 180), fill=hex_color(COLORS["header"]))
    draw.text((80, 58), "产品能力概览", fill=(255, 255, 255))
    draw.text((80, 118), "2026 Q2 业务复盘", fill=(219, 234, 254))

    card_w = 860
    card_h = 360
    cards = [
        (80, 240, "核心指标", "月活用户 +18%"),
        (980, 240, "增长引擎", "渠道转化 +12%"),
        (80, 640, "风险项", "留存波动需关注"),
        (980, 640, "下步计划", "扩展企业版试点"),
    ]
    for x, y, title, body in cards:
        draw.rounded_rectangle(
            (x, y, x + card_w, y + card_h),
            radius=24,
            fill=hex_color(COLORS["card"]),
            outline=hex_color(COLORS["card_border"]),
            width=3,
        )
        draw.text((x + 36, y + 36), title, fill=hex_color(COLORS["text"]))
        draw.text((x + 36, y + 110), body, fill=hex_color(COLORS["muted"]))

    draw.rectangle((80, 1020, WIDTH - 80, 1060), fill=hex_color(COLORS["card"]))
    draw.text((100, 1030), "维度 | 本季度 | 上季度 | 同比", fill=hex_color(COLORS["text"]))

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUTPUT, format="PNG")
    print(f"wrote {OUTPUT}")


if __name__ == "__main__":
    main()
