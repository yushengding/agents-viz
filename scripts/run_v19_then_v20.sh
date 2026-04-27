#!/bin/bash
# Wait for v19 batch (3 chars × 5 = 15 sprites) then start v20 (16 chars × 5 = 80 sprites)
cd "C:/Users/Yusheng Ding/Desktop/projects/agents-viz"

echo "=== Stage 1: wait for v19 (15 sprites) ==="
until [ "$(ls C:/Users/Yusheng\ Ding/Desktop/projects/ComfyUI/output/agents_viz/sdxl/ 2>/dev/null | grep '^v19_dev_' | wc -l)" -ge 15 ]; do
  D=$(ls "C:/Users/Yusheng Ding/Desktop/projects/ComfyUI/output/agents_viz/sdxl/" 2>/dev/null | grep '^v19_dev_' | wc -l)
  echo "$(date +%H:%M:%S) v19=$D/15"
  sleep 60
done
echo "=== v19 done ==="

echo "=== Stage 2: v20 (16 chars × 5 = 80 sprites) ==="
python scripts/batch_v20_diverse.py 2>&1
echo "=== v20 done ==="
