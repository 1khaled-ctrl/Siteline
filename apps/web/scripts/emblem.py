"""Cuts the SiteLine Lunar Emblem into the pieces the opening animates: the round badge (transparent outside its gold
ring), the lander and the shooting star as cut-outs, a 64 px icon, and emblem.json with where each piece sits on the
badge as fractions of its width.

    uv run --no-project --with numpy --with pillow python apps/web/scripts/emblem.py         docs/brand/siteline-lunar-emblem.png apps/web/src/assets
"""

import sys, json
import numpy as np
from PIL import Image, ImageFilter
src, out = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGB')
a = np.asarray(im).astype(np.float32)
H, W, _ = a.shape
R, G, B = a[..., 0], a[..., 1], a[..., 2]
gold = (R > 190) & (G > 110) & (G < 210) & (B < 100)
ys, xs = np.nonzero(gold)
cx0, cy0 = W / 2, H / 2
d = np.hypot(xs - cx0, ys - cy0)
sel = d > 440
x, y = xs[sel].astype(np.float64), ys[sel].astype(np.float64)
# Algebraic circle fit: x^2 + y^2 + D x + E y + F = 0
A = np.c_[x, y, np.ones_like(x)]
bvec = -(x**2 + y**2)
D, E, F = np.linalg.lstsq(A, bvec, rcond=None)[0]
cx, cy = -D / 2, -E / 2
r = np.sqrt(cx**2 + cy**2 - F)
rr = np.hypot(x - cx, y - cy)
inner, outer = np.percentile(rr, 1), np.percentile(rr, 99)
print(json.dumps({'cx': cx, 'cy': cy, 'r': r, 'inner': inner, 'outer': outer}))
bg = np.median(a[int(cy) - 380:int(cy) - 340, int(cx) - 40:int(cx) + 40].reshape(-1, 3), axis=0)
print('bg', bg)

# The badge: a square around the ring, transparent outside it.
half = outer + 8
box = (int(round(cx - half)), int(round(cy - half)), int(round(cx + half)), int(round(cy + half)))
badge = im.crop(box)
S = badge.size[0]
yy, xx = np.mgrid[0:S, 0:S]
dist = np.hypot(xx - (cx - box[0]), yy - (cy - box[1]))
alpha = np.clip((outer + 1.5 - dist) / 1.5, 0, 1) * 255
rgba = np.dstack([np.asarray(badge), alpha.astype(np.uint8)])
img = Image.fromarray(rgba, 'RGBA').resize((768, 768), Image.LANCZOS)
img.save(f'{out}/emblem.webp', 'WEBP', quality=90, method=6)
img.resize((64, 64), Image.LANCZOS).save(f'{out}/emblem-64.png', optimize=True)
print('badge box', box, 'size', S)

# Cut-outs: lander and shooting star, keyed against the navy face.
def cutout(name, x0, y0, x1, y1, keep):
    reg = a[y0:y1, x0:x1]
    diff = np.linalg.norm(reg - bg, axis=2)
    al = np.clip((diff - 40) / 60, 0, 1)
    m = keep(reg, np.mgrid[y0:y1, x0:x1])
    al = al * m
    rgba = np.dstack([reg.astype(np.uint8), (al * 255).astype(np.uint8)])
    Image.fromarray(rgba, 'RGBA').save(f'{out}/emblem-{name}.webp', 'WEBP', quality=92, method=6, lossless=False)
    # Where the cut-out sits on the badge, as fractions of the badge's width.
    return {k: v / S for k, v in {'x': x0 - box[0], 'y': y0 - box[1], 'w': x1 - x0, 'h': y1 - y0}.items()}

from PIL import ImageDraw
def polygon_mask(points):
    m = Image.new('L', (W, H), 0)
    ImageDraw.Draw(m).polygon(points, fill=255)
    return np.asarray(m.filter(ImageFilter.GaussianBlur(1))).astype(np.float32) / 255

LANDER = polygon_mask([(788, 348), (812, 372), (800, 400), (838, 440), (862, 470), (870, 505), (905, 560), (955, 690),
                       (945, 708), (880, 708), (870, 690), (760, 690), (722, 690), (600, 708), (528, 708), (532, 680),
                       (610, 560), (628, 500), (640, 455), (690, 430), (705, 372), (750, 352)])
def lander_keep(reg, grid):
    gy, gx = grid
    r, g, b = reg[..., 0], reg[..., 1], reg[..., 2]
    isgold = (r > 150) & (b < 120) & (r - b > 90)
    # Below the deck the white is the ground: keep only the gold legs and pads there, and the engine bell.
    bell = (gx > 722) & (gx < 762) & (gy < 668)
    keep = np.where(gy < 640, 1.0, np.where(isgold | bell, 1.0, 0.0))
    return keep * LANDER[gy, gx]

def star_keep(reg, grid):
    gy, gx = grid
    r, g, b = reg[..., 0], reg[..., 1], reg[..., 2]
    isgold = (r > 150) & (b < 120) & (r - b > 90)
    # The star and its trail are gold; the dish below them is not part of it.
    ring = np.hypot(gx - cx, gy - cy) > inner - 4
    return np.where(isgold & ~((gx > 700) & (gy > 340)) & ~ring, 1.0, 0.0)

info = {
    'ring': {'r': r / S, 'inner': inner / S, 'outer': outer / S, 'cx': (cx - box[0]) / S, 'cy': (cy - box[1]) / S},
    'lander': cutout('lander', 524, 344, 960, 712, lander_keep),
    'star': cutout('star', 470, 225, 905, 425, star_keep),
}
print(json.dumps(info, indent=1))
json.dump(info, open(f'{out}/emblem.json', 'w'), indent=1)
