#!/usr/bin/env python3
"""Generate the OpenTrade macOS app icon (build/icon.icns + build/icon.png), or with
`--nightly` the OpenTrade Nightly icon (build/icon-nightly.*).

Composes the brand mark from build/icon.svg onto a FULL-BLEED square (corners rounded
to a macOS squircle), with the mark cropped to its bounding box and centered at
MARK_FILL of the canvas so it keeps comfortable breathing room. Stable is a black mark
on white; Nightly is the inverted "night mode" mark — white on black — so it reads as
a different app in the Dock. FIELD must match the SVG's background rect.

No transparent margin on purpose: macOS 26 (Tahoe) crops a transparent margin away and
scales the remaining opaque content up to fill its own icon tile, so any margin we add
just makes the mark look zoomed in. Full-bleed FIELD avoids that — Tahoe fills its tile
with our field and the mark stays the size we draw it. The generated icon.icns/icon.png
are committed; re-run this only when the source SVG changes.

Requires macOS `qlmanage` (SVG rasterization via Quick Look), `iconutil`, and Pillow.
"""
import os
import sys
import subprocess
import tempfile

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(os.path.dirname(HERE), "build")
NIGHTLY = "--nightly" in sys.argv[1:]
NAME = "icon-nightly" if NIGHTLY else "icon"
SVG = os.path.join(BUILD, f"{NAME}.svg")

CANVAS = 1024            # full icon bounds (white fills this edge-to-edge)
RADIUS = int(CANVAS * 0.224)   # macOS squircle corner radius
MARK_FILL = 0.54        # mark diameter as a fraction of the canvas
SS = 4                  # supersample factor for crisp edges
FIELD = (0, 0, 0) if NIGHTLY else (255, 255, 255)  # must match the SVG's background rect


def rasterize_svg(px):
    """Rasterize build/icon.svg to a px*px RGBA image via macOS qlmanage.

    qlmanage honors the SVG's intrinsic width/height, so we override them to `px`
    (the viewBox is left intact) and let it scale the art to fill the canvas.
    """
    with open(SVG, "r", encoding="utf-8") as f:
        svg = f.read()
    svg = svg.replace('width="144" height="144"', f'width="{px}" height="{px}"', 1)
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "icon.svg")
        with open(src, "w", encoding="utf-8") as f:
            f.write(svg)
        subprocess.run(
            ["qlmanage", "-t", "-s", str(px), "-o", tmp, src],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        out = os.path.join(tmp, "icon.svg.png")
        return Image.open(out).convert("RGBA").resize((px, px), Image.LANCZOS)


def rounded_mask(size, radius):
    from PIL import ImageDraw
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def square_mark_bbox(art):
    """Bounding square of the mark: every pixel that differs from FIELD."""
    field = sum(FIELD) / 3
    bw = art.convert("L").point(lambda v: 255 if abs(v - field) > 55 else 0)
    box = bw.getbbox()  # (l, t, r, b) of the mark
    if box is None:
        return (0, 0, art.width, art.height)
    l, t, r, b = box
    cx, cy = (l + r) / 2, (t + b) / 2
    half = max(r - l, b - t) / 2
    return (round(cx - half), round(cy - half), round(cx + half), round(cy + half))


def build_master():
    """Compose the 1024px master icon: a full-bleed FIELD + a centered brand mark."""
    art = rasterize_svg(CANVAS * SS)            # FIELD bg + contrasting mark
    mark = art.crop(square_mark_bbox(art))      # trim the SVG's internal padding

    c = CANVAS * SS
    inner = round(c * MARK_FILL)
    mark = mark.resize((inner, inner), Image.LANCZOS).convert("RGB")

    canvas = Image.new("RGB", (c, c), FIELD)    # full-bleed field
    off = (c - inner) // 2
    canvas.paste(mark, (off, off))              # mark's own bg merges into the field
    canvas = canvas.convert("RGBA")
    canvas.putalpha(rounded_mask(c, RADIUS * SS))   # round corners (Tahoe re-rounds anyway)
    return canvas.resize((CANVAS, CANVAS), Image.LANCZOS)


def main():
    os.makedirs(BUILD, exist_ok=True)
    master = build_master()
    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, "icon.iconset")
        os.makedirs(iconset)
        for base in (16, 32, 128, 256, 512):
            master.resize((base, base), Image.LANCZOS).save(
                os.path.join(iconset, f"icon_{base}x{base}.png"))
            master.resize((base * 2, base * 2), Image.LANCZOS).save(
                os.path.join(iconset, f"icon_{base}x{base}@2x.png"))
        out = os.path.join(BUILD, f"{NAME}.icns")
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o", out], check=True)
        # Also keep a 1024 PNG for docs/README usage.
        master.save(os.path.join(BUILD, f"{NAME}.png"))
        print(f"wrote {out}")


if __name__ == "__main__":
    main()
