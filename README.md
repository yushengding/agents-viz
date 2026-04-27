# Agents Viz

> Languages: English (this file) · [简体中文](README.zh.md) · [AI guide / CLAUDE.md](CLAUDE.md) · [Devlog / DEVLOG.md](DEVLOG.md)

> A VS Code side panel that turns your running Claude Code sessions into pixel
> characters living in project rooms. See who's doing what, who's stuck, and
> how much you've spent — at a glance.

![preview](screenshots/preview.png)

> Above: actual running extension. Three rooms (`ai_intel_daily` with three
> sessions on a sofa, `agents-viz` busy at $3.4K lifetime cost, `stickerfort_clean`
> with three long-stale sessions in egg-shaped sleep pods). Top strip shows
> $3.4K / 4174M tokens / 22 agents / 1 live across all projects today. Sidebar
> shows live agents-viz session running a Bash tool.

---

## Why this exists

If you run Claude Code in 5+ terminals at once (multi-project work, ralph-loops,
exploratory + production sessions), you hit the same handful of pains:

- **"Who's doing what?"** — switching to each terminal and grep-ing history is slow.
- **"Stuck or just thinking?"** — `⏵` has been spinning for 5 minutes. Real work or zombie?
- **"How much did I spend?"** — the bill arrives at the end of the month.
- **"Where did I discuss X?"** — finding the session that touched some topic last week.

Agents Viz adds a side panel that gives all of this at a glance:

- 🏠 One room per project; each session is a pixel character in its room.
- ⚡/🔔/🔍/💤 status badges reflect busy/waiting/monitoring/idle in real time.
- 💰 Lifetime cost label above each character.
- 📊 Activity heatmap (7 days × 24 hours) and 💸 top costly-prompt leaderboard.
- 🛏 Long-idle sessions move into egg-shaped "sleep pods" so they don't crowd the workspace.

---

## Install (development build)

```bash
# 1. clone + build
git clone https://github.com/yushengding/agents-viz.git
cd agents-viz/extension
npm install
npm run compile          # one-shot
# or: npm run watch       # continuous during development

# 2. install the VSIX into VS Code
code --install-extension agents-viz-0.0.1.vsix
# or: VS Code Extensions panel → ⋯ → "Install from VSIX..."
```

After source changes:

1. `npm run compile` (or watch) → regenerates `extension/dist/extension.js`.
2. VS Code: `Cmd/Ctrl+Shift+P → Developer: Reload Window`.
3. Reopen the panel.

If you only edited `extension/webview.html` you do **not** need a recompile —
close and reopen the panel (the HTML is re-read from disk every time).

---

## First-run configuration

Open the panel: `Cmd/Ctrl+Shift+P → Agents Viz: Open Panel`.

You'll see "Waiting for Claude Code sessions…". To get data flowing you need to
install the hook forwarders into Claude Code:

```
Cmd/Ctrl+Shift+P → Agents Viz: Configure Claude Code Hooks
```

This patches `~/.claude/settings.json` to forward 9 hook events
(SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop /
Notification / SubagentStop / Task / SessionEnd). Each hook uses a silent
forwarder (sub-5 ms latency, zero token cost) that POSTs the event to a local
HTTP socket.

After configuring hooks, **restart all Claude Code sessions** so they pick up
the new hooks. Historical sessions are loaded by scanning
`~/.claude/projects/*/<sid>.jsonl` (with on-disk caching).

---

## Daily usage

### Floor plan (main canvas)

- Each room = one project, classified automatically by *file-operation voting*
  (not by `cwd`).
- Room dimensions auto-size to character count (`workCols × CHAR_W + podCols × POD_W`).
- Active workspace on the left, sleep pods on the right.
- Sessions idle for >24 h move into egg-shaped pods so they don't take a workspace slot.
- Cross-project sessions (significant edits in two or more projects) land in the
  shared `📁 projects` hub.

### Hovering a character

Tooltip shows the session ID, working directory, and the most recent user
prompt (first 220 characters).

### Top bar

- 📅 Today's spend / tokens / live session count / busiest project.
- 📊 **Activity heatmap** (7d × 24h) — collapsible.
- 💸 **Top costly prompts** — leaderboard of the most expensive user prompts; click to jump.

### Sidebar

- Search box — matches title / project / sid / cwd / last 50 events' tool & prompt.
- Session list (mini character + status).
- Click a session → highlights it in the floor plan and opens the timeline drawer.

### Timeline drawer (bottom)

- Event stream for the selected session: SessionStart / UserPrompt / PreTool /
  PostTool / Stop / Notify.
- Tools color-coded.
- Scroll to top to load older history.
- Subagent events are nested inline under the parent session's timeline.

---

## Customize

### Room walls

Drop a per-project background image at
`extension/media/rooms/<project-name-lowercased>.png` and it becomes that room's
backdrop. Missing files fall back to a hue-rotated gradient based on a hash of
the project name.

### Character sprites

Six characters live at `extension/media/characters-lpc-composed/char_{0..5}.png`
(LPC assets composed by `scripts/compose_lpc_characters.py`). Replace with your
own sprites as long as they keep the `224 × 192` layout (7 cols × 3 rows of
32×64 frames).

### Tunable thresholds

In `extension/webview.html`:

```js
const STALE_MS      = 60 * 60 * 1000;       // 1h  → sit on sofa
const LONG_STALE_MS = 24 * 60 * 60 * 1000;  // 24h → move to egg pod
const ZOMBIE_MS     = 60 * 60 * 1000;       // 1h  → force-clear stuck busy/waiting
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Panel is empty | Hooks not configured, or no Claude Code sessions yet | Run `Configure Claude Code Hooks` and restart your sessions |
| Only old sessions, no new ones | Hooks didn't install correctly | Check `~/.claude/settings.json` contains an `agents-viz` forwarder path |
| Cost numbers look wrong / too small | Cache is stale or scan was interrupted | Delete `~/.agents-viz/usage-cache.json` and reopen the panel |
| Edits to `webview.html` don't show up | The webview is still the old instance | Close and reopen the panel — HTML is re-read every time, no window reload needed |
| Edits to `extension.ts` don't show up | `extension.js` not rebuilt or VS Code not reloaded | `npm run compile` then `Developer: Reload Window` |
| Characters appear partly outside their room | Sub-pixel flex wrap with too-tight `CHAR_BOX` | Tune `CHAR_BOX` in `webview.html` (default 88 — leaves 8 px buffer) |

---

## Examples

### What a hook event looks like

```json
{
  "session_id": "0375b3da-52bf-4fc2-91a8-1325d0b79f39",
  "transcript_path": "~/.claude/projects/<hash>/<sid>.jsonl",
  "cwd": "~/projects/example_game",
  "hook_event_name": "PreToolUse",
  "tool_name": "Edit",
  "tool_input": { "file_path": "scripts/fusion_ui.gd" }
}
```

### Project routing example

A session opened in the workspace root (so `cwd = ~/projects` for hundreds of
events) edits 5 files under `idle_alchemist/` and 3 files under `agents-viz/`:

| Signal | Project | Weight | Total votes |
|--------|---------|--------|-------------|
| Edit × 5 | `idle_alchemist` | 5 each | 25 |
| Edit × 3 | `agents-viz` | 5 each | 15 |
| `cwd` × 200 events | (workspace root) | 0.2 | not counted (`~` is skipped) |

Result: runner-up (15) ÷ leader (25) = 60% ≥ 30% threshold → `__cross__` →
the session lands in the shared `📁 projects` hub.

If only `idle_alchemist` had been edited (5 × 5 = 25, no `agents-viz` votes),
that single project would dominate and the session would land in the
`idle_alchemist` room.

### Room sizing math

5 awake characters, 0 pods:
- `workCols = round(√(5 × 2.0)) = round(3.16) = 3`
- `workRows = ceil(5/3) = 2`
- `workInner = 3 × 88 + 2 × 18 = 300px`
- `workBoxW = 300 + 36 (slot pad) = 336px`
- `roomW = 12 + 336 + 12 = 360px`
- `workH = 2 × 70 + 14 = 154px`
- `roomH = 110 (wall) + 154 + 28 (floor pad) = 292px`
- Final ratio 360 × 292 → wide layout, 2 rows × 3 cols ✓

### Standalone preview HTML (no VS Code needed)

```bash
cd agents-viz
PREVIEW_SELECTED=eeee5555 node scripts/export_webview_preview.js
# → screenshots/preview.html

cd screenshots && python -m http.server 8765 &
# Open http://localhost:8765/preview.html in your browser
```

This renders the whole panel with five synthetic sessions (busy / waiting / idle
/ 10 min stale / 2 day stale) — useful for tweaking styles offline.

---

## Roadmap

What's done, what's next, and why.

### Shipped (in this repo)

- Pixel-character rendering, project rooms, sidebar, timeline drawer.
- File-operation project voting + `__cross__` cross-project hub.
- Sleep-pod state machine (1 h sofa, 24 h egg pod) with zombie sweeper.
- Lifetime cost / token tags per character; per-room totals.
- Activity heatmap (7d × 24h), top costly prompts leaderboard.
- Hover prompt preview, sidebar fuzzy search, subagent connection lines.
- On-disk usage cache (`~/.agents-viz/usage-cache.json`) keyed by `(size, mtime)`.

### Planned, not yet built

| Idea | Sketch | Why deferred |
|------|--------|---------------|
| **Zone subdivision inside rooms** | Sub-zones inside one project (e.g., `extension/`, `scripts/`, `docs/`) so characters cluster around the area they're editing | Lower ROI than top-bar widgets — most useful only for very busy single-project rooms |
| **Cross-session live event ticker** | A scrolling marquee of "recent significant events" pulled from all sessions | Designed but not implemented; ~100 lines |
| **Session replay scrubber** | Time-scrubber that rewinds the floor plan to any past moment | Highest "demo-friendly" value but requires storing per-frame state — non-trivial |
| **Cost forecasting** | Project burn-rate widget ("at current pace, you'll spend $X this month") | Easy once cost panel is stable; just hasn't been wired |
| **Multi-machine federation** | Show sessions from a second machine (e.g., a remote Linux box) on the same panel | Speculative — depends on whether anyone besides me would use this |

### Open bugs visible in the screenshot

- The shared `📁 projects` hub still leaks the internal `__cross__` marker into
  the sidebar title in some edge cases.
- Relative `file_path` values that don't resolve into a known project should
  fall back to `cwd` (currently they vote for the file basename — leading to
  rooms titled e.g. `fusion_ui.gd`).

### Honest ROI commentary

- The biggest single ROI feature is the **cost-aware character tags** — they
  changed how I think about session lifetime ("is this `$200` session worth
  keeping alive?"). Heatmap + costly-prompt leaderboard came second.
- The sleep-pod visual was disproportionately fun to ship but barely improves
  workflow ROI vs. just dimming idle characters. Kept because the visual makes
  the panel feel alive.
- Zone subdivision is genuinely deferred — it's the only feature on this list
  where I think implementation cost > expected workflow gain.

---

## Built entirely with Claude Code — by the numbers

This repo is an honest worked example of "what does AI-assisted development
actually cost in 2026?" — every line of code, almost every line of doc, and
every commit message you see was produced through Claude Code (Opus 4.7, 1M
context). The author drove with prompts; Claude wrote the diffs.

Numbers from `~/.claude/projects/<hash>/<sid>.jsonl` for the two sessions where
>50% of the content references this repo:

| Metric | Value |
|--------|-------|
| Sessions | **2** |
| Calendar span | **6.8 days** (2026-04-20 → 2026-04-27) |
| Real user prompts | **~950** across both sessions |
| JSONL records | ~18,400 (prompts + tool calls + tool results + assistant replies) |
| Total tokens | **~4.9 billion** (input + output + cache create + cache read) |
| Estimated cost (Opus 4.7 API list) | **~$3,985 USD** |
| Code shipped | ~3,000 lines `webview.html` + ~880 lines `extension.ts` + ~140 tracked files |

Cost breakdown:

| Line item | Tokens | Price | Subtotal |
|-----------|-------:|------:|---------:|
| Input (uncached) | 0.08 M | $5/M | $0.38 |
| Output | 15.5 M | $25/M | $388 |
| Cache write — 1h TTL | 116 M | $10/M | $1,160 |
| Cache write — 5m TTL | 1.2 M | $6.25/M | $8 |
| **Cache read** | **4,858 M** | **$0.50/M** | **$2,429** (61%) |
| **Total** | | | **~$3,985** |

Caveats:

- Pricing uses current Anthropic list rates for Claude Opus 4.7
  (input $5/M, output $25/M, 5m cache write $6.25/M, 1h cache write $10/M,
  cache read $0.50/M) computed locally — the real invoice may vary slightly.
- **61% of the cost is cache reads.** Each turn re-ships the conversation
  context (cached at 10% of base input) — long sessions have super-linear
  cost growth. A `/compact` partway through would have meaningfully reduced
  this.
- Both sessions were workspace-root sessions doing agents-viz development
  *and* parallel work (sprite generation, exploration, meta) in the same
  conversation. About **23% of the prompts (~222) directly touched
  agents-viz code** — the other 77% counted because they shared the same
  cached context. So the "agents-viz-specific" cost is closer to **$1K**;
  the rest of the $4K is the parallel stream.
- Wall-clock span (6.8 days) is not active typing time. Active interactive
  hours were closer to 30–50.

If you're evaluating "what does it cost to vibe-code a non-trivial VS Code
extension end-to-end on Opus 4.7?" — the API-equivalent is roughly **$1K
of focused work or $4K of mixed-bag long sessions**, six days, two
conversations.

See [`DEVLOG.md`](DEVLOG.md) for a milestone-by-milestone story of the build.

---

## Code structure

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full tour. Short version:

- `extension/src/extension.ts` — extension host: HTTP hook server, file scanning, cache.
- `extension/src/webview.ts` — webview HTML loader and placeholder substitution.
- `extension/webview.html` — **3000-line single file**, all UI logic (CSS + JS).
- `extension/src/hook-forwarder.js` — silent stdio → HTTP transport, one process per hook.
- `~/.agents-viz/` — persisted state (usage-cache.json + discovery files).
- `~/.claude/projects/<hash>/<sid>.jsonl` — Claude Code's own transcripts (we read, never write).

If you're an AI agent picking up this codebase, start at [`CLAUDE.md`](CLAUDE.md).

---

## Credits / inspirations

This project's design borrowed heavily from two upstream projects (not forks):

- [**pixel-agents**](https://github.com/pablodelucca/pixel-agents) by pablodelucca (MIT) —
  the "one terminal = one pixel character" metaphor, subagent linking, and
  hooks-mode instant detection all came from here. The LPC character sprites
  also trace back to this lineage.
- [**Agent Flow**](https://github.com/craftmygame/agent-flow) (Apache-2.0) —
  the HTTP hook server pattern, JSONL tailing, and multi-session concurrency
  engineering came from here.

Where Agents Viz diverges:

- **Project rooms** as the first-class layout unit (instead of one flat office or a graph).
- **File-operation voting** for project routing (instead of trusting `cwd`).
- **Sleep-pod zone** for long-idle sessions, so the active workspace stays uncluttered.
- **Cost-observability widgets**: lifetime cost tags, heatmap, costly-prompt leaderboard,
  per-room totals, optional cost forecasting (planned).

If a feature you want already exists upstream, please look there first.

---

## License

Apache-2.0 (matches `extension/package.json`'s `license` field).
