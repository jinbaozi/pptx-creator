#!/usr/bin/env python3
"""Generate deterministic English-only example slide images."""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]


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


def main() -> None:
    minimal(ROOT / "examples" / "minimal" / "input.png")
    complex_second(ROOT / "examples" / "complex" / "slide-02-chart.png")
    print(ROOT / "examples")


if __name__ == "__main__":
    main()
