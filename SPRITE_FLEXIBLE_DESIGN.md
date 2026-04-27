# Sprite-Size Flexible Architecture (设计)

**触发**: user 原话 "我们这个agents viz项目不够灵活啊。应该什么size的人物都能放进去才对吧。只要遵守特定规则就好。"

**问题**: webview.html 把 sprite 维度硬编码到 CSS:
- `background-size: 336px 288px` (sheet 尺寸)
- `width: 48px; height: 96px` (cell 尺寸)
- `background-position: -48px 0px` (具体 cell 偏移)

每加新角色 / 新尺寸都要改 ~30 行 CSS + 13 个 keyframes。反 flexibility。

---

## 架构设计

### 1. 每角色一个 manifest.json

`extension/media/characters/char_0.png` + `extension/media/characters/char_0.json`:

```json
{
  "version": "1.0",
  "sheet": { "width": 672, "height": 576 },
  "cell":  { "width": 96,  "height": 192 },
  "grid":  { "cols": 7, "rows": 3 },
  "frames": {
    "walk1":   {"col": 0, "row": 0},
    "walk2":   {"col": 1, "row": 0},
    "walk3":   {"col": 2, "row": 0},
    "type1":   {"col": 3, "row": 0},
    "type2":   {"col": 4, "row": 0},
    "read1":   {"col": 5, "row": 0},
    "read2":   {"col": 6, "row": 0},
    "rightIdle": {"col": 1, "row": 2}
  },
  "displaySize": { "width": 60, "height": 88 }
}
```

`displaySize` 是 `.room-char` 屏上像素尺寸（保持兼容 88px 行高）。
`sheet/cell` 是 PNG 实际尺寸（任意，flexibility 来源）。
`frames` 是 named cells, CSS 用名字不用数字。

### 2. Extension 注入 CSS variables

`extension.ts` 加载 char manifest, 通过 webview message 传 sprite metadata:

```ts
const manifest = JSON.parse(fs.readFileSync(`media/characters/char_${i}.json`));
spriteUris.push({
  data: 'data:image/png;base64,' + b64,
  manifest
});
```

### 3. Webview CSS 用 var()

替换:
```css
.avatar .pixel {
  width: 48px; height: 96px;
  background-size: 336px 288px;
  background-position: 0 0;
}
```

为:
```css
.avatar .pixel {
  width: var(--display-w, 60px);
  height: var(--display-h, 88px);
  background-size: var(--sheet-w) var(--sheet-h);
  background-position: var(--frame-pos, 0 0);
  /* image-rendering: pixelated; from existing */
}
```

每 `.avatar` 元素 inline style 注入:
```html
<div class="avatar"
     style="--sheet-w: 672px; --sheet-h: 576px;
            --display-w: 60px; --display-h: 88px;
            --frame-w: 96px; --frame-h: 192px;
            background-image: url(...)">
</div>
```

### 4. 动画 keyframes 用 named frames

替换 hardcoded:
```css
@keyframes walkDown {
  0%,100% { background-position:   0px 0px; }
  25%     { background-position: -48px 0px; }
  50%     { background-position: -96px 0px; }
}
```

为 JS-driven (因为 keyframes 不能用 var()):

```js
function setFrame(el, frameName) {
  const m = el._manifest;
  const f = m.frames[frameName];
  el.style.backgroundPosition = `-${f.col * m.cell.width}px -${f.row * m.cell.height}px`;
}

// Animation loop
let walkFrame = 0;
const walkSeq = ['walk1', 'walk2', 'walk3', 'walk2'];
setInterval(() => {
  for (const el of document.querySelectorAll('.avatar.busy .pixel')) {
    setFrame(el, walkSeq[walkFrame % 4]);
  }
  walkFrame++;
}, 137); // 0.55s/4 = 137ms
```

(替换 13 个 @keyframes 为一组 JS 时序循环)

### 5. 兼容现 LPC sheet

老 char_1..5 用默认 manifest:
```json
{ "sheet": {"width":336,"height":288}, "cell":{"width":48,"height":96}, ... }
```

或 webview 在没 manifest 文件时 fallback 到 LPC 默认。

---

## 实施 Step-by-Step

| step | 内容 | 工时 | 风险 |
|---|---|---|---|
| 1 | 写 char_0.json (v17c) + 默认 LPC manifest 给 char_1..5 | 10 min | 低 |
| 2 | extension.ts 加载 manifest 同 sprite 一起塞进 webview | 10 min | 低 |
| 3 | 替换 CSS hardcoded → CSS variables | 30 min | 中 (丢漏致样式) |
| 4 | @keyframes → JS 动画驱动 | 45 min | 中 (现 13 keyframes,要复刻动画 timing) |
| 5 | 浏览器 preview HTML + VS Code reload 测 | 30 min | 中 |
| **合计** | **~2 hr** | |

---

## 触发回归条件

- v17c 在 VS Code 实测能正常显示 (animations work, identity 好)
- 加新角色 (dev_brown / dev_red / 其他人种) 只需 PNG + json, 不动 webview
- 角色尺寸自由 (chibi 1:1.5 / 英雄 1:1.4 / pixel 1:2 都接)

---

## 比"硬改 2x"好在哪

| 维度 | 硬 2x | flexible |
|---|---|---|
| 当前 v17c 用 | ✅ | ✅ |
| 加 chibi (96x96 cell) | ❌ 又改 CSS | ✅ |
| 加 1:3 高 sprite | ❌ 再改 | ✅ |
| 维护性 | 改 30 行 + 13 keyframes | 1 个 JSON |
| 心智成本 | "为啥这里 96 那里 192" | "看 manifest" |

---

## 来源

- 调研路线 2 设计文档 (`FURNITURE_COMPOSITION_DESIGN.md`) anchor metadata 同思路
- 业界: TexturePacker JSON / Aseprite slices / PixiJS sprite atlas
- ComfyUI 动画工作流也用 manifest 定 frame map
