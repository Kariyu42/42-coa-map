"""
Run this script once to generate the extension icons.
Requires: pip install Pillow
"""
from PIL import Image, ImageDraw, ImageFont
import os

SIZES = [16, 48, 128]
BG_COLOR = (22, 33, 62)       # dark blue
ACCENT_COLOR = (102, 136, 204) # muted blue

os.makedirs(os.path.dirname(__file__), exist_ok=True)

for size in SIZES:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Circle background
    draw.ellipse([0, 0, size - 1, size - 1], fill=BG_COLOR)

    # "C" letter for Coalition
    margin = size // 5
    font_size = int(size * 0.55)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", font_size)
    except Exception:
        font = ImageFont.load_default()

    text = "C"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(
        ((size - tw) / 2 - bbox[0], (size - th) / 2 - bbox[1]),
        text,
        fill=ACCENT_COLOR,
        font=font,
    )

    out_path = os.path.join(os.path.dirname(__file__), f"icon{size}.png")
    img.save(out_path)
    print(f"Saved {out_path}")

print("Done.")
