# DEVLOG

> Languages: English (this file) · [简体中文 README](README.zh.md) · [English README](README.md) · [AI guide / CLAUDE.md](CLAUDE.md)

A milestone-level story of how `agents-viz` got built. This is the public,
sanitized retelling — for the raw record see git log.

**Scope of this devlog**: 2 Claude Code sessions, 2026-04-20 → 2026-04-27,
~6.8 calendar days, ~950 real user prompts, ~4.9 B tokens,
**~$3,985 of API-equivalent spend** at Opus 4.7 list pricing
(of which 61% was cache_read on the growing conversation context).
About 23% of those prompts directly touched agents-viz code — the rest
were parallel work in the same long sessions.

---

## Day 1–2 (Apr 20–21): scaffolding + the routing bug that wouldn't die

The starting point was the "one terminal one pixel character" idea borrowed
from [pixel-agents](https://github.com/pablodelucca/pixel-agents). Initial
scaffold:

- VS Code extension boilerplate (`extension/src/extension.ts`).
- HTTP hook server + silent stdio→HTTP forwarder, modeled on the
  [Agent Flow](https://github.com/craftmygame/agent-flow) pattern.
- A single ~800-line `webview.html` rendering pixel characters in a single
  flat office.

**Routing bug.** Most of my Claude Code sessions get opened from the
*workspace root* (`~/Desktop/projects`), so `cwd` for a 200-event session is
that root path — not the project the session is actually working on. Result:
every session ended up in a single oversized "projects" room.

**Fix.** Replaced cwd-only routing with a *file-operation voting* algorithm:
each `Edit`/`Write` tool call casts a vote (weight 5) for the project derived
from `tool_input.file_path`; `Read` votes weight 1, `Grep`/`Glob` weight 0.5.
`cwd` got demoted to weight 0.2 and skipped entirely if it resolved to the
workspace root. To handle sessions that legitimately span two projects
(infra/setup work), I added a `__cross__` marker: if the runner-up project's
vote total is ≥30% of the leader's, the session lands in a shared
`📁 projects` hub instead of being misfiled.

This is now the single most-used routing rule in the codebase, and it's the
one feature that I think pushes Agents Viz past the upstream projects.

---

## Day 2–3 (Apr 22–23): the sleep pod, four times

I wanted long-idle sessions (>24 h) to visually move out of the active
workspace so they wouldn't clutter the room. First sketch was a horizontal
bed. Looked terrible. Switched to a vertical capsule. Better. Switched again
to an egg-shape pod with a glass dome — that's the version that shipped.

The egg silhouette took **four CSS iterations**:

1. **Round 1**: too round (looked like a circle).
2. **Round 2**: lemon-shape (both ends pointed).
3. **Round 3**: tall rectangle with rounded corners (looked like a cabinet).
4. **Round 4**: explicit Bezier `clip-path` — *finally* egg-shaped.

The clip-path that worked, for posterity:

```css
clip-path: path('M 25,0 C 8,0 0,28 0,46 C 0,68 12,82 25,82 C 38,82 50,68 50,46 C 50,28 42,0 25,0 Z');
```

### The CSS pseudo-element collision

The sleep pod was originally implemented as `.room-char.long-stale::before`,
sharing the `::before` slot with `.room-char.stale::before` (the sofa).
Because both selectors target the same element when a long-stale character
also has the stale class, their properties collided unpredictably. The bug
that surfaced: pods rendered with only the upper half visible because the
sofa rule's explicit `height: 26px` overrode the pod's `top:0; bottom:6`
calculation.

The fix wasn't more `!important` — it was an architectural refactor.
Long-stale characters now render as a **standalone `.pod-cell` DOM subtree**
(shell + dome + head + pedestal + badge + salary + name) instead of piling
modifier classes onto a single element. **Three separate visual bugs
turned out to be the same root cause** — a clear signal that pseudo-element
sharing across modifier classes is an architectural smell, not a tactical
one.

I wrote this up as a memory and saved it as `feedback_pseudo_element_collision`
for future projects to read first.

---

## Day 3 (Apr 23): room-sizing geometry

Once rooms could contain a mix of working characters + sleeping pods, the
"how big should this room be?" formula needed to be deterministic. The
shipping formula:

```
workCols  = round(sqrt(awakeCount × 2.0))   // 2.0 = horizontal preference
workRows  = ceil(awakeCount / workCols)
podCols   = round(sqrt(podCount × 2.0))
podRows   = ceil(podCount / podCols)

CHAR_BOX  = 88px        // includes 8px buffer to prevent flex sub-pixel wrap
POD_BOX   = 58px

roomW     = ROOM_EDGE_PAD + workBoxW + ZONE_GAP + podBoxW + ROOM_EDGE_PAD
roomH     = WALL_H + max(workH, podH) + FLOOR_PAD
```

The `CHAR_BOX = 88` constant deserves a callout: it has an 8 px buffer beyond
the actual sprite width because flex layout in the webview was rounding
sub-pixel widths down and wrapping the 6th character into a third row.
Tightening this constant without re-testing 6+ characters in one room will
break the layout.

---

## Day 4 (Apr 24): UI feature blitz

In a single high-throughput day I shipped (in roughly this order):

- **Zombie state sweeper** — auto-clears stuck `busy/waiting/monitoring` flags after 1 h.
- **Cost / token tags** above each character ("AI salary").
- **Sidebar search** — fuzzy-matches title / project / sid / cwd / last-50-events tools and prompts.
- **Daily summary strip** in the top bar — 📅 cost / tokens / live count / busiest project.
- **Activity heatmap** — collapsible 7d × 24h grid colored by event density.
- **Top costly prompts leaderboard** — top 30 user prompts by cost; click to jump to the session.
- **Hover prompt preview** — tooltip shows the latest user prompt (220 chars).
- **Subagent connection lines** — SVG dashed lines between parent and subagent characters.
- **Per-room cost total** — even after a session is deleted, the room remembers the cumulative spend its sessions contributed.

Each of these was small (50–250 lines) and built on top of existing
state. The big-room layout having stabilized first paid off here — every
feature dropped into a known coordinate system without having to retest
geometry.

---

## Day 5 (Apr 25): the performance crisis + on-disk cache

The lifetime-cost numbers across all rooms suddenly dropped to a fraction of
their real value. Trying to trace the regression I found I'd added a
"tail-read" optimization that capped each JSONL parse to the last 1 MB. That
optimization made the first-load fast but **silently truncated lifetime
totals** because old sessions could be 50+ MB long.

Fix: a persistent on-disk cache at `~/.agents-viz/usage-cache.json`, keyed by
`(file size, mtime)` per JSONL. First scan does a full read and caches; later
scans short-circuit unless the file changed. This keeps first-load fast (the
cache already exists) without lying about cost.

Bonus bug found in the same session: `String.prototype.replace(string, ...)`
is **single-shot**. The webview placeholder `__SESSION_USAGE__` appeared
twice on the same defensive-default line in `webview.html` — only the first
was being substituted, leaving a `ReferenceError` that killed the panel
silently. Fix: every `replace` in `webview.ts` and
`scripts/export_webview_preview.js` switched to `/regex/g`. Memory written:
`feedback_js_replace_first_only`.

---

## Day 6 (Apr 26): closure + going public

- Wrote `ARCHITECTURE.md` (~430 lines) covering data flow, state machines,
  the CSS lessons, and a "what to read in what order" map.
- Wrote `README.md` with screenshots, install instructions, troubleshooting.
- Captured a real running-extension screenshot (3 rooms, $3.4K, 22 agents,
  populated heatmap) to replace the synthetic preview.
- Created the public GitHub repo and pushed.

### The day-of public-prep checklist

1. **Sanitize**: untrack 30+ sprite generation scripts that hardcoded local
   ComfyUI paths and the developer's username; replace remaining hardcoded
   paths with `__file__`-relative or `os.path.expanduser` equivalents;
   neutralize synthetic preview cwd strings.
2. **Add Credits / Acknowledgements**: explicit pointers to the two upstream
   projects whose patterns this borrowed from.
3. **Update License**: from "personal project, no license" to Apache-2.0
   (matching `extension/package.json`).
4. **Drop the `vendor/` directory from tracking**: those were full clones of
   the upstream projects kept locally for reference. They have no business
   being in our public repo.
5. **Write CLAUDE.md**: an AI-onboarding file that gives a zero-context AI
   the read order, the conventions to follow, and the gotchas to watch for.
6. **Promote English to primary**: README.md is now English-first (this
   file), with `README.zh.md` for the Chinese version and a language-switch
   header on each.

---

## Things that didn't make the cut (yet)

See the [Roadmap](README.md#roadmap) section in the README for the live list.
Highlights:

- **Zone subdivision inside rooms** — characters cluster around the area of
  the project they're editing. Lower ROI than top-bar widgets.
- **Cross-session live event ticker** — designed, ~100 lines, deferred.
- **Session replay scrubber** — high demo value but expensive to implement.
- **Cost forecasting** — easy add now that the cost panel is stable.

---

## Lessons banked (worth borrowing if you're building similar tooling)

1. **File-operation voting beats `cwd`** for any system that has to attribute
   work to a project. Almost no real-world dev session honors `cwd`.
2. **Don't share CSS pseudo-elements across modifier classes.** When you find
   yourself reaching for `!important`, refactor to standalone DOM instead.
   Three bugs that look unrelated may share this root cause.
3. **Leaky JSON placeholders + JS `replace(string,…)` is single-shot** — use
   `/regex/g` for any template substitution that might recur.
4. **Size + mtime is enough for a JSONL cache key.** No need for content
   hashes when files are append-only.
5. **A real running screenshot beats a synthetic preview** in the README,
   even if the synthetic version is prettier — the live one builds trust.
6. **Honest cost numbers in the README** are unusual but valuable. People
   evaluating "should I try Claude Code for serious projects?" deserve a
   data point. Mine is $10,400 / 6 days / 2 sessions for this codebase.

---

## What's in this repo (final tracked layout)

```
agents-viz/
├── README.md / README.zh.md   ← user-facing, EN primary
├── CLAUDE.md                  ← AI agent onboarding
├── DEVLOG.md                  ← this file
├── ARCHITECTURE.md            ← code tour, data flow, state machines
├── DESIGN.md                  ← original product spec (v2)
├── extension/                 ← VS Code extension (the actual product)
│   ├── src/{extension,webview}.ts + hook-forwarder.js
│   ├── webview.html           ← 3000-line single-file frontend
│   ├── media/                 ← LPC sprites + room walls + furniture
│   └── package.json
├── scripts/
│   ├── compose_lpc_characters.py  ← LPC compositor
│   ├── configure_hooks.js         ← hook installer
│   ├── export_webview_preview.js  ← standalone HTML for offline preview
│   └── install_link.js
└── screenshots/preview.png    ← README screenshot
```

Everything else (sprite generation pipelines, internal working docs, vendor
clones) lives locally but is gitignored.
