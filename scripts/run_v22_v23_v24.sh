#!/bin/bash
# Long overnight chain: v22 (running) → v23 → v24 → v25
cd "C:/Users/Yusheng Ding/Desktop/projects/agents-viz"
SDXL="C:/Users/Yusheng Ding/Desktop/projects/ComfyUI/output/agents_viz/sdxl"

wait_for() {
  local prefix=$1; local target=$2
  while [ "$(ls "$SDXL" 2>/dev/null | grep "^${prefix}_dev_" | wc -l)" -lt "$target" ]; do
    D=$(ls "$SDXL" 2>/dev/null | grep "^${prefix}_dev_" | wc -l)
    echo "$(date +%H:%M:%S) $prefix=$D/$target"
    sleep 180
  done
}

echo "=== Chain Stage 1: wait for v22 (100 sprites) ==="
wait_for v22 100
echo "=== v22 done at $(date +%H:%M:%S) ==="

echo "=== Chain Stage 2: v23 (10 dev subtypes × 10 actions = 100) ==="
python scripts/batch_v23_dev_subtypes.py 2>&1
echo "=== v23 done at $(date +%H:%M:%S) ==="

echo "=== Chain Stage 3: v24 (10 femme × 10 actions = 100) ==="
python scripts/batch_v24_femme.py 2>&1
echo "=== v24 done at $(date +%H:%M:%S) ==="

echo "=== ALL 50 chars × 10 actions = 500 sprites complete ==="
