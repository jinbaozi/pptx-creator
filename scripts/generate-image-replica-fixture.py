#!/usr/bin/env python3
"""Generate the deterministic mixed native/raster image-replica golden."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "examples/image-input/replica-golden.png"

def font(size: int, bold: bool = False):
    candidates = (["/Library/Fonts/Arial Bold.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"] if bold else
                  ["/Library/Fonts/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"])
    for path in candidates:
        if Path(path).exists(): return ImageFont.truetype(path, size)
    return ImageFont.load_default()

img = Image.new("RGB", (1280, 720), "#F5F7FB")
d = ImageDraw.Draw(img)
d.rectangle((0, 0, 1279, 108), fill="#102A43")
d.text((64, 31), "REPLICA PROOF", font=font(34, True), fill="#FFFFFF")
d.text((64, 130), "Editable structure with a local photo fallback", font=font(24), fill="#243B53")
for box, accent in [((64, 200, 390, 430), "#2F80ED"), ((422, 200, 748, 430), "#27AE60")]:
    d.rectangle(box, fill="#FFFFFF", outline="#CBD5E1", width=2)
    d.rectangle((box[0], box[1], box[0] + 10, box[3]), fill=accent)
d.text((94, 235), "NATIVE TEXT", font=font(25, True), fill="#102A43")
d.text((94, 292), "High confidence OCR", font=font(20), fill="#486581")
d.text((452, 235), "NATIVE SHAPES", font=font(25, True), fill="#102A43")
d.text((452, 292), "Cards and divider", font=font(20), fill="#486581")
d.line((64, 474, 1216, 474), fill="#829AB1", width=3)
# Deliberately complex local photographic/residual region.
for y in range(200, 430):
    for x in range(780, 1216):
        r = 40 + int(80 * (x - 780) / 436)
        g = 90 + int(95 * (y - 200) / 230)
        b = 145 + ((x * 13 + y * 7) % 71)
        img.putpixel((x, y), (min(r,255), min(g,255), min(b,255)))
d = ImageDraw.Draw(img)
d.ellipse((916, 250, 1080, 414), fill="#F2C94C", outline="#FFFFFF", width=8)
d.text((64, 532), "SOURCE TO PPTX TO PNG", font=font(29, True), fill="#102A43")
d.text((64, 584), "Native-first. Raster only where complexity requires it.", font=font(21), fill="#486581")
OUT.parent.mkdir(parents=True, exist_ok=True)
img.save(OUT)
print(OUT)
