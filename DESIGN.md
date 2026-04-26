# Agents Viz — 虚拟 AI 工作室管理面板

> 状态: 设计 v2 · 2026-04-23 · 基于用户反馈调整方向

## 1. 项目定位 (重要)

**目标用户**: 非程序员,想直观管理 AI agent + 项目 + 人员分配的人 (产品经理/独立创作者/小工作室主理人)。

**核心价值**: 把 AI agent 可视化成"带平板的员工",在他们负责的"项目房间"里工作,一眼看清谁在做什么/去了哪/干了多久/在等谁。

**不是**: 给程序员看 tool-call 链路的 debug 工具 (那是 Agent Flow 的定位,我们用它但不局限于此)。

**核心隐喻**:
- **项目** = 一个房间/场景 (用户选或 AI 自动生成图片)
- **Agent** = 员工,手里拿着平板 (而不是坐在办公桌前)
- **工具** = 平板里的 app,agent 随身带去任意项目
- **任务** = 员工当前正在做的事
- **历史** = 员工的班次日志
- **休眠** = 员工回到共享休息室

---

## 2. 用户需求总览 (原话→功能)

| # | 原话 | 功能 |
|---|---|---|
| N1 | "查看单个 agent 的进度,在干啥" | 侧边栏 🔎详情页 + 每 agent 活动条 |
| N2 | "可以看历史的记录" | 竖向 Timeline (从上到下,不是横向) |
| N3 | "没法链接已经开启的 agent" | Attach 已有 session (Agent Flow 路线) |
| N4 | "hook 会浪费 token 吗" | Silent forwarder, 0 token |
| N5 | "不喜欢家具的概念" | **去掉办公桌/PC/盆栽**,agent 不坐在桌前 |
| N6 | "让任务去自己的项目所在地去工作,而不是都在电脑前" | **每项目一个房间/场景**,agent 在当前工作项目的房间里 |
| N7 | "电脑改成平板" | agent 随身带平板,暗示 tool-belt |
| N8 | "每个项目会有自己一个图片或者房间,可以自行设计,或者 AI 自动找一个合适的图片" | 项目场景图 = 用户选 / AI 生成 / 默认 |
| N9 | "休眠的时候放一块一个房间" | 共享 idle room / 休息室 |
| N10 | "非程序人员也能使用的,更直观管理项目进度+人员+agent 分配" | 面向 PM 的设计语言,不是开发者术语 |

---

## 3. 视觉系统 (M1 重设计)

### 3.1 概念模型

```
┌─────────────────────────────────────────────────────────────┐
│  🔎 Agent 详情页 (侧边栏)        │  主视图: 项目场景          │
│                                  │                            │
│  👤 Alice       [Read • 2s]      │  [项目房间: stickerfort]  │
│    └ ▓▓▓▓▓░░░░░ 最近工具活动条   │                            │
│                                  │   👤 Alice (拿平板,读文件)│
│  👤 Bob         [Bash • 15s]     │                            │
│    └ ▓░▓▓▓░▓▓░░                  │   👤 Bob (敲键盘,跑脚本)  │
│                                  │                            │
│  👤 Carol       [idle • 12m]     │  ──────────────────────    │
│    └ ░░░░░░░░░░ (在休息室)        │  [项目房间: agents-viz]   │
│                                  │                            │
│  [+ 新 agent]                    │   👤 Carol 缺席 (见左侧)   │
│                                  │                            │
│                                  │  ──────────────────────    │
│                                  │  [休息室] (idle agents)   │
│                                  │   👤 Carol                │
└──────────────────────────────────┴────────────────────────────┘
```

### 3.2 状态映射 (agent 形态)

| 状态 | 展示 |
|---|---|
| 在某项目工作 (has active tool) | 站在该项目房间里,手持平板,平板图标变 (📖 读/⌨️ 敲/🔍 搜) |
| 等用户输入 (Notification 事件) | 原地举手 + 🔔 图标闪 |
| idle | 走向休息室,图标变淡 |
| 长时间 idle (>10min) | 休息室坐下 |

**与 Pixel Agents 的差异**:
- 不用 "office" 单一场景,不用家具 (bin/bookshelf/desk/PC/plant 全砍)
- **每个 project (cwd) = 一个房间/场景**,agent 按当前工作的 cwd 走进对应房间
- 保留: 人物 sprite (char_0~5.png) + 行走动画 + 状态机

### 3.3 项目场景图来源

按优先级:
1. 用户手动上传/指定图片 (放 `~/.agents-viz/projects/{cwd-hash}.png`)
2. 默认基于项目类型的 stock 图 (game dev / trading / docs / research …)
3. AI 自动生成 (调 ComfyUI,用户已有工作流)
4. 最后兜底: 纯色 + 项目名

---

## 4. Timeline (M2 重设计)

### 4.1 布局

**竖向,从上到下 (最新在下方自动滚动)**:

```
┌───────────────┐
│  10:00  📂    │  ← SessionStart
│  │           │
│  10:00  💬    │  ← UserPrompt: "看看内存"
│  │           │
│  10:01  🔧    │  ← Bash: powershell ... (2.3s)
│  │     ✅    │
│  │           │
│  10:01  📖    │  ← Read: memory_pressure_logs/... (0.1s)
│  │     ✅    │
│  │           │
│  10:02  💭    │  ← Assistant response
│  │           │
│  10:03  💬    │  ← User: "关掉 mongod"
│  │           │
│  10:03  🧠    │  ← Subagent spawned: claude-code-guide
│  │     ├──   │
│  │     │ 🔍  │  ← nested: WebSearch (3.1s)
│  │     │ ✅  │
│  │     ├──   │
│  │     │ 📖  │  ← nested: Read
│  │     └─✅  │  ← subagent done
│  │           │
│  10:05  🔧   │  ← Bash: docker compose up  (12.4s)
│  (正在运行)  │
└───────────────┘
```

特性:
- 竖向时间轴,现在往下延伸
- Subagent 缩进展示,可折叠
- 每个 call 显示耗时,点击看参数/输出
- 实时: 正在运行的 call 显示 spinner + 已用时
- 颜色区分工具类型 (Read/Write 橙/Bash 蓝/Web 绿 等)

### 4.2 侧边栏迷你活动条

侧边栏每个 agent 条目右侧有一条**最近 N 分钟的工具活动条** (类似 GitHub contribution graph):

```
👤 Alice   [Read • 2s]
  最近活动: ▓▓▓▓▓░░░░▓▓ (每格 30s, 颜色=工具类型)
```

点击 agent → 主视图切到该 agent 的完整 Timeline。

---

## 5. 数据层 (不变)

### 5.1 Hybrid 数据源: JSONL 为真 + Hook 为速

| | Hook (push) | JSONL 轮询 (pull) |
|---|---|---|
| 延迟 | ~几百 ms | 500ms - 数秒 |
| 丢事件 | **接收端关就丢** | 不丢 |
| 历史回放 | ✗ | ✓ |
| Notification | ✓ | ✗ |

两路合并到同一 state store。

### 5.2 Hook 必须 silent forwarder

零 stdout, HTTP POST 到本地 server, `process.exit(0)`, 0 token 成本。

参考已有实现:
- `vendor/agent-flow/extension/src/hooks-config.ts` — auto-configure 6 事件
- `vendor/agent-flow/extension/src/hook-server.ts` — HTTP 接收端
- `vendor/agent-flow/extension/src/discovery.ts` — 多窗口 discovery 协议
- `vendor/pixel-agents/src/` (同样的分散实现)

### 5.3 六个 hook 事件全挂

SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop / Notification

---

## 6. 架构与参考代码

### 6.1 Fork 策略 (调整: 以 Agent Flow 为底)

**原因**: 看了源码, Agent Flow 的数据层远比 Pixel 完备:
- `codex-*.ts` 已支持 Codex (多 agent framework 适配已做一半)
- `permission-detection.ts` 专门检测"等用户输入"状态 (JSONL 没这信号)
- `subagent-watcher.ts` 处理子 agent 嵌套
- `token-estimator.ts` / `tool-summarizer.ts` 已有

Pixel 的优势集中在**视觉** (sprite + 状态机 + 布局 editor), 不是数据层。

**策略**:
- **以 Agent Flow 为基座 fork** (Apache-2.0, 商用友好)
- **视觉层重写** (不照抄 Pixel 的 office 概念, 因为 N5/N6 推翻了家具/集中办公桌)
- **选择性借用 Pixel 资产**: 人物 sprite (char_0~5.png), 行走动画, 状态机思路 (MIT)
- 项目"房间"是我们新设计, 不 fork

### 6.2 各模块的参考代码表

#### 数据层 (直接 fork/复用 Agent Flow)

| 功能 | 文件 | 复用方式 |
|---|---|---|
| Hook HTTP server | `vendor/agent-flow/extension/src/hook-server.ts` | 直接用, 改 discovery 目录名 |
| Discovery protocol | `vendor/agent-flow/extension/src/discovery.ts` | 直接用 |
| Auto-configure hooks | `vendor/agent-flow/extension/src/hooks-config.ts` | 直接用, 改 hook.js 路径 |
| JSONL tail + parse | `vendor/agent-flow/extension/src/transcript-parser.ts` + `session-watcher.ts` | 直接用 |
| Subagent 嵌套 | `vendor/agent-flow/extension/src/subagent-watcher.ts` | 直接用 |
| "等用户输入" 检测 | `vendor/agent-flow/extension/src/permission-detection.ts` | 直接用 (关键!) |
| 工具调用人话摘要 | `vendor/agent-flow/extension/src/tool-summarizer.ts` | 直接用 |
| Token 估算 | `vendor/agent-flow/extension/src/token-estimator.ts` | 直接用 |
| Event source 抽象 | `vendor/agent-flow/extension/src/event-source.ts` | 直接用 |
| Hook forwarder 脚本 | `~/.claude/agent-flow/hook.js` (本机已装, 103 行) | 直接 copy 改名 |

#### 视觉层 (选择性借用 Pixel + 自研)

| 功能 | 来源 | 说明 |
|---|---|---|
| 人物 sprite 资产 | `vendor/pixel-agents/webview-ui/public/assets/characters/` | 6 人物,MIT 可直接用 |
| 人物行走/打字动画 | `vendor/pixel-agents/webview-ui/src/office/` | 参考状态机,重写 |
| 家具/office 布局 | **不用** (N5 砍掉家具) | 跳过 |
| **项目房间场景** | **新做** | ComfyUI 生成 / 用户上传 / stock 图 |
| **休息室** | **新做** | 简单场景,idle agent 聚集 |
| **平板图标** | **新做** | 替代 PC, 图标随工具类型变 |
| Timeline 布局 | `vendor/agent-flow/app/src/` | 横向改竖向 |

#### 新做 (两个参考都没有)

| 功能 | 说明 |
|---|---|
| 跨房间 agent 移动动画 | agent 切换 cwd 时走动过场 |
| 侧边栏详情页 + 迷你活动条 | GitHub contribution graph 风格 |
| 项目场景图自动获取 | AI 生成 / stock 选图 |
| 点人物 ↔ 跳 Timeline 联动 | state store 共享 |

### 6.3 许可

- Agent Flow: Apache-2.0 → fork 后 agents-viz 用 Apache-2.0
- Pixel Agents: MIT → 借用资产和思路兼容
- **当前自用不发布**, 许可后顾

---

## 7. MVP 范围 (可执行版)

### v0 Spike (1 周) — 数据通路验证

目标: 证明 hook + JSONL 两路数据能进 state store, 先不美化。

- [ ] 扩展骨架 (TypeScript + esbuild)
- [ ] Fork Agent Flow `hook-server.ts` + `discovery.ts`, 改包名
- [ ] 复制 `hook.js` forwarder, 改名 agents-viz-hook.js
- [ ] Auto-configure 6 个 hook 事件到 `~/.claude/settings.json`
- [ ] Fork `transcript-parser.ts` + `session-watcher.ts` 两路数据进 state store
- [ ] 极简 webview: 一个列表显示所有活跃 session, 点击看纯文本事件流

### v1 (2-3 周) — 基本可用

- [ ] **竖向 Timeline**, 子 agent 嵌套, 实时更新
- [ ] **侧边栏 agent 详情页**, 迷你活动条
- [ ] **点击联动**: agent ↔ timeline ↔ 事件详情
- [ ] Claude Code 多 session 并发管理

### v2 (1-2 月) — 视觉升级

- [ ] **项目房间场景**: 用户指定图片 or AI 自动生成
- [ ] **人物 sprite**: 借用 Pixel, 简化状态机 (没家具只有 agent + 平板)
- [ ] **休息室**: idle agent 聚集场景
- [ ] **跨房间移动动画**: agent 切 cwd 时过场

### v3 (待定)

- [ ] 自定义场景/人物主题
- [ ] 分享/导出 session 日志
- [ ] 非 Claude 的 agent framework 适配 (Codex 已半成, Cursor/Copilot 未做)

---

## 8. 技术栈

| 组件 | 选型 |
|---|---|
| 宿主 | VS Code extension |
| 语言 | TypeScript |
| 打包 | esbuild |
| Webview | React + Vite |
| State | Zustand (或从 Agent Flow 抄它的 runtime.ts) |
| Timeline 渲染 | **竖向**: 自己写虚拟列表, 不用 React Flow (横向画布不适合竖向) |
| 场景渲染 | Canvas 2D (简单) 或 CSS 定位 + sprite (更简单) |
| 项目图生成 | 调本机 ComfyUI (用户已有) |
| Hook | Node stdin → HTTP POST |
| 事件存储 | 内存 + JSONL tail |

---

## 9. 未决问题

- [ ] 项目"房间"做 Canvas2D 小游戏 vs CSS+sprite 简单版? 倾向先 CSS 简单版, 看效果
- [ ] 侧边栏 agent 信息和 Timeline 在同一 webview 还是两个? 倾向同一个 (简单)
- [ ] 人物走路动画算不算 v1 必须? 不算, v2 再做
- [ ] ComfyUI 自动生成场景图的 prompt 模板?

---

## 10. 引用资源

**本地 vendor (可直接读):**
- `vendor/pixel-agents/` — MIT, 6.9k⭐, v1.3.0 (2026-04-14)
- `vendor/agent-flow/` — Apache-2.0, by patoles (CraftMyGame)

**本机已装扩展 (打包产物):**
- `~/.vscode/extensions/pablodelucca.pixel-agents-1.3.0/` (含 dist 资产)
- `~/.vscode/extensions/simon-p.agent-flow-0.4.9/`
- `~/.claude/agent-flow/hook.js` — 103 行 forwarder 实例

**memory:**
- workspace: `reference_claude_code_hook_patterns.md` — hook 架构模式
- 本项目: `~/.claude/projects/.../agents-viz/memory/MEMORY.md`

**官方:**
- Claude Code hooks docs
- VS Code extension API
