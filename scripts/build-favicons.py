"""Builds favicons from the official IARDA symbol (the site's own logo.png, symbol
without wordmark). It is scaled, never cropped or recolored, onto a white square
with clear space around it."""
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
src = Image.open(root / "brand/assets/logo/iarda-symbol.png").convert("RGBA")
src = src.crop(src.getbbox())  # trims only fully transparent margin, never the artwork
out = root / "brand/assets/favicon"
out.mkdir(parents=True, exist_ok=True)

def square(size, pad=0.06):
    canvas = Image.new("RGBA", (size, size), (255, 255, 255, 255))
    inner = int(size * (1 - 2 * pad))
    logo = src.copy()
    logo.thumbnail((inner, inner), Image.LANCZOS)
    canvas.alpha_composite(logo, ((size - logo.width) // 2, (size - logo.height) // 2))
    return canvas

for s in (32, 180, 192, 512):
    square(s).save(out / f"favicon-{s}.png", optimize=True)
square(256).save(out / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
(out / "apple-touch-icon.png").write_bytes((out / "favicon-180.png").read_bytes())
print("favicons written to", out)
