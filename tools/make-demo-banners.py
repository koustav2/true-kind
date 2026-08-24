#!/usr/bin/env python3
"""
Generates the three DEMO homepage banner backgrounds in assets/img/.

These are placeholders, not photographs. They exist so a fresh install shows a
finished-looking banner instead of three broken images, and so the client can
see the layout working before they have any pictures to put in it. Every one of
them is meant to be replaced from the CMS (Content -> Home -> Photographs ->
"Homepage slider - slide N photograph"); nothing here is content.

They are generated rather than sourced on purpose. A stock photograph of
somebody else's training centre, sitting on the homepage of a foundation that
reports its own numbers, is a small lie in the most prominent position on the
site. Abstract artwork in the logo's own colours is honest about being
decoration, and it is ours to ship.

The drawing is the ripple motif already used elsewhere on the site: concentric
rings off the right-hand edge, over a deep gradient in one programme's brand
hue. The left half is deliberately the darkest part of the frame, because that
is where the headline sits.

    python3 tools/make-demo-banners.py

Requires Pillow. Re-running overwrites the three files and nothing else.
"""

import math
import os
from PIL import Image, ImageDraw, ImageFilter

W, H = 1600, 700
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'img')

# The deep end of each ramp is a darkened logo colour, so the artwork stays
# inside the brand rather than next to it. The near end is gray-900 (#1F2937)
# pulled slightly toward the hue — that is the site's own dark surface.
BANNERS = [
    # filename                  deep hue        shadow end       ring tint
    ('banner-skilling.jpg',    (34,  76,   8), (16, 28, 22), (140, 205,  70)),
    ('banner-women.jpg',       (58,  30,  92), (24, 22, 44), (176, 138, 224)),
    ('banner-environment.jpg', (4,   68,  84), (14, 28, 38), ( 90, 200, 200)),
]


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def gradient(deep, shadow):
    """Diagonal ramp: shadow at the top-left (under the headline), hue at the
    bottom-right. Built row by row on a small image and scaled up — a 1600x700
    per-pixel loop in Python is slow enough to notice, and the ramp is smooth
    so nothing is lost to the resize."""
    sw, sh = 160, 70
    img = Image.new('RGB', (sw, sh))
    px = img.load()
    for y in range(sh):
        for x in range(sw):
            # Diagonal position, eased so the dark end holds longer than half.
            t = (x / (sw - 1)) * 0.72 + (y / (sh - 1)) * 0.28
            px[x, y] = lerp(shadow, deep, t ** 0.85)
    return img.resize((W, H), Image.BICUBIC)


def rings(tint):
    """The ripple: concentric rings centred beyond the right edge, so the frame
    shows the arcs rather than a bullseye. Drawn at 2x and downsampled, because
    a 3px stroke on a big circle aliases badly otherwise."""
    s = 2
    layer = Image.new('L', (W * s, H * s), 0)
    d = ImageDraw.Draw(layer)
    cx, cy = int(W * 1.06) * s, int(H * 0.52) * s
    for i in range(11):
        r = int((150 + i * 118) * s)
        # Outer rings fade out; the two innermost carry the accent.
        alpha = int(84 * (1 - i / 12.5))
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=alpha, width=int(3.5 * s))
    layer = layer.resize((W, H), Image.LANCZOS).filter(ImageFilter.GaussianBlur(0.4))
    solid = Image.new('RGB', (W, H), tint)
    return layer, solid


def glow(tint):
    """A soft off-centre light so the flat gradient has somewhere to breathe."""
    s = 8
    m = Image.new('L', (W // s, H // s), 0)
    d = ImageDraw.Draw(m)
    cx, cy, r = int(W * 0.78) // s, int(H * 0.34) // s, int(W * 0.30) // s
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=70)
    m = m.resize((W, H), Image.BICUBIC).filter(ImageFilter.GaussianBlur(60))
    return m, Image.new('RGB', (W, H), tint)


def build(deep, shadow, tint):
    img = gradient(deep, shadow)
    gm, gs = glow(tint)
    img = Image.composite(gs, img, gm.point(lambda v: int(v * 0.55)))
    rm, rs = rings(tint)
    img = Image.composite(rs, img, rm)
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, deep, shadow, tint in BANNERS:
        path = os.path.normpath(os.path.join(OUT, name))
        build(deep, shadow, tint).save(path, 'JPEG', quality=86, optimize=True,
                                       progressive=True)
        print('%-28s %6.0f KB' % (name, os.path.getsize(path) / 1024))


if __name__ == '__main__':
    main()
