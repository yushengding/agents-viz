"""Run inside agents-comfyui-v2: rembg pass on v23/v24 raw PNGs lacking _alpha.png.

Designed to be docker-exec'd: paths are container-internal.
"""
import os, sys, glob, time
from PIL import Image
from rembg import remove, new_session

SDXL = "/root/ComfyUI/output/agents_viz/sdxl"
session = new_session("birefnet-general")  # cleaner than u2net for character cutouts

raws = []
for prefix in ("v23_", "v24_"):
    for raw in glob.glob(f"{SDXL}/{prefix}*_00001_.png"):
        name = os.path.basename(raw).replace("_00001_.png", "")
        alpha = f"{SDXL}/{name}_alpha.png"
        if not os.path.exists(alpha):
            raws.append((raw, alpha, name))

print(f"missing alphas: {len(raws)}", flush=True)
t0 = time.time()
for i, (raw, alpha, name) in enumerate(raws, 1):
    img = Image.open(raw).convert("RGBA")
    out = remove(img, session=session)
    out.save(alpha)
    if i % 10 == 0 or i == len(raws):
        elapsed = time.time() - t0
        rate = i / elapsed
        eta = (len(raws) - i) / rate if rate > 0 else 0
        print(f"  [{i}/{len(raws)}] {name}  rate={rate:.1f}/s  eta={eta:.0f}s", flush=True)

print(f"done {len(raws)} alphas in {time.time()-t0:.0f}s", flush=True)
