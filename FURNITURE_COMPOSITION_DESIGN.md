# 角色 + 家具/设备拼接设计文档（路线 2，长期方向）

**状态**: 设计存档，未实施。等当前 v15/v16 baseline 稳定后回来做。
**写时**: 2026-04-26 (session 末尾)
**触发**: user 问 "桌椅设备位置和姿态匹配怎么做，业界做法?" → 调研后选 anchor + 程序拼接路线，存设计待回头探索

---

## 问题陈述

当前 sprite 生成（v15/v16）把家具（椅子、键盘）prompt 进角色图里一起出。问题:
- AI 画家具比例不准（椅子歪、键盘大小不对）
- 一个角色 × 一个家具 = 1 张图。N 角色 × M 家具 = N×M 组合爆炸
- 角色姿势如果稍变（坐高/坐姿），原 baked 椅子就对不上了

业界共识（调研结论）: **角色 + 家具分开生成 + anchor point + 程序拼接** 是正解。Aseprite slices 是桌面 indie 事实标准，2026 趋势是 YOLO11-Pose 自动检测 keypoints。

---

## 路线 2 架构

```
┌──────────────────────────────────────────────────────┐
│  ComfyUI 生成阶段 (一次性 per 角色 / per 家具)        │
├──────────────────────────────────────────────────────┤
│ 角色 sprite:                                          │
│   纯角色 prompt (无家具) + OpenPose CN 锁姿势         │
│   + InstantID/Kontext 锁身份                         │
│                                                       │
│ 家具/设备 sprite:                                     │
│   纯家具 prompt + Canny CN 锁轮廓                    │
│   或 isometric_setting LoRA                          │
└──────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│  自动 anchor 提取 (Karpathy AI-自标注)                │
├──────────────────────────────────────────────────────┤
│ YOLO11-Pose (Ultralytics) 跑每张 sprite:              │
│   detect keypoints: 头/肩/肘/腕/髋/膝/踝              │
│   写 JSON: hand_L=(x,y), seat=(x,y), foot=(x,y)      │
│                                                       │
│ 家具 anchor 半自动:                                   │
│   chair.png: seat_top=(x,y) (用户手标 1 次/家具)      │
│   keyboard.png: center=(x,y), height=(x,y)           │
└──────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│  Runtime 拼合 (webview canvas / Godot)                │
├──────────────────────────────────────────────────────┤
│ // pseudo code                                        │
│ const charPos = {x:200, y:300};                       │
│ const charAnchor = char.anchors.seat;                 │
│ const chairAnchor = chair.anchors.seat_top;           │
│ ctx.drawImage(chair,                                  │
│   charPos.x + charAnchor.x - chairAnchor.x,           │
│   charPos.y + charAnchor.y - chairAnchor.y);          │
│ ctx.drawImage(char, charPos.x, charPos.y);            │
└──────────────────────────────────────────────────────┘
```

---

## 实施步骤（按工程量从小到大）

### Step 1: JSON anchor schema 定义（10 分钟）

```json
{
  "version": "1.0",
  "frames": {
    "dev_blonde/idle.png": {
      "size": {"w": 384, "h": 563},
      "anchors": {
        "head_top":  {"x": 0.50, "y": 0.10},
        "hand_L":    {"x": 0.30, "y": 0.55},
        "hand_R":    {"x": 0.70, "y": 0.55},
        "seat":      {"x": 0.50, "y": 0.95},
        "feet":      {"x": 0.50, "y": 0.99}
      }
    },
    "dev_blonde/sit.png": {
      "anchors": {
        "seat":      {"x": 0.50, "y": 0.65},
        "back":      {"x": 0.50, "y": 0.45}
      }
    },
    "furniture/chair.png": {
      "anchors": {
        "seat_top":  {"x": 0.50, "y": 0.40},
        "back_top":  {"x": 0.50, "y": 0.10}
      }
    }
  }
}
```

(0-1 normalized 坐标，跨尺寸不变)

### Step 2: ComfyUI dual-CN workflow（2-3 小时）

```python
# Stage A 修改: 只生角色，prompt 砍家具，加 "transparent BG, isolated character, no furniture"
# Stage B 加 Canny CN: 接一张空椅子线稿, strength 0.5, 让模型留出椅子位置但不画
```

或更简单: `batch_v17_char_only.py` 重新生 5 角色 sprite, 完全不画家具.

### Step 3: 单独生家具 sprite（1 小时）

```python
# batch_furniture.py
ITEMS = [
    ("chair", "wooden office chair, side view, isolated transparent background, pixel art"),
    ("keyboard", "small mechanical keyboard, top-down view, isolated, pixel art"),
    ("desk", "wooden desk with monitor, side view, pixel art"),
]
# 同 v16 FLUX Kontext + Pixel LoRA pipeline, 但无身份 ref
```

### Step 4: YOLO11-Pose 自动检测（半天）

```python
# auto_anchor.py
from ultralytics import YOLO
m = YOLO("yolo11n-pose.pt")  # ~6MB COCO 17-keypoint model
for sprite_path in glob("extension/media/.../dev_blonde/*.png"):
    res = m(sprite_path)
    kpts = res[0].keypoints.xyn[0]  # normalized
    # COCO order: nose, eye_L, eye_R, ... wrist_L=9, wrist_R=10, hip_L=11, hip_R=12, ankle_L=15, ankle_R=16
    anchors = {
        "head_top": kpts[0].tolist(),
        "hand_L":   kpts[9].tolist(),
        "hand_R":   kpts[10].tolist(),
        "seat":     [(kpts[11][0]+kpts[12][0])/2, (kpts[11][1]+kpts[12][1])/2],
        "feet":     [(kpts[15][0]+kpts[16][0])/2, (kpts[15][1]+kpts[16][1])/2],
    }
    save_anchor_json(sprite_path, anchors)
```

YOLO11n-pose 在 anime/pixel sprite 上可能不准（训练数据是真人照片）。备选: 用 OpenPose 或自己 fine-tune 。先跑看准确度，再决定。

### Step 5: webview composite 代码（1 小时）

```typescript
// extension/src/sprite_composer.ts
interface AnchorJSON { frames: Record<string, {anchors: Record<string,{x:number,y:number}>}>; }

function composite(
    ctx: CanvasRenderingContext2D,
    char: HTMLImageElement, charKey: string,
    accessory: HTMLImageElement, accKey: string,
    anchorPair: [string, string],  // e.g. ['seat', 'seat_top']
    pos: {x:number, y:number},
    anchors: AnchorJSON,
    drawAccBefore = true
) {
    const charA = anchors.frames[charKey].anchors[anchorPair[0]];
    const accA  = anchors.frames[accKey].anchors[anchorPair[1]];
    const accX = pos.x + charA.x*char.width - accA.x*accessory.width;
    const accY = pos.y + charA.y*char.height - accA.y*accessory.height;
    if (drawAccBefore) ctx.drawImage(accessory, accX, accY);
    ctx.drawImage(char, pos.x, pos.y);
    if (!drawAccBefore) ctx.drawImage(accessory, accX, accY);
}

// usage:
// sit + chair (chair behind):
composite(ctx, devBlonde.sit, 'dev_blonde/sit.png',
          chairImg, 'furniture/chair.png',
          ['seat', 'seat_top'],
          {x:200, y:100}, anchors, true);
// typing + keyboard (keyboard in front):
composite(ctx, devBlonde.typing, 'dev_blonde/typing.png',
          kbImg, 'furniture/keyboard.png',
          ['hand_L', 'center'],
          {x:200, y:100}, anchors, false);
```

---

## 工时预算

| Step | 工时 | 阻塞依赖 |
|---|---|---|
| 1 schema | 10 min | 无 |
| 2 ComfyUI 重生角色 | 2-3h | v16 baseline 稳定 |
| 3 家具 sprite 库 | 1h | step 2 完 |
| 4 YOLO11-Pose 自动 anchor | 4h | step 2/3 完 |
| 5 webview composite | 1h | step 4 完 |
| **合计** | **~10h** | 一个完整 session |

---

## 决策点 / 待回头思考

1. **YOLO11-Pose 在 pixel anime sprite 上准吗?** 先用 1 张测准确度再投入. 不准的话 fallback 到手工标注 (Aseprite slices) — 5 张 sprite × 4 anchor = 20 点击 ≈ 10 分钟.
2. **家具风格一致性** — chair.png 用 FLUX Kontext 同身份 ref 出？还是单独自由生？后者更灵活，前者风格更统一.
3. **z-sort 怎么处理深度** — 椅子有些部分在角色背后 (椅背), 有些在前面 (椅腿绕过角色脚)? 需要把家具切成 chair_back.png + chair_front.png 两层. 复杂度+1.
4. **动画兼容** — 当前 v15 用 Tween 1px y bob. Anchor 拼接后 char 抖动时家具不抖, 否则一起抖. 设计 webview 时决定是 char-only 抖还是 char+furniture group 抖.

---

## 相关来源

- Aseprite Slices 文档: https://www.aseprite.org/docs/slices/
- Aseprite issue #1357 (per-frame pivot): https://github.com/aseprite/aseprite/issues/1357
- Stardew sitting overlay tutorial: https://stardewmodding.wiki.gg/wiki/Tutorial:_Adding_Sitting_to_Custom_Map_Chairs
- PixelLab Skeleton Animation: https://www.pixellab.ai/docs/tools/skeleton-animation
- YOLO11-Pose Ultralytics: https://docs.ultralytics.com/tasks/pose/
- TexturePacker JSON 格式: https://www.codeandweb.com/texturepacker
- ComfyUI dual ControlNet workflow 参考: https://comfyui.org/en/image-style-transfer-controlnet-ipadapter-workflow

---

## 触发回归条件

回头做这个的信号:
- v15 / v16 baseline 已锁，5 sprite 接进 extension 测过
- 用户加新动作发现 baked 家具组合爆炸
- 有人想换风格/换家具，发现得重生整套 sprite
- 其他 dev 角色 (dev_brown / dev_red) 上线，每加一个 × 5 动作 = 5 张图，复用价值变大
