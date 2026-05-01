# Webview Extension Plan — Teams Visualization (Task #3)

Owner: `frontend` · Phase 1 PREP (pre-implementation insertion plan).
Drafted before `ux-designer` ships `TEAMS_DESIGN.md`. Will refine against the design doc + architect's state shape before coding.

This file is line-anchored against `extension/webview.html` at HEAD `9cc6bc0` (~4162 lines).

---

## 1. Existing layout the new feature lives next to

### HTML body skeleton (`webview.html` 1778-1896)

```
1780  #app  (grid: 360px sidebar | main)
1781    aside #sidebar
1782      #sidebar-header           (Agents <count>, Hide >3d)
1786      #sidebar-search           (search-box)
1789      #sessions                 ← per-session cards rendered by renderSidebar()
1792      #sidebar-footer
1799    main #main
1800      #daily-strip
1807      #heatmap-section          (collapsible card pattern)
1826      #costboard-section        (collapsible card pattern, COPY THIS PATTERN)
1834      #speed-section            (ECharts dashboard)
1856      #floor-plan               ← rooms grouped by project
1859      #timeline-drawer
1873      #timeline-wrap            (selected session events)
1882  .modal-overlay #delete-modal  (modal pattern, COPY for reply composer)
```

### Placeholder injection (webview.ts 38-47)

Existing `/g`-substituted placeholders: `__SPRITE_URIS__ __SPRITE_MANIFESTS__ __ROOM_IMAGES__ __BUILD_STAMP__ __SOFA_FRONT__ __SOFA_SIDE__ __SESSION_USAGE__ __PROMPT_COSTS__ __ECHARTS_URI__`. New: `__TEAMS__` (proposed; awaiting architect confirm).

Both consumers must be updated:
- `extension/src/webview.ts` line ~47 → add `.replace(/__TEAMS__/g, JSON.stringify(opts.teams || {}))`
- `scripts/export_webview_preview.js` ~ line 48 → add `html = html.replace(/__TEAMS__/g, JSON.stringify(SAMPLE_TEAMS));` with realistic fixture so previews can verify.

### `typeof` defensive guards (CLAUDE.md §3.6)

Append next to lines 1903 / 1949 / 1950:
```js
const TEAMS = (typeof __TEAMS__ !== 'undefined') ? __TEAMS__ : {};
```

### Message handler (3539-3590)

New cases to add:
- `case 'teams-update'` → `Object.assign(TEAMS, msg.teams || {}); renderAll();`
- (Reply composer outbound) reuse existing `vscode.postMessage` pattern at 3493 / 3605 / 4136.

---

## 2. Insertion plan per feature

### 2.1 Sidebar team grouping (collapsible per team)

**Where**: inside `renderSidebar()` 2652-2992 — currently flat list of session cards in `#sessions`. Need to group by `team` field on `meta` (or on TEAMS placeholder lookup keyed by sid).

**Approach**:
1. Replace the flat `for (const sid of visibleSids) { ... }` upsert (2748-2991) with an outer loop over team groups, then inner loop over the team's sessions.
2. Each team header is a new DOM template: `<div class="team-group" data-team-id="...">`, containing `<div class="team-header"><span class="team-toggle">▼</span><span class="team-name"></span><span class="team-count"></span></div>` and `<div class="team-body">...session cards here...</div>`. Header click → toggle `.collapsed` on the group, persisted via `state.teamCollapsed[teamId] = bool` analogous to `state.heatmapOpen`.
3. The cross-project-hub idea (`📁 projects`) is the precedent — same pattern, applied to teams.
4. **§3.1 standalone DOM**: do NOT pile `::before` on `.session.team-X`. The team header is its own DOM subtree.
5. Keep the existing `sessionCards` Map cache so we don't restart sprite animations. Cards just relocate into their team body via `insertBefore`.

**New CSS** (near 100-200 sidebar block):
- `.team-group { border-bottom: 1px solid var(--vscode-panel-border); }`
- `.team-header { padding: 6px 12px; display:flex; gap:6px; cursor:pointer; user-select:none; background: var(--vscode-editorWidget-background); font-size: 11px; opacity: 0.85; }`
- `.team-header:hover { background: rgba(255,255,255,0.04); }`
- `.team-toggle { font-size: 9px; transition: transform 0.18s ease; }`
- `.team-group.collapsed .team-toggle { transform: rotate(-90deg); }`
- `.team-group.collapsed .team-body { display: none; }`
- `.team-count { margin-left: auto; opacity: 0.55; font-variant-numeric: tabular-nums; }`

### 2.2 Mailbox directed graph (zero-dep SVG)

**Where**: new `<section id="mailbox-section">` between `#speed-section` (1854) and `#floor-plan` (1856). Same collapsible-card chassis as `#costboard-section`.

**HTML** (insert after line 1854, before line 1856):
```html
<div id="mailbox-section">
  <div id="mailbox-header">
    <span class="hm-chevron">▶</span>
    <span class="hm-title">📬 Mailbox graph</span>
    <span class="hm-sub" id="mailbox-summary">no messages yet</span>
  </div>
  <div id="mailbox-body" class="hidden">
    <svg id="mailbox-svg" xmlns="http://www.w3.org/2000/svg"></svg>
  </div>
</div>
```

**Renderer**: new `updateMailbox()` called from `renderAll()` (3532). Reuses logic from `drawSubagentConnections` (3328-3376) — it already creates SVG nodes with `createElementNS`. We bind nodes to teammates (one circle per teammate, label = name). Edges = directed (with `<marker>` arrowhead) for each unique sender→receiver pair, weighted by message count.

Layout: simple force-free placement — nodes arranged in a circle (polar coords) sized to fit `#mailbox-body`'s width. If teammate count grows past ~12 we'll switch to a row-based layout. Keep zero-dep per the briefing.

**CSS**:
- `#mailbox-section` → clone `#costboard-section` styling
- `#mailbox-svg { width: 100%; height: 280px; display: block; }`
- `.mb-node circle { fill: rgba(106,255,180,0.18); stroke: rgba(106,255,180,0.6); stroke-width: 1.5; }`
- `.mb-node text { fill: var(--vscode-foreground); font-size: 11px; text-anchor: middle; pointer-events: none; }`
- `.mb-node.selected circle { fill: rgba(86,156,214,0.30); stroke: #569CD6; }`
- `.mb-edge { stroke: rgba(220,220,170,0.45); stroke-width: 1.2; fill: none; marker-end: url(#mb-arrow); }`
- `.mb-edge.recent { stroke: #DCDCAA; stroke-width: 2; }`

Click handler on a node → opens reply composer prefilled with `to: nodeId`.

### 2.3 Task kanban (3 columns: pending / in-progress / completed)

**Where**: new `<section id="tasks-section">` directly after the new mailbox section (so kanban + mailbox cluster as the "team coordination" band above the floor plan).

**HTML**:
```html
<div id="tasks-section">
  <div id="tasks-header">
    <span class="hm-chevron">▶</span>
    <span class="hm-title">📋 Tasks</span>
    <span class="hm-sub" id="tasks-summary">0 pending · 0 in-progress · 0 done</span>
  </div>
  <div id="tasks-body" class="hidden">
    <div class="kanban-board">
      <div class="kanban-col" data-status="pending">
        <div class="kanban-col-header">⏳ Pending <span class="kanban-count">0</span></div>
        <div class="kanban-col-list"></div>
      </div>
      <div class="kanban-col" data-status="in_progress">
        <div class="kanban-col-header">🔧 In progress <span class="kanban-count">0</span></div>
        <div class="kanban-col-list"></div>
      </div>
      <div class="kanban-col" data-status="completed">
        <div class="kanban-col-header">✅ Completed <span class="kanban-count">0</span></div>
        <div class="kanban-col-list"></div>
      </div>
    </div>
  </div>
</div>
```

**Renderer**: `updateKanban()` called from `renderAll()`. Reads `TEAMS[teamId].tasks` (or top-level `TASKS` — depends on architect's shape, will confirm). Cards show: subject, owner, age. Card click → highlights matching teammate node in mailbox + selects related session in floor plan if known.

**CSS**:
- `.kanban-board { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; padding: 6px 18px 12px 18px; }`
- `.kanban-col { background: rgba(255,255,255,0.03); border-radius: 4px; padding: 6px; min-height: 80px; }`
- `.kanban-col-header { font-size: 10px; opacity: 0.65; padding: 4px 6px; display: flex; justify-content: space-between; }`
- `.kanban-card { background: rgba(255,255,255,0.05); border-left: 3px solid #DCDCAA; padding: 6px 8px; margin-bottom: 4px; border-radius: 3px; cursor: pointer; font-size: 11px; }`
- `.kanban-card[data-status="completed"] { border-left-color: #6affb4; opacity: 0.7; }`
- `.kanban-card[data-status="in_progress"] { border-left-color: #569CD6; }`
- `.kanban-card .kc-owner { opacity: 0.6; font-size: 10px; }`

### 2.4 Reply composer modal

**Where**: new `<div class="modal-overlay" id="reply-modal">` immediately after `#delete-modal` (~ line 1896).

**HTML** (clone of delete modal pattern):
```html
<div class="modal-overlay" id="reply-modal">
  <div class="modal">
    <h3>💬 Reply to <span id="reply-to"></span></h3>
    <p class="reply-meta" id="reply-meta"></p>
    <textarea id="reply-text" rows="6" placeholder="Type your reply…"></textarea>
    <div class="modal-buttons">
      <button id="reply-cancel">Cancel</button>
      <button id="reply-send" class="primary">Send</button>
    </div>
  </div>
</div>
```

**JS**: `openReplyComposer(team, teammate, prefill)` (next to `openDeleteModal`), `closeReplyComposer()`, send button → `vscode.postMessage({ type: 'team_reply', team, teammate, text })` (the architect's `extension.ts` handler will write to file inbox via the path schema hooks-devops defines).

**CSS** additions: reuse `.modal-overlay / .modal` (already styled at 108-162). Add:
- `#reply-text { width: 100%; box-sizing: border-box; padding: 8px; font-family: monospace; font-size: 12px; background: rgba(255,255,255,0.04); border: 1px solid var(--vscode-panel-border); color: var(--vscode-foreground); border-radius: 3px; resize: vertical; }`
- `.modal-buttons button.primary { background: #569CD6; border-color: #569CD6; color: #fff; }`
- `.modal-buttons button.primary:hover { background: #6CA8E0; }`

Triggers (in priority order):
1. Click a teammate node in mailbox graph (2.2)
2. Click an `outstanding-prompt` indicator on a teammate's session card
3. Right-click a session card → context menu "Reply" (deferred if scope tight)

### 2.5 Per-teammate token spend column (HARD requirement)

**Where**: extend the team header in 2.1 to include a third row/column with cost; AND extend each session card's badge row (2913-2916) to make the per-session cost more prominent (already there as `.cost-badge`, just ensure the team-level aggregation is visible in the team header's right side).

**HTML in team-header**:
```html
<div class="team-header">
  <span class="team-toggle">▼</span>
  <span class="team-name"></span>
  <span class="team-count"></span>
  <span class="team-cost"></span>   <!-- new -->
</div>
```

**Renderer**: aggregate `SESSION_USAGE` for each team's sids, format with existing `fmtCost` / `fmtTok` (1955, 1963). Aggregation in `renderSidebar()` before the team loop.

**CSS**:
- `.team-cost { color: #ffe27a; font-family: monospace; font-size: 10px; opacity: 0.85; margin-left: 6px; }`

### 2.6 Optional: outstanding-prompt indicator on teammate cards

Add `.session.has-outstanding-prompt` — pulse `#F48771` border-left when teammate has an unread prompt. Toggle from team data. Pure CSS animation, no shared pseudo-elements.

---

## 3. Open questions for teammates

### To `ux-designer`
- Sidebar grouping: collapsed default per team, or per-team persisted preference?
- Where should reply composer entry-point live: only mailbox-graph node click, or also a "✉️" button on each teammate's session card?
- Mailbox graph: edge weight visualization — line thickness, opacity, or color?
- Tasks: include subject, owner, age — anything else? blockedBy chain?
- Per-team color theme (need it for team headers + edges + node fills)?

### To `architect`
- New placeholder name: confirm `__TEAMS__`. Shape proposal:
  ```ts
  type TEAMS = Record<string /*teamId*/, {
    name: string;
    color?: string;            // hex or hsl
    teammates: Record<string /*teammateName*/, {
      sessionId?: string;      // bind to bySession
      role?: string;
      cost?: number;
      tokens?: number;
      lastMessageTs?: number;
      outstandingPrompt?: { from: string, ts: number, text: string } | null;
    }>;
    tasks: Array<{ id: string; subject: string; status: 'pending'|'in_progress'|'completed'; owner?: string; ts: number; }>;
    messages: Array<{ from: string; to: string; ts: number; preview?: string }>;
  }>;
  ```
  Alternative: flat top-level placeholders (`__TEAMMATES__`, `__TEAM_TASKS__`, `__TEAM_MESSAGES__`). Either way, please confirm name(s) so I can wire `webview.ts` and `export_webview_preview.js`.
- Message-update push: `case 'teams-update'` payload shape. Full TEAMS replace, or delta merge per teamId?
- Reply outbound message: confirm `{ type: 'team_reply', team, teammate, text }` and that `extension.ts` writes to file inbox — please publish the inbox file path schema so I can show "delivered to {path}" in the modal.

### To `hooks-devops`
- Inbox file path scheme — relative to project root or absolute? Atomic write strategy (`.tmp` + rename, or fs.appendFile)? Need to surface delivery confirmation to the user in the reply modal.
- UserPromptSubmit hook → does the new outstanding-prompt indicator come from the same hook, or a separate "team_inbox" event type? Confirm event name so I can wire ingest().

---

## 4. Verification plan (Phase 2)

1. Update `scripts/export_webview_preview.js` to inject realistic `__TEAMS__` fixture (3-team scenario, 6 teammates, 4 tasks across statuses, ~20 messages between them).
2. Run `node scripts/export_webview_preview.js`.
3. Open `screenshots/preview.html` in Chrome.
4. Manual verify: sidebar team groups expand/collapse, mailbox graph nodes + edges render, kanban columns populate, reply modal opens on node click, send button posts message (will alert in preview, since no real extension.ts).
5. Take screenshot, Read screenshot to verify visually (per `feedback_visual_output_verify.md`).
6. Audit no shared `::before`/`::after` between `.team-group` / `.team-X` / `.kanban-card[data-status]` (per CLAUDE.md §3.1, ARCHITECTURE.md §6 antipattern 1).
7. Audit all new placeholder substitutions use `/g` (CLAUDE.md §3.2, antipattern 2).
8. Audit new `update*()` / `render*()` functions don't mutate state — purely read TEAMS/SESSION_USAGE and emit DOM (CLAUDE.md §3.3).
9. Audit defensive `typeof` guard for any new placeholder (CLAUDE.md §3.6).

---

## 5. Anti-patterns I must NOT do (re-read of project conventions)

- ❌ `.team-group::before` shared across team types → use independent DOM subtrees per state (§3.1).
- ❌ `html.replace('__TEAMS__', ...)` (single-shot) — must be `/__TEAMS__/g` in BOTH `webview.ts` AND `export_webview_preview.js` (§3.2 / ARCHITECTURE.md §6 antipattern 2).
- ❌ `renderTeams()` writing to TEAMS or sessionMeta → render is read-only (§3.3).
- ❌ Skipping `(typeof __TEAMS__ !== 'undefined')` guard → entire panel will throw ReferenceError if new webview.ts runs against a stale extension build (§3.6).
- ❌ Adding external libraries for graph rendering → mailbox SVG must be hand-written, no deps.
- ❌ Claiming completion without screenshot verification → must Read my own screenshot.
- ❌ Drive-by refactors of unrelated `renderSidebar` internals while adding team grouping — scope-locked to team feature.

---

## 6. Status

- 2026-04-30 ~ : prep doc written. Awaiting `ux-designer` to publish `TEAMS_DESIGN.md` and `architect` to confirm `__TEAMS__` placeholder name + shape.
