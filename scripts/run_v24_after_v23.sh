#!/bin/bash
cd "C:/Users/Yusheng Ding/Desktop/projects/agents-viz"
SDXL="C:/Users/Yusheng Ding/Desktop/projects/ComfyUI/output/agents_viz/sdxl"

# Wait for v23 (100 sprites) then run v24
while [ "$(ls "$SDXL" 2>/dev/null | grep '^v23_dev_' | wc -l)" -lt 100 ]; do
  D=$(ls "$SDXL" 2>/dev/null | grep '^v23_dev_' | wc -l)
  echo "$(date +%H:%M:%S) v23=$D/100"
  sleep 180
done
echo "=== v23 done at $(date +%H:%M:%S) ==="
echo "=== v24 (10 femme × 10 = 100) ==="
python scripts/batch_v24_femme.py 2>&1
echo "=== v24 done at $(date +%H:%M:%S) ==="
