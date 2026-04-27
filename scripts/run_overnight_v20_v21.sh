#!/bin/bash
# Overnight chain: wait v20 (80 sprites) → v21 (100 sprites)
cd "C:/Users/Yusheng Ding/Desktop/projects/agents-viz"

echo "=== Overnight Stage 1: v20 (16 chars × 5 actions = 80 sprites) ==="
until [ "$(ls C:/Users/Yusheng\ Ding/Desktop/projects/ComfyUI/output/agents_viz/sdxl/ 2>/dev/null | grep '^v20_dev_' | wc -l)" -ge 80 ]; do
  D=$(ls "C:/Users/Yusheng Ding/Desktop/projects/ComfyUI/output/agents_viz/sdxl/" 2>/dev/null | grep '^v20_dev_' | wc -l)
  echo "$(date +%H:%M:%S) v20=$D/80"
  sleep 120
done
echo "=== v20 done at $(date +%H:%M:%S) ==="

echo "=== Overnight Stage 2: v21 (5 new actions × 20 chars = 100 sprites) ==="
python scripts/batch_v21_more_actions.py 2>&1
echo "=== v21 done at $(date +%H:%M:%S) ==="
