#!/bin/bash
# Wait for v21 (100 sprites) then run v22 (100 dev-archetype sprites)
cd "C:/Users/Yusheng Ding/Desktop/projects/agents-viz"

echo "=== Stage 1: wait for v21 (100 sprites) ==="
until [ "$(ls C:/Users/Yusheng\ Ding/Desktop/projects/ComfyUI/output/agents_viz/sdxl/ 2>/dev/null | grep '^v21_dev_' | wc -l)" -ge 100 ]; do
  D=$(ls "C:/Users/Yusheng Ding/Desktop/projects/ComfyUI/output/agents_viz/sdxl/" 2>/dev/null | grep '^v21_dev_' | wc -l)
  echo "$(date +%H:%M:%S) v21=$D/100"
  sleep 180
done
echo "=== v21 done at $(date +%H:%M:%S) ==="

echo "=== Stage 2: v22 (10 dev archetypes × 10 actions = 100 sprites) ==="
python scripts/batch_v22_dev_archetypes.py 2>&1
echo "=== v22 done at $(date +%H:%M:%S) ==="
