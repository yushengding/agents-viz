"""Detect multi-figure cells in LPC sprite sheets via column-density analysis.

Run after build_lpc_sheets to flag sprites that show 2+ characters in one cell.
Empirical: Z-Image / SDXL with wide-shot prompts produce multi-figure ~15-20%
of seeds when "solo" clause is missing.

Tuned (2026-04-27): 50% threshold + min_band_width=4. The earlier 30% threshold
missed cases where two figures were touching (col density never dipped below 30%).
50% creates a clearer valley between adjacent bodies.

Usage:
    python3 scripts/detect_multi_figure.py [--threshold 0.5] [--min-band 4]
Returns exit code 0 if all clean, 1 if any multi found (CI-friendly).
"""
import argparse, glob, json, os, re, sys
from PIL import Image
import numpy as np

CHARS_DIR = os.environ.get(
    "CHARS_DIR",
    r"C:\Users\Yusheng Ding\Desktop\projects\agents-viz\extension\media\characters"
)


def detect(img, thresh_pct=0.5, min_band=4):
    """Return (band_count, [band_widths]). Bands narrower than min_band are noise."""
    arr = np.array(img.convert("RGBA"))[..., 3]
    col = np.convolve(arr.sum(0).astype(float), np.ones(3) / 3, mode="same")
    if col.max() < 100:
        return 0, []
    occ = col > col.max() * thresh_pct
    bands = []
    in_band = False
    w = 0
    for v in occ:
        if v:
            if not in_band:
                in_band = True
                w = 1
            else:
                w += 1
        else:
            if in_band:
                bands.append(w)
                in_band = False
    if in_band:
        bands.append(w)
    bands = [b for b in bands if b >= min_band]
    return len(bands), bands


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=CHARS_DIR)
    ap.add_argument("--threshold", type=float, default=0.5,
                    help="Column-density threshold as fraction of max (0.3-0.6 reasonable)")
    ap.add_argument("--min-band", type=int, default=4,
                    help="Minimum band width in pixels to count as a figure")
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(args.dir, "char_*.png")),
                   key=lambda p: int(re.search(r"char_(\d+)", p).group(1)))
    multi = []
    for fp in files:
        cid = int(re.search(r"char_(\d+)", fp).group(1))
        sheet = Image.open(fp).convert("RGBA")
        if sheet.size != (672, 576):
            continue
        # Idle frame is at col=1, row=0 of the LPC 7x3 grid (96x192 cells)
        idle = sheet.crop((96, 0, 192, 192))
        n_bands, widths = detect(idle, args.threshold, args.min_band)
        if n_bands > 1:
            try:
                with open(fp.replace(".png", ".json")) as f:
                    name = json.load(f).get("name", "?")
            except Exception:
                name = "?"
            multi.append((cid, name, n_bands, widths))

    print(f"checked {len(files)} chars at threshold={args.threshold}, min_band={args.min_band}")
    if not multi:
        print("ALL SINGLE-FIGURE")
        return 0
    print(f"MULTI-FIGURE: {len(multi)}")
    for cid, name, n, w in multi:
        print(f"  #{cid:<3} {name:<28} bands={n} widths={w}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
