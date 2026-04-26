# agents-viz — Architecture & Code Tour

For: developers + AI agents that need to extend or debug this codebase.

> 给一个零上下文 AI 看完这个文件，能上手改任何模块。
> 也是 CSS 反模式 + 性能踩坑 + 数据流的"防再踩坑"档案。

---

## 1. Repo layout

```
agents-viz/
├── README.md              ← 用户入门
├── ARCHITECTURE.md        ← 本文件
├── DESIGN.md              ← 产品愿景 + 用户痛点 (v2 spec)
│
├── extension/             ← VS Code 扩展（**核心**）
│   ├── src/
│   │   ├── extension.ts   ← 扩展宿主入口，HTTP hook 服务器，文件扫描，缓存层
│   │   ├── webview.ts     ← Webview HTML loader + placeholder 替换
│   │   └── hook-forwarder.js  ← silent stdio→HTTP transport（每个 hook 进程一个）
│   ├── webview.html       ← **3000 行单文件**，所有前端逻辑（HTML + CSS + JS 内联）
│   ├── media/
│   │   ├── characters-lpc-composed/  ← 6 个 char_X.png（LPC 合成精灵）
│   │   ├── characters-generated/     ← AI 生成精灵备选
│   │   ├── rooms/                    ← 项目房间墙纸图（按项目名）
│   │   └── furniture/                ← 沙发等小道具
│   ├── package.json       ← VS Code 扩展 manifest
│   └── dist/              ← `npm run compile` 输出（不在 git）
│
├── scripts/               ← Python 辅助脚本（精灵合成、preview HTML 导出）
│   ├── compose_lpc_characters.py     ← LPC body+pants+shirt+head+hair+glasses 合成 char_*.png
│   └── export_webview_preview.js     ← 把 webview.html 拼合一个独立可在浏览器打开的 preview.html
│
└── vendor/                ← submodules：参考实现
    ├── pixel-agents       ← 像素角色精灵集
    └── agent-flow         ← 类似项目（不是依赖，仅参考）
```

外部数据（不在 repo）：
```
~/.agents-viz/                   ← 扩展自己的持久化目录
├── usage-cache.json             ← 文件级 usage 聚合缓存（scanCachedAll 的产出）
└── <hash>-<pid>.json            ← discovery 文件，hook-forwarder 用它找服务端

~/.claude/projects/<workspace-hash>/  ← Claude Code 自动管理（我们只读）
├── <session-id>.jsonl           ← 顶层 session 转录
└── <session-id>/subagents/      ← 子 agent 的转录（可选）
    └── agent-<hash>.jsonl
```

---

## 2. 数据流

```
                 ┌─────────────────────┐
                 │   Claude Code CLI   │  (用户开的多个 session)
                 └──────────┬──────────┘
                            │ 9 hook event types
                            ▼
              ┌──────────────────────────┐
              │ hook-forwarder.js        │  silent stdio→HTTP
              │ (一个 hook 进程一个)      │  延迟 < 5ms, 0 token
              └──────────┬───────────────┘
                         │ POST /event (Bearer token)
                         ▼
      ┌────────────────────────────────────┐
      │ extension.ts (HTTP server in       │
      │  extension host, ~/.agents-viz/    │
      │  discovery file 暴露端口)          │
      └─────────────┬──────────────────────┘
                    │
                    ├──→ in-memory eventBuffer
                    │
                    ├──→ panel.webview.postMessage('replay')
                    │     (推到 webview JS 里 ingest)
                    │
                    ├──→ scanCachedAll() — 周期性扫 JSONL 聚合 usage/prompts
                    │     ├─ 检 cache (size, mtime) → hit 直接复用
                    │     └─ miss → 全文件 read + 写 cache
                    │
                    └──→ panel.webview.postMessage('usage-update'/'prompt-costs-update')
                              │
                              ▼
                  ┌───────────────────────┐
                  │ webview.html (一个     │
                  │  iframe 内的整个 UI)   │
                  └───────────────────────┘
```

**关键路径**：
- **Live event**: hook → forwarder → extension HTTP → eventBuffer → webview postMessage → ingest() → renderAll()
- **History replay**: panel open → scanJsonlHistoryProgressive → 每个 session JSONL parse → batch postMessage → ingest()
- **Usage 聚合**: scanCachedAll → 读 cache.json → file-by-file 检 (size, mtime) → miss 时全读 → 更新 cache → postMessage usage-update

---

## 3. 模块详解

### `extension/src/extension.ts` (~880 行)

VS Code 扩展宿主代码。每次 panel 打开都会跑一遍 `hotReloadRebuild()`。

**关键职责**：
1. **HTTP hook 服务器** (`startHookServer`) — 监听本地端口，bearer token auth，接收 hook event
2. **Discovery 文件** — 写 `~/.agents-viz/<hash>-<pid>.json` 暴露端口给 forwarder
3. **Hook 自动配置** (`configureClaudeHooks`) — 把 forwarder 路径写进 `~/.claude/settings.json`
4. **Sprite/room 资源加载** — 读 `media/` 目录的 PNG 转 base64
5. **History 扫描**:
   - `parseSessionJsonl(sid)` — 单文件 → HookEvent[]，有内存 + 磁盘缓存
   - `scanJsonlHistoryProgressive` — 异步扫所有匹配 workspace 的 session
   - `loadMoreSessionHistory` — 分页加载更早事件（binary search）
6. **Usage/Cost 聚合** (`scanCachedAll`):
   - 走 `~/.claude/projects/*` 所有 JSONL
   - 用文件级缓存（key = filepath, invalidate by size+mtime）
   - 输出 per-session usage + per-prompt cost (top 50)
   - 1.5s/8s deadline 防卡死
7. **Subagent 父子关系**:
   - `Agent`/`Task` PreToolUse → 记 `tool_use_id → parent_session_id`
   - 后续带 `parent_tool_use_id` 的事件 → 标记 subagent，链回父
8. **Panel 生命周期**:
   - `agentsViz.open` 命令打开 panel
   - 监听 `webview.html` 文件变化做 hot reload
   - panel.dispose → 清理 server + discovery file

### `extension/src/webview.ts` (~50 行)

非常薄的 wrapper：每次 panel rebuild 都重读 `webview.html` 文件，做 placeholder 替换：

```ts
return html
  .replace(/__SPRITE_URIS__/g, JSON.stringify(opts.spriteUris))
  .replace(/__ROOM_IMAGES__/g, JSON.stringify(opts.roomImages))
  .replace(/__BUILD_STAMP__/g, buildStamp)
  .replace(/__SOFA_FRONT__/g, opts.sofaFront)
  .replace(/__SOFA_SIDE__/g, opts.sofaSide)
  .replace(/__SESSION_USAGE__/g, JSON.stringify(opts.sessionUsage))
  .replace(/__PROMPT_COSTS__/g, JSON.stringify(opts.promptCosts));
```

**⚠️ 必须用 `/g` 正则**：JS `.replace(string, ...)` 只换首个匹配，placeholder 可能在同行出现多次（典型：`(typeof X !== 'undefined') ? X : []` 模式）。
详见 `feedback_js_replace_first_only` memory。

### `extension/webview.html` (~3000 行)

**所有前端逻辑都在这里**——HTML + 内联 `<style>` + 内联 `<script>`。
之所以单文件不切分：可以从磁盘热重载（`fs.readFileSync` 每次重读），改完关 panel 再开就生效，不用重编 extension.js。

**主要模块**（搜索注释定位）：

| 区域 | 行号附近 | 内容 |
|------|---------|------|
| CSS theme tokens | 1-20 | `--sofa-*` / `--bed-*` / `--blanket-*` 共享 var |
| Sidebar styles | 50-450 | session list、avatar、search box |
| Floor plan + room | 600-1000 | room、wall、whiteboard、bedroom、pod-cell |
| Animations | 200-500 | walking、shake、podLed、podZzz 等 keyframes |
| Tool color palette | ~1300 | 每个工具类型的 hue（Edit 蓝、Bash 紫等） |
| Constants & helpers | ~1500 | `STRIP_LEN`、`fmtCost`、`fmtTok`、`projectName` |
| `ingest(event)` | ~1700 | 状态机入口：busy/waiting/monitoring/cwdFreq 票统计 |
| `sessionProject(meta)` | ~1380 | 投票决定房间归属 (cwdFreq + cross-project) |
| `renderFloorPlan` | ~1820 | 计算公式 → 创建 room/slots/bedroom DOM |
| `pod-cell` 子元素布局 | ~840-940 | 蛋舱独立 DOM 模板（**不复用 .room-char**） |
| `renderTimeline` | ~2470 | 选中 session 的事件抽屉 |
| `updateDailyStrip` | ~2380 | 顶栏每日汇总 |
| `updateHeatmap` | ~2300 | 7d×24h 网格 |
| `updateCostboard` | ~2160 | top 30 烧钱 prompt |
| `drawSubagentConnections` | ~2440 | SVG 父子虚线 overlay |
| Message handler | ~2840 | `replay` / `usage-update` / `prompt-costs-update` / `history-chunk` |
| Toggle handlers | ~2940 | heatmap / costboard chevron |

### `extension/src/hook-forwarder.js`

每个 Claude Code hook 触发都会启动一次这个进程。
读 `~/.agents-viz/discovery` 找 extension 的端口，POST 一个 JSON。
失败静默退出（不能 crash 真正的 Claude session）。

---

## 4. 关键状态机

### 单 session 状态（`webview.html` 内）

每个 session `meta` 维护：
```js
{
  busy: boolean,         // 在跑工具
  waiting: boolean,      // 等用户输入
  monitoring: boolean,   // 在 polling bg shell
  cwdFreq: Map,          // projectName → 累计权重
  dominantProject: ?,    // 缓存 cwdFreq 众数（'__cross__' 表跨项目）
  firstTs, lastTs,       // 时间锚点
  charIdx,               // 哪个 sprite (0-5)
  ...
}
```

**事件 → 状态变化** (`ingest`)：
- `UserPromptSubmit` → busy=true, waiting=false
- `PreToolUse` → busy=true; 如果 Bash 带 `run_in_background:true` → 记 lastBgShellTs
- `PostToolUse` → 不变（保持 busy 直到 Stop）
- `Stop` → busy=waiting=monitoring=false
- `Notification`：
  - 如果 last bg shell < 5min → monitoring=true
  - 否则 → waiting=true

**视觉投影**：
- `age <= 1h` 且非空状态 → 站立 + ⚡/🔔/🔍 徽章
- `age > 1h` 且 `age < 24h` → 沙发坐姿 (`.room-char.stale`)，无徽章
- `age > 24h` → 蛋舱 (`.pod-cell`)，💤 徽章

**Zombie sweeper** (`sweepZombieStates`)：1h 没活动 → 强制清 busy/waiting/monitoring。
防止 PreToolUse 后没 Stop 的 session 卡住"忙"状态显示永久 ⚡。

### 项目分类（投票）

每条事件按以下权重投票给一个 project：

| 信号 | 权重 | 触发条件 |
|------|------|---------|
| Edit / Write / MultiEdit / NotebookEdit | 5 | tool_input.file_path 解析出项目名 |
| Read | 1 | tool_input.file_path |
| Grep / Glob | 0.5 | tool_input.path |
| 当前 cwd | 0.2 | 每条带 cwd 的事件兜底 |

**dominantProject** 计算：
- 排序 cwdFreq → `[(project, votes)...]`
- 第二名 / 第一名 ≥ 30% → 跨项目 → `__cross__` → 进 `📁 projects` hub
- 否则 → 第一名 project

**例**: 一个 session 跑了 5 个 Edit 在 `idle_alchemist`、3 个 Read 在 `agents-viz`：
- idle_alchemist: 25, agents-viz: 3 → 比例 12% < 30% → 落 idle_alchemist 房间

### 房间布局公式（`renderFloorPlan`）

```js
CHAR_BOX = 88          // 一个 awake char + sofa 视觉 buffer
POD_BOX  = 58          // 一个蛋舱 + buffer
ROW_GAP  = 18, POD_ROW_GAP = 28
SLOT_PAD_X = 36 (slot 内 padding)
BEDROOM_PAD_X = 28 (bedroom 内 padding)
ROOM_EDGE_PAD = 12 (room 左右边距)
ZONE_GAP = 12 (work zone 和 bedroom 间距)
WALL_H = 110 (固定墙高，不缩放)

// Pack: cols = round(√(n × aspect))
workGrid = packGrid(awakeCnt, 2.0)   // aspect 2.0 偏横向
podGrid  = packGrid(podCnt,   2.0)

workInner = workGrid.cols × CHAR_BOX + (cols-1) × ROW_GAP
podInnerW = podGrid.cols  × POD_BOX  + (cols-1) × 10
workBoxW  = workInner + SLOT_PAD_X
podBoxW   = podInnerW + BEDROOM_PAD_X

roomW = ROOM_EDGE_PAD + workBoxW + ZONE_GAP + podBoxW + ROOM_EDGE_PAD
roomH = WALL_H + max(workH, podH) + FLOOR_PAD

clamp [180, 1100] × [200, 680]
```

`titleMinW = 项目名长度 × 8 + 60` 也加入 max 计算（白板要写得下）。

---

## 5. 缓存层

### `~/.agents-viz/usage-cache.json`

格式：
```json
{
  "/abs/path/to/session.jsonl": {
    "size": 12345678,
    "mtime": 1714134567890,
    "sessionId": "uuid-or-parent-uuid",
    "cwd": "C:/Users/X/Desktop/projects/...",
    "usage": { "input": 12000, "output": 3000, "cost": 1.42, ... },
    "prompts": [ { "promptText": "...", "cost": 0.05, ... }, ... ]
  },
  ...
}
```

**Invalidation**：file 的 (size, mtime) 不变 → 直接复用 entry。变了 → 全文件重读。

**为什么不用 mtime 单独**：mtime 可能因为 touch 等操作变但内容不变；size 不变但 mtime 变可能因为同步工具碰过。两个都 match 才安全。

**为什么不用 hash**：MD5 整个 30MB 文件比读还慢。

**Subagent 累计**：`agent-*.jsonl` 文件名是 agent 自己的 hash，但事件内 `sessionId` 字段是父 UUID。`scanFileWithCache` 会读首个 sessionId 字段当 key → 子 agent 消费累计到父 session 的 usage entry。

**清理**：手动删 cache.json 即可下次全重扫。未来可加 LRU 自动 prune。

---

## 6. CSS 教训（强烈建议读）

### 反模式 1：多 modifier class 共享 ::before/::after

**现象**：长 stale char 同时挂 `.stale` 和 `.long-stale` class。两个 class 都定义了 `::before`。同特异性，CSS 按声明顺序选 winner，但**只针对每个 property**。

```css
.room-char.stale::before  { height: 26px; bottom: 18px; }    /* 沙发靠背 */
.room-char.long-stale::before { top: 0; bottom: 6px; ... }  /* 蛋壳 */
```

长 stale 的 ::before 实际：`top: 0`, `bottom: 6` 来自 long-stale，但 `height: 26` 来自 stale 没被覆盖 → 蛋壳被压成 26px 高（半截）。

**怎么避免**：新视觉状态用**独立 DOM 子树 + 独立 class**：

```html
<!-- 不要 -->
<div class="room-char long-stale">  <!-- ::before 共用 -->

<!-- 要 -->
<div class="pod-cell">                    <!-- 完全独立 -->
  <div class="pod-shell"></div>
  <div class="pod-dome"></div>
  <div class="pod-head"></div>
  ...
</div>
```

**应用到 agents-viz**：`.pod-cell` 是教训后重构的，不与 `.room-char` 共享任何 CSS。沙发坐姿沿用 `.room-char.stale` 因为只用了一层 modifier，没踩到坑。

### 反模式 2：JS `.replace(string, ...)` 同行多次出现的 placeholder

```js
const X = (typeof __SESSION_USAGE__ !== 'undefined') ? __SESSION_USAGE__ : {};
//                  ^^^^^^^ 第一个                       ^^^^^^^ 第二个
```

`html.replace('__SESSION_USAGE__', JSON.stringify(...))` **只换第一个**！
第二个残留为字面量 → JS 引擎 ReferenceError → 整个 webview 死。

**防御**：`webview.ts` 所有 placeholder 替换用 `/regex/g`（已修，见 commit 历史）。

### 反模式 3：性能优化损失数据完整性

最初的 `scanJsonlUsage` tail-read（只读最后 1MB）让首次加载快，但
lifetime cost 全错（30MB 大 session 只统计最后 1MB ≈ 5K 行）。
用户立刻发现"数字重置了"。

**正解**：上磁盘缓存。首次慢但准确，后续秒返回。

### 应用规则

- 写新视觉状态 → 用独立 DOM 模板，不复用 `.room-char` ::before/::after
- 写 placeholder 替换 → `/g` 正则
- 性能优化前问"会不会损失关键数据"

---

## 7. 扩展指南（怎么加新功能）

### 加一个新的状态徽章
1. `webview.html` 找 `ingest()` — 加 meta 字段 + 状态变迁逻辑
2. 找 `renderFloorPlan` 内的 badge 计算分支 — 加新 emoji
3. 如有动画 → CSS keyframes + `.room-char.<state> .char-badge` 选择器
4. **不要** 再加 `.room-char.<state>::before/::after` — 用单独子元素

### 加一个新的房间分区
（参考 #39 zone subdivision，目前 deferred）
1. zoneFreq Map 在 ingest 里更新
2. `dominantZone(meta)` 返回 'dev'/'test'/'asset'/...
3. CSS：在 `.room-floor` 里用 grid 划分子区
4. JS：char position 按 zone 锚点放（绝对定位 + transition）

### 加一个新的顶栏 section
1. HTML：在 `<main id="main">` 顶部添加
2. CSS：加 collapsible 样式（参考 `#heatmap-section`）
3. 创建 `update<Section>()` 函数，从 `bySession` / `sessionMeta` 读数据
4. 在 `renderAll` 末尾调用
5. Toggle handler：`vscode.setState({ ...state, <section>Open: bool })` 持久化

### 加一个新数据扫描器
1. `extension.ts` 加 `scanXxx(workspace)` 函数
2. 复用 `scanFileWithCache` 已有的 cache 入口（不要再写一份）
3. 在 `hotReloadRebuild` setTimeout 里调用 + postMessage
4. webview message handler 加 `case 'xxx-update'`

---

## 8. 测试 / 调试

### 实际渲染验证
**强制要求**：CSS 视觉改动后，必须用 Playwright 或浏览器看实际渲染。

```bash
# 生成独立 preview HTML（不依赖 VS Code）
node scripts/export_webview_preview.js
# → 输出 screenshots/preview.html

# 然后用 Chrome / Playwright 打开
```

`PREVIEW_SELECTED=<sid>` 环境变量可以预选某个 session。

### 看 hook 转发
- `~/.agents-viz/<hash>-<pid>.json` 存在表示 server 在跑
- `Output panel → Agents Viz` 看实时 log

### 强制重扫 usage
```bash
rm ~/.agents-viz/usage-cache.json
# 重开 panel，会全文件重扫一遍并写新 cache
```

---

## 9. 已知 P2/P3 遗留

- **#39 zone subdivision** — 房间内分区 (~280 行)，效果好但 ROI 偏低，pending
- **#41 cross-session live ticker** — 顶栏滚动事件直播条 (~100 行)，pending
- **cache 没 LRU** — `usage-cache.json` 会无限增长（每个 jsonl 一条 entry），多月后体积大，需要 prune 策略
- **sidebar 长 stale 还用 `.room-char.long-stale` 旧 CSS** — 没切到 `.pod-cell` 重构。当前没踩 bug 但不一致
- **agent-flow / pixel-agents submodule** — vendor/ 里有 git submodule warning，需要 `git submodule update --init` 或转成普通 dir

---

## 10. 文件读取顺序建议（给 AI）

零上下文 AI 来这个 codebase 上手，按以下顺序读：

1. **`README.md`** — 是什么、谁用、怎么装
2. **`ARCHITECTURE.md`**（本文件）— 整体架构 + 数据流
3. **`DESIGN.md`** — 产品愿景，理解每个 feature 解决的痛点
4. **`extension/src/extension.ts`** — 前 200 行（HTTP server 基建）
5. **`extension/webview.html`** — 1500-2500 行（核心渲染逻辑）
6. **`extension/webview.html`** — 800-940 行（pod-cell CSS，反模式案例）
7. **`~/.claude/projects/<hash>/<sid>.jsonl` 抽样几行** — 理解事件格式
8. **改动前**：grep `feedback_pseudo_element_collision`、`feedback_js_replace_first_only`
   两个 memory（`~/.claude/projects/.../memory/`）— 防再踩坑
