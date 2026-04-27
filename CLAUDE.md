# CLAUDE.md — AI Onboarding Guide for `agents-viz`

> If you are an AI agent (Claude Code, Cursor, Aider, Copilot, etc.) reading this
> repo for the first time, **start here**. This file tells you what to read, in
> what order, and what conventions / gotchas matter before you change code.
>
> Human contributors: this is also a fast-track tour. Read [`README.md`](README.md)
> for the user-facing pitch, [`ARCHITECTURE.md`](ARCHITECTURE.md) for the deep dive,
> then come back here for the "what to actually do" rules.

---

## 1. Read order (do this in sequence)

| # | File | Why |
|---|------|-----|
| 1 | [`README.md`](README.md) | What the extension does, who uses it, how it's installed. ~5 min. |
| 2 | [`ARCHITECTURE.md`](ARCHITECTURE.md) | Repo layout, data flow, state machines, CSS lessons learned. ~15 min. **The single most useful doc for code changes.** |
| 3 | [`DESIGN.md`](DESIGN.md) | Original product spec — vision + user pain points. Optional but explains *why*. |
| 4 | [`extension/webview.html`](extension/webview.html) | ~3000-line single-file frontend (HTML + CSS + JS). All UI logic lives here. **Read it once before editing.** |
| 5 | [`extension/src/extension.ts`](extension/src/extension.ts) | Extension host: HTTP hook server, JSONL scanning, on-disk cache. |
| 6 | [`extension/src/webview.ts`](extension/src/webview.ts) | Webview HTML loader + placeholder substitution. Tiny, but read it before changing how data is injected. |
| 7 | [`extension/src/hook-forwarder.js`](extension/src/hook-forwarder.js) | Per-hook silent stdio → HTTP transport. Stays under 5 ms latency, zero token cost. |

After step 4, you should be able to find any UI element by `Ctrl-F`-ing the right
emoji or class name (`.room-char`, `.pod-cell`, `#heatmap-section`, `#costboard`).

---

## 2. What kind of project is this?

A **VS Code extension** that visualizes running Claude Code sessions as pixel
characters in project "rooms". The data path:

```
Claude Code session  →  silent stdio hook (≪ 5 ms)
                         │
                         ▼
              HTTP POST :LOCAL_PORT (extension.ts)
                         │
                         ├──> eventBuffer (memory)
                         └──> webview.postMessage  →  webview.html (renders)
```

History is loaded by scanning `~/.claude/projects/<hash>/<sid>.jsonl` files
(with on-disk cache at `~/.agents-viz/usage-cache.json`).

---

## 3. Conventions you MUST follow

These come from real bugs that were costly to fix. Don't repeat them.

### 3.1 CSS — never share `::before`/`::after` across multiple modifier classes

If you're adding a new visual state (e.g. "char in a meeting"), build it as a
**standalone DOM subtree**, not as another `.room-char.<state>::before`. We
already burned 3 hours on this with sofa vs. egg-pod state collisions. See
`ARCHITECTURE.md` §"CSS lessons learned" for the full story.

```js
// GOOD — branches on state and creates the right element
if (longStale) charDiv = createPod(meta);
else           charDiv = createWorker(meta);

// BAD — relies on .room-char.long-stale::before overriding .room-char.stale::before
```

### 3.2 JS `String.prototype.replace(string, ...)` is single-shot

If a placeholder appears more than once on the same line (or anywhere), `.replace("__X__", ...)` only replaces the first. **Always use `/__X__/g`.** This bit
us twice in `webview.ts` and `scripts/export_webview_preview.js`.

### 3.3 `_render*` reads state, `_update*` writes state

Borrowed from the user's Godot conventions but enforced here too. If a function's
name says "render" or "draw", it MUST be pure — no field assignment, no event
dispatch. Otherwise you get redraw-loop bugs that are awful to debug.

### 3.4 Project routing uses **file-operation voting**, not `cwd`

A session opened in the workspace root (`~/Desktop/projects`) will have
hundreds of events with `cwd = ~`, but the actual project is determined by
the *files it edits*. Vote weights:

| Signal | Weight |
|--------|--------|
| Edit / Write tool | 5.0 |
| Read tool         | 1.0 |
| Grep / Glob       | 0.5 |
| `cwd`             | 0.2 (skipped if `cwd ∈ {~, projects-root}`) |

If `runner-up / leader ≥ 0.3`, route to the `📁 projects` cross-project hub
(internal marker `__cross__`).

### 3.5 Don't add error handling for impossible cases

Trust internal data (events from our own forwarder are well-formed). Validate
only at boundaries (HTTP request body, JSONL line parsing). No null-checks for
fields the schema guarantees.

### 3.6 Defensive placeholder defaults — use `typeof` guard

Because preview HTML and the extension share `webview.html`, placeholder values
might be undefined when run standalone:

```js
const SESSION_USAGE = (typeof __SESSION_USAGE__ !== 'undefined') ? __SESSION_USAGE__ : {};
```

This pattern is **mandatory** for any new placeholder. The `webview.ts`
substitution must use `/g` regex (see §3.2).

---

## 4. Common change recipes

### Adding a new state badge (e.g. "🤔 thinking")

1. Pick the trigger event(s) in `webview.html` — search for `state.busy = true`
   and `state.waiting = true` to find the existing pattern.
2. Add a new field to per-session state: `state.thinking = true`.
3. Add CSS: `.room-char.thinking::after { content: '🤔'; ... }` *only if* this
   state is mutually exclusive with all other badge states. If not, build a
   separate `<div class="char-badge">` child element.
4. Wire the zombie sweeper (`sweepZombieStates`) so the badge auto-clears after
   `ZOMBIE_MS`.
5. **Test**: open `screenshots/preview.html` after running
   `node scripts/export_webview_preview.js` — no VS Code needed.

### Adding a new top-bar widget (next to heatmap / costboard)

1. Read the existing `#heatmap-section` and `#costboard` blocks in
   `webview.html` — they share a "collapsible card" pattern with a `▶/▼`
   triangle and `.section-toggle` hover.
2. Copy the pattern. Don't invent a new one.
3. Compute aggregations in a single function called from the main update loop
   (`updateAll()`), not in event handlers. The update loop is debounced.

### Adding a new hook event type

1. Update `hookForwarder` to forward the new `hook_event_name` (it's mostly
   pass-through).
2. In `extension.ts` HTTP handler, add a route case if the new event needs
   special storage.
3. In `webview.html`, add a case in the event dispatcher (search for
   `hook_event_name === 'PreToolUse'` to find the dispatch table).

### Changing time thresholds

All in `webview.html` near the top:

```js
const STALE_MS      = 60 * 60 * 1000;       // 1h → sofa
const LONG_STALE_MS = 24 * 60 * 60 * 1000;  // 24h → egg pod
const ZOMBIE_MS     = 60 * 60 * 1000;       // 1h → clear stuck busy/waiting flags
```

Don't add a new threshold without consolidating against the existing three.

---

## 5. Gotchas / known sharp edges

- **`webview.html` is reloaded on every `Open Panel` call** — you don't need
  `Developer: Reload Window` after editing it. This is intentional for fast
  iteration. But you DO need a reload after editing `extension/src/*.ts`.
- **The on-disk cache (`~/.agents-viz/usage-cache.json`) is keyed by `(file size, mtime)`** — if you change how usage is computed, bump a version field
  inside the cache or just delete the file. Otherwise stale entries leak.
- **Subagent JSONLs live at `<parent-sid>/subagents/agent-<hash>.jsonl`** and
  use the *parent* `session_id` in their event records. Accumulate by
  `session_id`, not by filename.
- **`screenshots/preview.png` is the public README screenshot** — `.gitignore`
  ignores `screenshots/` but whitelists this one file. Don't break the
  whitelist when refactoring `.gitignore`.
- **Sub-pixel flex wrap kills room layout** — `CHAR_BOX = 88px` already
  includes an 8 px buffer to prevent flex from wrapping a 6th character into a
  new row. Don't tighten it without testing 6+ awake characters in a single
  room.

---

## 6. When something breaks

1. Open `screenshots/preview.html` (run `node scripts/export_webview_preview.js`
   first) and reproduce the bug **without** VS Code in the loop. 90% of UI
   bugs reproduce there.
2. For data-flow bugs, add `console.log` to `extension.ts` HTTP handler — VS
   Code's "Output → Agents Viz" channel shows extension logs.
3. For state machine bugs, the per-session `state` object is logged on
   `state.changed` events — toggle the debug flag at the top of `webview.html`.

If you find yourself adding `!important` to fix a CSS bug → **stop**. Re-read
§3.1, then refactor to standalone DOM.

---

## 7. Reference projects

This project's design borrowed from two upstream projects:

- [**pixel-agents**](https://github.com/pablodelucca/pixel-agents) (MIT) —
  the "one terminal = one pixel character" metaphor, subagent linking, hooks-
  mode detection.
- [**Agent Flow**](https://github.com/craftmygame/agent-flow) (Apache-2.0) —
  HTTP hook server, JSONL tailing, multi-session concurrency engineering.

If you need a precedent for a feature that exists in either project, read
their source first instead of reinventing.

---

## 8. License

Apache-2.0 (matches `extension/package.json`). Contributions welcome under the
same license.
