"""
Composite LPC body + pants + shirt + head + hair layers into per-character PNGs.

Layer z-order (bottom to top): body -> pants -> shirt -> head -> hair

Input:   extension/media/characters-lpc/eulpc_body_{male,female,child,teen}.png
         extension/media/characters-lpc/eulpc_head_{male,female,child}.png
         extension/media/characters-lpc/pants/{color}.png
         extension/media/characters-lpc/tshirt/{color}.png
         extension/media/characters-lpc/shirt_male/default_cropped.png (male-fitted, from
             LPC Expanded Simple Shirts pack; hue-shifted per variant for color variety)
Output:  extension/media/characters-lpc-composed/char_0..5.png
"""

import os
import colorsys
from PIL import Image

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.join(REPO_ROOT, 'extension', 'media')
SRC = os.path.join(ROOT, 'characters-lpc')
DST = os.path.join(ROOT, 'characters-lpc-composed')
os.makedirs(DST, exist_ok=True)


def _load_rgba(path: str) -> Image.Image:
    return Image.open(path).convert('RGBA')


def _pad_to(img: Image.Image, target_h: int) -> Image.Image:
    if img.size[1] >= target_h:
        return img
    padded = Image.new('RGBA', (img.size[0], target_h), (0, 0, 0, 0))
    padded.paste(img, (0, 0))
    return padded


def _hue_shift(img: Image.Image, deg: int) -> Image.Image:
    if deg == 0:
        return img
    out = img.copy()
    px = out.load()
    shift = deg / 360.0
    for y in range(out.size[1]):
        for x in range(out.size[0]):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
            h = (h + shift) % 1.0
            r2, g2, b2 = colorsys.hls_to_rgb(h, l, s)
            px[x, y] = (int(r2 * 255), int(g2 * 255), int(b2 * 255), a)
    return out


def composite(layers) -> Image.Image:
    """layers: list of either str (path) or (path, hue_shift_deg)."""
    imgs = []
    for item in layers:
        if isinstance(item, tuple):
            path, hue = item
            imgs.append(_hue_shift(_load_rgba(os.path.join(SRC, path)), hue))
        else:
            imgs.append(_load_rgba(os.path.join(SRC, item)))
    max_h = max(im.size[1] for im in imgs)
    imgs = [_pad_to(im, max_h) for im in imgs]

    base = imgs[0]
    for top in imgs[1:]:
        base = Image.alpha_composite(base, top)
    return base


# Male shirt/pants are from [LPC Expanded] Simple Shirts + Expanded Pants packs.
# Both cropped/matched to 832x2944 and hue-shifted per variant for color variety.
MALE_SHIRT = 'longsleeve_m/default.png'  # longsleeve has better motion tracking than shortsleeve
MALE_PANTS = 'pants_m/default.png'

# Glasses from [LPC Expanded] Facial Assets — all 832x2944, drop-in on top of head/hair.
# Layer order: body -> pants -> shirt -> head -> hair -> glasses
GLASSES_NERD = 'accessories/facial/glasses/nerd/adult/black.png'
GLASSES_ROUND = 'accessories/facial/glasses/round/adult/black.png'
GLASSES_SECRETARY = 'accessories/facial/glasses/secretary/adult/black.png'
GLASSES_SUN = 'accessories/facial/glasses/sunglasses/adult/black.png'

VARIANTS = [
    # (out,         body,                    head,                    layers on top (bottom->top); path OR (path, hue))
    ('char_0.png', 'eulpc_body_male_aligned.png',   'eulpc_head_male.png',   [
        (MALE_PANTS, 210),     # dark blue pants
        (MALE_SHIRT, 210),     # blue shirt
        'hair/parted2.png',
        GLASSES_NERD,          # programmer look
    ]),
    ('char_1.png', 'eulpc_body_female.png', 'eulpc_head_female.png', [
        'pants/gray.png',
        'tshirt/white.png',
        'hair/bob.png',
        GLASSES_SECRETARY,
    ]),
    ('char_2.png', 'eulpc_body_teen.png',   'eulpc_head_male.png',   [
        'pants/black.png',
        'tshirt/purple.png',
        'hair/curly_short.png',
        GLASSES_SUN,           # cool kid shades
    ]),
    ('char_3.png', 'eulpc_body_male_aligned.png',   'eulpc_head_male.png',   [
        (MALE_PANTS, 30),      # brownish pants
        (MALE_SHIRT, 0),       # neutral gray shirt
        'hair/curly_short2.png',
        GLASSES_ROUND,
    ]),
    ('char_4.png', 'eulpc_body_female.png', 'eulpc_head_female.png', [
        'pants/navy.png',
        'tshirt/red.png',
        'hair/curly_short.png',
        # no glasses
    ]),
    # Child replaced — proportions don't match adult clothing/hair layers cleanly.
    # char_5 becomes a 2nd woman with navy colorway for visual distinction.
    ('char_5.png', 'eulpc_body_female.png', 'eulpc_head_female.png', [
        'pants/navy.png',
        'tshirt/navy.png',
        'hair/curly_short2.png',
        # no glasses
    ]),
]

for out_name, body, head, extras in VARIANTS:
    try:
        # z-order: body -> pants -> shirt -> head -> (hair) -> (glasses) -> ...
        # Convention: extras = [pants, shirt, *above-head-layers]
        layers = [body, extras[0], extras[1], head]
        layers.extend(extras[2:])
        img = composite(layers)
        img.save(os.path.join(DST, out_name))
        labels = [l if isinstance(l, str) else f'{l[0]}#{l[1]}' for l in layers]
        print(f'{out_name}: {img.size} = {" + ".join(labels)}')
    except Exception as e:
        print(f'{out_name}: FAIL - {e}')

print('\nDone. Outputs in:', DST)
