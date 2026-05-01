# TEAMS_DESIGN.md — Visual Design Spec for Claude Code Agent Teams

> Audience: frontend (consumer of this spec), architect (data binding partner),
> team-lead (sign-off). Status: v1 proposal · 2026-04-30.

---

## 0. Problem statement

Existing model: **`room = project`, `character = session`**. A user can already
glance at a "stickerfort" room and see Alice / Bob working there.

New requirement: visualize **Claude Code Teams** — a group of named teammates
working on a shared task list with a peer mailbox. State lives at:
- `~/.claude/teams/{name}/config.json` — roster + role + lead
- `~/.claude/tasks/{name}/*.json` — shared kanban
- (mailbox is in-memory + replayed via hook events)

**The hard collision** (per audit): a team is logically a "group of agents
working together", which screams "put them in the same room". But room=project
is already taken — and a 4-teammate team often spans 1 project (so they share
a room *anyway*) but logically belongs to a *team* construct, not the project.
We need to surface team identity **without** breaking project-room semantics.

---

## 1. Three candidate metaphors (honest evaluation)

### Candidate A — **Team-room sub-cluster** (dedicated mini-room)
Each team gets its own boxed mini-room rendered above the project rooms,
with all teammates inside, regardless of cwd. The teammate also still appears
in their project room (duplicated, dimmed link line back to team-room).

- Pros: zero ambiguity — "this box is the team"; mirrors Slack channel feel.
- Cons: doubles every teammate's DOM presence; dim-link clutters the floor;
  loses the spatial rule that a character lives in exactly one room.
- Cost: ~250 lines new CSS + duplicate render path.

### Candidate B — **Ribbon overlay** (SVG arcs binding teammates across rooms)
Teammates stay in their project rooms (existing semantics untouched). A
**colored ribbon** (named after the team) is drawn as an SVG arc connecting
all teammate avatars, similar to `drawSubagentConnections` (`webview.html:2440`).
Hover any teammate → ribbon highlights; click team name in sidebar → all
teammates pulse.

- Pros: preserves room=project invariant 100%; reuses subagent SVG layer;
  scales to teams that span 0..N projects naturally.
- Cons: with 3+ teams in flight, ribbons can spaghetti; need z-order discipline.
- Cost: ~120 lines (SVG layer + sidebar group + hover wiring). **Lowest risk.**

### Candidate C — **Sidebar team groups + room badges** (no floor-plan change)
Sidebar grows a top-level "Teams" section with collapsible group headers.
Each teammate avatar in any room gets a small **team color dot** (4×4 px
circle, top-right of avatar) that matches its team's accent color in the
sidebar. No SVG, no extra DOM in floor plan beyond the dot.

- Pros: cheapest implementation; no floor-plan re-layout; team membership
  visible peripherally; matches existing collapsible pattern (#heatmap-section).
- Cons: weakest "team-ness" — viewer must mentally connect the dots.
- Cost: ~80 lines (sidebar group + 1 CSS variable per team + dot element).

### (Considered but rejected) Candidate D — Force a "team = room"
Putting all teammates in a synthesized `🧑‍🤝‍🧑 team-foo` room collides head-on
with `room = project`. A Stickerfort dev who happens to be on a team gets
yanked out of the Stickerfort room. Rejected — violates the audit constraint.

---

## 2. Recommendation: **Candidate B (ribbon overlay) + thin slice of C (sidebar group)**

**Rationale**: B preserves the existing mental model perfectly (project rooms
stay project rooms), and the ribbon makes team identity *spatially* visible
in a way the sidebar dot from C cannot. We borrow C's sidebar group section
because the sidebar is where the user does roster management (rename, expand,
trigger reply composer) — those actions don't belong on the floor plan.

**Tradeoffs accepted**:
- Up to 3 simultaneous teams will look fine; 4+ teams need a "show only
  selected team's ribbon" toggle (deferred to v1.1).
- Ribbon visibility decays with teammate count (≥6 teammates start to
  resemble a connected mesh) — fall back to a convex-hull tinted polygon
  instead of pairwise edges when teammate count ≥ 5.

**Out of scope** for v1: drag-to-reorganize team membership, team avatars
(team-as-character), animated message-flying-between-teammates effects.

---

## 3. ASCII wireframes

### 3a. Sidebar with team groups (collapse/expand)

```
┌─ SIDEBAR (320px wide) ────────────────────────────┐
│ [🔍 search]                          5 agents · 3 live │
│ 🟢 3 live · 🟡 1 1h · 🔵 1 1d · 💤 0 older            │
│ ───────────────────────────────────────────────── │
│ ▼ 👥 TEAMS (2)                              [+]   │   ← team list header
│   ▼ ◆ agents-viz-teams                 5 mates    │   ← team-row, expanded
│     │  task: 6/6 · cost: $0.84 · lead: team-lead  │
│     │  ┌──────────────────────────────────────┐   │
│     │  │ 👤 ux-designer    [working 2s]   ⚡   │   │   ← uses existing
│     │  │   ▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░    │   │      session card
│     │  │ 👤 architect      [waiting]      🔔   │   │
│     │  │   ░░░▓░▓▓░░░░░░░░░░░░░░░░░░░░░░░    │   │
│     │  │ 👤 frontend       [idle 12m]     💤   │   │
│     │  │   ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░    │   │
│     │  │ 👤 hooks-devops   [shutdown?]    ⏻❓  │   │   ← shutdown_pending
│     │  │   ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░    │   │
│     │  │ 👤 qa-cold-audit  [working 5s]   🔧   │   │
│     │  │   ▓░░▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░    │   │
│     │  └──────────────────────────────────────┘   │
│     │  [📋 view tasks]  [✉ open mailbox]         │   ← team-actions row
│   ▶ ◇ stickerfort-polish              3 mates    │   ← team-row, collapsed
│ ───────────────────────────────────────────────── │
│ ▼ 🧍 SOLO SESSIONS (2)                            │   ← non-team sessions
│   👤 john         [working]   ⚡                  │
│   👤 alice        [idle 3h]                       │
└───────────────────────────────────────────────────┘
```

- Click `▼/▶` on team row → toggle expand. State persisted via
  `vscode.setState({ ...state, teamsExpanded: { 'agents-viz-teams': true }})`.
- Team accent color: 4-px left border on the team-row container, color =
  hash of team name → HSL hue 0..360.
- Each teammate row reuses the **existing session card DOM** (sprite + sparkline
  + cost badge + state ring). We add a wrapper, not a new card type.

### 3b. Mailbox flow visualization (who → whom directed graph)

A small SVG (~200 × 140 px) embedded in the team-row when `[✉ open mailbox]`
is clicked. Uses force-directed-by-hand layout (5 mates = pentagon). Recent
messages (last 30 min) drawn as **directional arrows** between nodes;
arrow opacity = recency, arrow thickness = msg count.

```
       ux-designer
            ●
          ↗ │ ↘
         ╱  │  ╲      (legend: arrow → = msg direction
        ╱   │   ╲              opacity = age, max 30min
       ╱    ↓    ╲             thickness = count last 30min)
   architect      frontend
      ●  ←─────→   ●
       ╲    ↑    ╱
        ╲   │   ╱
         ╲  │  ╱
          ↘ │ ↙
            ●
       qa-cold-audit
                                       click ● → focus that
                                       teammate's session in main view
```

- Node = small circle (8 px) + name label (10 px) below.
- Hover edge → tooltip shows `from → to · N msgs · most recent: 23s ago`.
- Click `[+ compose]` button → opens reply composer (3d).

### 3c. Task kanban (pending / in-progress / completed columns)

Opened via `[📋 view tasks]`. A modal/inline panel; reuses existing
collapsible pattern.

```
┌─ Tasks: agents-viz-teams ─────────────────────────────────────────┐
│  [×close]                                              6 tasks    │
├─────────────┬──────────────────────────┬──────────────────────────┤
│  PENDING (3)│  IN-PROGRESS (1)         │  COMPLETED (2)           │
├─────────────┼──────────────────────────┼──────────────────────────┤
│ #4 Hooks    │ #2 Architect: TS data    │ #1 ✓ UI/UX design doc   │
│   /DevOps   │     layer + watchers     │     (ux-designer · 12m)  │
│   forwarder │     (architect · ⚡5s)   │                          │
│   ext.      │                          │ #5 ✓ Product lead:       │
│             │     blocked-by: —        │     persistence doc      │
│ #3 Frontend │     blocks: #6           │     (lead · 8m)          │
│   teams viz │                          │                          │
│   (blocked  │  ┌──────────────┐        │                          │
│    by #1)   │  │ progress: 40%│        │                          │
│             │  │ ▓▓▓▓░░░░░░░  │        │                          │
│ #6 QA cold  │  └──────────────┘        │                          │
│   audit     │                          │                          │
│   (blocked  │                          │                          │
│    by 2,3,4)│                          │                          │
└─────────────┴──────────────────────────┴──────────────────────────┘
```

- Card = task; shows `#id`, owner with state emoji, blocked-by chain.
- Drag between columns is **not** supported in v1 (read-only viz; status
  changes happen via TaskUpdate from the agents themselves).
- Click card → expand to show full description + dependencies graph.

### 3d. Reply composer popup

Triggered from mailbox view (`[+ compose]`) or by clicking a teammate avatar
in floor plan with modifier-click (Ctrl/Cmd-click).

```
┌─ Reply Composer ──────────────────────── [×] ─┐
│  Team:  agents-viz-teams                       │
│  From:  (me, observer)                         │
│  To:   [▼ ux-designer       ]  ← dropdown,    │
│                                  or "* all"    │
│  Summary: [_______________________]  ← <70ch   │
│                                                │
│  Message:                                      │
│  ┌──────────────────────────────────────┐      │
│  │                                      │      │
│  │  (textarea, monospace, 8 rows)       │      │
│  │                                      │      │
│  │                                      │      │
│  └──────────────────────────────────────┘      │
│                                                │
│  ☐ also broadcast to team-lead                 │
│                                                │
│           [Cancel]    [Send →]                 │
└────────────────────────────────────────────────┘
```

- Sends via POST to `/api/teams/{name}/mailbox` (architect to define).
- Validation: summary required & ≤70 char; `to` must be live teammate
  or `*`; message non-empty.
- After send: composer closes; mailbox SVG arrows refresh.

### 3e. Per-teammate token cost display

Two display locations, both share the same data:

**(i) Inline on the teammate row** (already in 3a as `cost: $0.84` aggregate):
```
  👤 ux-designer    [working 2s]   ⚡   $0.18 · 14k tok
                                        ───── ────────
                                         cost   tokens
```

**(ii) On the floor-plan avatar**, reuse the existing `.char-salary` element
(`webview.html:3268`). No new DOM — just enable for team teammates by checking
`SESSION_USAGE[teammate.sessionId]`. Already wired, free.

For the team-row aggregate, we render a **mini stacked bar** showing each
teammate's share:

```
  agents-viz-teams · cost: $0.84
  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
  └ux─┘└─arch───┘└front─┘└hooks┘└──qa──┘
   $.18  $.32     $.12    $.08    $.14
```

Bar uses same teammate accent colors as the mailbox graph nodes.

---

## 4. CSS class naming + DOM structure

### 4.1 Naming convention

All team-related classes prefixed with `team-`. State variants are encoded
as **separate child elements**, not as modifier classes that share pseudo-
elements (per §3.1 of `CLAUDE.md`).

| Class                          | Where           | Purpose |
|--------------------------------|-----------------|---------|
| `.team-section`                | sidebar root    | wraps the "TEAMS" collapsible header + list |
| `.team-section-header`         | sidebar         | "▼ 👥 TEAMS (2) [+]" row, click toggles |
| `.team-row`                    | sidebar         | one team's container (collapsible) |
| `.team-row-header`             | sidebar         | "▼ ◆ teamname  5 mates" clickable |
| `.team-row-meta`               | sidebar         | "task: 6/6 · cost: $0.84 · lead: …" line |
| `.team-row-mates`              | sidebar         | container for teammate rows (existing session cards) |
| `.team-row-actions`            | sidebar         | "[📋 view tasks] [✉ open mailbox]" button row |
| `.team-mate-card`              | sidebar wrapper | thin div wrapping existing `.session` card; carries team context |
| `.team-ribbon-layer`           | floor plan      | absolutely-positioned `<svg>` over `#floor-plan`, z-index between rooms and modals |
| `.team-ribbon-arc`             | inside SVG      | `<path>` element per team, stroke = team color |
| `.team-ribbon-hull`            | inside SVG      | `<polygon>` fallback when teammate count ≥ 5 |
| `.team-mailbox-panel`          | inline overlay  | popover with the SVG mailbox graph |
| `.team-mailbox-node`           | inside SVG      | one teammate node circle |
| `.team-mailbox-edge`           | inside SVG      | one directional arrow `<path>` |
| `.team-tasks-panel`            | inline overlay  | kanban panel |
| `.team-task-col`               | inside panel    | one of pending/in-progress/completed columns |
| `.team-task-card`              | inside col      | one task card |
| `.team-compose-panel`          | modal           | reply composer |
| `.team-cost-bar`               | sidebar         | the mini stacked bar in 3e |
| `.team-cost-bar-segment`       | inside bar      | one teammate's slice |

### 4.2 Three teammate states — separate child elements (no shared `::before`)

The three teammate states are: `working`, `idle`, `shutdown_pending`.
**We do not create `.team-mate-card.working::before` etc.** — we follow the
pod-vs-room-char split (`webview.html:840-940`).

Inside `.team-mate-card`:

```
.team-mate-card                   <- always-present wrapper
├── .session.busy / .idle / ...   <- existing session card, drives sprite/sofa
└── .team-mate-state-overlay      <- one of three standalone subtrees:
    ├── .team-mate-working        <- pulsing dot + "[working 2s]"
    │   └── .twm-pulse-dot
    ├── .team-mate-idle           <- gray "[idle 12m]" label
    │   └── .twm-idle-clock
    └── .team-mate-shutdown       <- "⏻❓" with confirm/cancel buttons
        ├── .twm-shutdown-icon
        ├── .twm-shutdown-confirm
        └── .twm-shutdown-cancel
```

The `.team-mate-state-overlay` element is **swapped via DOM replacement**
when state changes (see §5 state machine), not via CSS class toggling. This
guarantees no pseudo-element bleed.

`twm-` prefix = "team mate" (short, avoids collision with existing `.tm-*`
animation classes if any).

### 4.3 Reused, untouched

- `.session`, `.avatar`, `.room-char`, `.pod-cell`, `.char-salary`,
  `.spark`, `.tt-dot` — all reused **as-is**. Team integration adds wrappers
  and overlays, never modifies these.
- `drawSubagentConnections()` SVG layer pattern — copied for `.team-ribbon-layer`.
  Two SVG layers can coexist (different z-index).

### 4.4 Color tokens

Teams get a deterministic accent color from `hashIdx(teamName, 360)` (existing
helper in `webview.html`). Exposed as CSS variable on `.team-row`:

```css
.team-row {
  --team-accent-h: 200;     /* set inline by JS via hashIdx */
  --team-accent: hsl(var(--team-accent-h), 65%, 55%);
  --team-accent-dim: hsl(var(--team-accent-h), 35%, 35%);
  border-left: 4px solid var(--team-accent);
}
.team-ribbon-arc        { stroke: var(--team-accent); }
.team-cost-bar-segment  { background: var(--team-mate-accent); /* per-mate */ }
```

---

## 5. State machine — three teammate visual states

```
            ┌─────────────────────────────────────────────────┐
            │                                                 │
            │            (any TaskUpdate or hook)             │
            │                  ┌────────────┐                 │
            │                  ▼            │                 │
   spawn ──>● working ◄────────● idle       │                 │
            │  │                ▲           │                 │
            │  │                │           │                 │
            │  │       no event │30min      │                 │
            │  │                │           │                 │
            │  │ shutdown_request                             │
            │  ▼                                              │
            ●  shutdown_pending ───── confirm ──> (removed)   │
            │                                                 │
            │  ◄── cancel ────                                │
            └─────────────────────────────────────────────────┘
```

### State definitions

| State              | Trigger to enter                            | Visual (overlay element)            | Trigger to leave                              |
|--------------------|---------------------------------------------|-------------------------------------|-----------------------------------------------|
| `working`          | last activity < 30min AND session.busy or has open task in_progress | `.team-mate-working` — pulsing colored dot, "[working Xs]" label using `meta.lastTool` emoji | activity → `idle` after 30min silence; receives shutdown → `shutdown_pending` |
| `idle`             | 30min since last hook event AND no in_progress task | `.team-mate-idle` — gray clock icon "[idle 12m]" | new hook event → `working`; receives shutdown → `shutdown_pending` |
| `shutdown_pending` | received `shutdown_request` legacy protocol message OR user clicked shutdown | `.team-mate-shutdown` — `⏻❓` icon + tiny confirm/cancel buttons | confirm → removed from team; cancel → previous state (working/idle) |

### Implementation rules

- State derived in `updateTeamMate(mate)` function (analog to existing
  `ingest`). Pure function: given mate object + current `Date.now()` + recent
  events, returns one of `'working' | 'idle' | 'shutdown_pending'`.
- DOM update: `setTeamMateState(card, newState)` — removes old overlay
  child, appends new overlay child. **Never toggles classes on the same
  element to switch states.**
- 30-min idle threshold should be a constant near the top of `webview.html`,
  reusing existing pattern with `STALE_MS` / `LONG_STALE_MS`. Add:

```js
const TEAM_IDLE_MS = 30 * 60 * 1000;  // 30min — teammate considered idle
```

- `shutdown_pending` overlay is **non-destructive**: the `.session` child
  stays mounted, sprite continues animating. We only swap the *overlay*
  child. This preserves cost/token displays and avoids a flash when user
  cancels the shutdown.

---

## 6. Integration checklist for frontend (#3)

1. Add `TEAMS` placeholder to `webview.html` head (uses §3.6 `typeof` guard
   pattern from `CLAUDE.md`):
   ```js
   const TEAMS = (typeof __TEAMS__ !== 'undefined') ? __TEAMS__ : { teams: [] };
   ```
2. `webview.ts` placeholder substitution must use `/__TEAMS__/g` (§3.2).
3. Add `renderTeamsSection()` called from `renderSidebar()` *before* the
   existing solo-sessions list. Insert returned DOM into `#sessions` container.
4. Add `renderTeamRibbons()` called from `renderFloorPlan()` *after* rooms
   are placed (so ribbon endpoints can read avatar bounding rects).
5. Add message handler `case 'teams-update'` in webview message handler
   (~line 2840) — replaces `TEAMS` and re-renders affected pieces.
6. CSS goes in a new `<style>` block region commented `/* ===== TEAMS ===== */`
   placed AFTER the existing pod-cell block (so it sits with related
   "standalone DOM" examples).
7. Persist UI state via existing `vscode.setState`:
   ```js
   state.teamsExpanded = { 'agents-viz-teams': true, ... }
   state.teamsActiveMailbox = 'agents-viz-teams' | null
   state.teamsActiveTasks   = 'agents-viz-teams' | null
   ```

---

## 7. What this does NOT do (explicit non-goals)

- **No animated message-fly between avatars** — just an SVG arrow that fades.
  Animation can come later if mailbox feels "lifeless".
- **No team-as-character avatar** — no group sprite walking around.
- **No drag-to-add teammate** — read-only viz. Roster mutation only via CLI
  / agent-teams skill.
- **No nested team support** — flat teams only in v1.
- **No task drag-and-drop** between columns — kanban is read-only.

---

## 8. Open questions for product lead (#5)

- Should removed teammates (post-shutdown) be **archived** in the sidebar
  (collapsed "previously on this team" section) or just disappear?
- Mailbox retention: how many recent messages to render in the SVG? Suggest
  last 30 minutes, max 50 messages, decay opacity by age.
- When a team has 0 live members, do we hide the team-row, dim it, or show
  a "team idle — last activity 2h ago" placeholder? Suggest dim + placeholder.

---

## 8b. Addendum — answers to frontend prep questions (2026-04-30)

### Q1. Default collapse state of team-rows

**Persisted per team**, mirroring the heatmap/costboard pattern. Use:

```js
state.teamsExpanded = state.teamsExpanded || {};
const expanded = state.teamsExpanded[teamId] ?? true;   // default: expanded on first sight
```

Rationale: a freshly-spawned team is the user's current focus — collapsing
it by default would hide what they just created. Once the user collapses
it, persist that choice. (Same default-open behavior as solo session list.)

### Q2. Reply composer entry points

**All three** — discoverability beats minimalism here, and each lives in a
different mental "scene" the user might be in:

| Entry point | Where | When user uses it |
|---|---|---|
| Mailbox-graph node click | `.team-mailbox-node` in mailbox panel | "I'm reading the conversation graph and want to reply to that arrow" |
| ✉ icon on teammate session card | top-right of `.team-mate-card`, 14×14 px | "I'm scanning the sidebar and want to ping someone fast" |
| Outstanding-prompt indicator (`🔔` badge already exists) | hover/click the existing waiting-state badge → opens composer pre-filled with `to: <that teammate>` | "Someone is waiting on me; respond" |

The `🔔` route is the highest-value one (it converts an existing visual into
an actionable affordance). Cost is small — same composer DOM, just three
trigger sites that all call `openComposer(teamId, toName?, threadId?)`.

### Q3. Mailbox graph edge encoding

**Three channels, each carrying one signal — no overload:**

| Visual channel | Encodes | Mapping |
|---|---|---|
| Stroke **opacity** | recency | `opacity = max(0.15, 1 - ageMs / 1_800_000)` — full at 0s, fades to 15% at 30min, then drops off graph |
| Stroke **width** | message count in last 30min | `width = clamp(1, log2(count + 1) * 1.5, 6)` — 1 msg = 1.5 px, 4 msgs = 3 px, 16 msgs = 6 px (cap) |
| Stroke **color** | sender's teammate accent (per-mate) | edge inherits `from`-side color via `var(--team-mate-accent)` — receiver-end gradient optional v1.1 |

**"Recent (<5min) edges should pop"** — add a single CSS animation on top:

```css
.team-mailbox-edge.recent {     /* JS adds this class when ageMs < 5min */
  filter: drop-shadow(0 0 3px var(--team-accent));
  animation: edgePulse 2s ease-in-out infinite;
}
@keyframes edgePulse { 50% { filter: drop-shadow(0 0 6px var(--team-accent)); } }
```

This is the **only** modifier class allowed on edges, and `.recent` does NOT
share `::before`/`::after` with anything (it just adds a filter). §3.1 safe.

### Q4. Task kanban card content

Include **all of**: `subject`, `owner` (with state emoji from existing
`stateCls` palette), `age` (as `timeAgo(updatedAt)`), and `blockedBy` chain
**rendered as inline pill-chain**, NOT a separate row:

```
┌─ Task card layout (each cell ≈ 180 × 80 px) ──────────────┐
│ #3 Frontend: webview teams viz                            │
│   👤 frontend · idle · 12m ago                            │
│   ⛓ blocked by: #1 ✓                          [···]      │
└──────────────────────────────────────────────────────────-┘
```

Rules:
- `blockedBy` only shown if non-empty.
- Pills clickable → scroll-to / highlight that task.
- Completed dependencies render as `#1 ✓` (faded), open ones as `#1` (bold).
- `[···]` button expands the card inline to show full `description` + the
  `blocks` chain (the inverse direction). v1: collapsed by default.

Skip these in v1 (defer): assignedBy, comments, full timestamp ISO, history.

### Q5. Per-team color theme

**Auto-derive from team name hash** — frontend does it inline, no doc lookup:

```js
function teamHueFor(teamName) {
  return hashIdx(teamName, 360);  // existing helper at ~webview.html:1500
}
function teamAccentVars(teamName) {
  const h = teamHueFor(teamName);
  return {
    '--team-accent-h': h,
    '--team-accent':      `hsl(${h}, 65%, 55%)`,
    '--team-accent-dim':  `hsl(${h}, 35%, 35%)`,
    '--team-accent-soft': `hsl(${h}, 50%, 92%)`,   // for mailbox panel bg
  };
}
```

Apply on `.team-row` and on `.team-mailbox-panel` for that team — child
elements (header border, ribbon arc, mailbox node ring) read the variable.

**Per-teammate** accent (used in mailbox node fill + cost bar segment) is
the **session's existing `meta.charIdx` color**, NOT a new derivation —
this keeps the mailbox graph visually consistent with the floor-plan
sprite pickers the user is already trained on.

If a future product decision wants user-overridable team colors, store
in `~/.claude/teams/{name}/config.json` as `accentHue: 200` and let the
auto-derive fall back when absent. Out of v1 scope.

---

## 8c. Schema calibration — actual `__TEAMS__` shape (post-architect, 2026-05-01)

> This doc was written before `TEAMS_DECISIONS.md` (the persistence ADR) landed.
> Several field names in §0–§3 were **guesses** that diverge from what now ships.
> If you read those sections, also read this. The ADR (`docs/TEAMS_DECISIONS.md`)
> and `extension/webview.html` are canonical; this doc is design intent only.

### Canonical shape (matches `TEAMS_DECISIONS.md §1` + extension code)

```js
TEAMS = {
  version: 1,
  teams: {                              // OBJECT keyed by team name (not array)
    "agents-viz-teams": {
      config: { members: [ {name, agent_id, agent_type, session_id} ] },
      config_size, config_mtime,
      first_seen_ts, last_active_ts,
      lifecycle_state: "init"|"active"|"idle"|"archived"|"deleted",
      tasks_summary: { total, completed, in_progress, pending },
      deleted_at?: <ms>
    }
  },
  messages: {                           // TOP-LEVEL, keyed by team name
    "agents-viz-teams": [ {ts, from, to, text_excerpt, transcript_path?} ]
  }
}
```

### Field-by-field corrections to earlier sections

| Earlier doc said | Actual schema | Where to read it |
|---|---|---|
| `teams: [...]` (array) | `teams: { <name>: {...} }` (object keyed by name) | iterate via `Object.entries(TEAMS.teams)` |
| `team.teammates` | `team.config.members` | nested under `config` per Phase-1 cache shape |
| `team.cwd`, `team.lead`, `team.createdAt` | **not in schema** — drop from UI bindings | cwd is per-session; lead is whoever dispatches |
| `member.role` | **not surfaced** — only `name`, `agent_id`, `agent_type`, `session_id` | role lives only in the spawner prompt |
| `member.status` (working/idle/shutdown_pending) | **derive client-side** from `bySession.get(session_id)`'s busy/waiting/monitoring + age | TEAMS has no per-member status; team-level `lifecycle_state` is the only state in the schema |
| `member.tokenCost` | derive via `SESSION_USAGE[session_id].cost` (lifetime) | already-rendered `.char-salary` value, single number not sparkline |
| `member.lastTaskId` | not derivable from cache — drop | out of v1 scope |
| `team.tasks: [...]` (full task array, used in §3c kanban) | **Both** `team.tasks: TeamTaskFull[]` (full bodies — `id, subject, description?, status, owner?, blockedBy?, blocks?, createdAt?, updatedAt?`) **and** `team.tasks_summary: {total, completed, in_progress, pending}` (counts) ship in v1. Kanban renders from `tasks`; chip/badge renders from `tasks_summary`. | (Updated 2026-05-01: ADR §1 originally specified summary-only, but frontend pushback established kanban can't render from counts alone. Architect + product-lead shipped both fields in task #7 follow-up; see `extension.ts:113-114`.) |
| `team.mailbox` | `TEAMS.messages[teamName]` (top-level, ring-buffered, last 5000) | from/to → compute who-spoke-to-whom edges client-side |

### Sections of this doc that are NOT canonical

- **§3a sidebar wireframe** — "task: 6/6" is correct (from `tasks_summary`); the per-mate `[working 2s]` / `[idle 12m]` / `[shutdown?]` labels still apply but are derived from `bySession`, not from any TEAMS field.
- **§3c task kanban (full per-task cards)** — **shippable in v1** as originally designed. `team.tasks: TeamTaskFull[]` carries `id, subject, description?, status, owner?, blockedBy?, blocks?, createdAt?, updatedAt?` — every field §3c and the §8b kanban-card layout (subject + owner + age + blockedBy pill-chain + `[···]` expander for description and `blocks`-chain) needs. Render the kanban panel from `tasks`; render the collapsed-row task chip ("6/12 done · 2 in progress · 4 pending") from `tasks_summary`. *(Calibration history: ADR §1 initially specified summary-only, frontend pushed back, architect + product-lead shipped both in task #7 follow-up. This bullet previously said "not shippable in v1" — corrected 2026-05-01.)*
- **§5 state machine (working / idle / shutdown_pending)** — `shutdown_pending` is **not in the schema**. Replace with the canonical 5 lifecycle states from `TEAMS_DECISIONS.md §3`: `init` / `active` / `idle` / `archived` / `deleted`. These are **team-level** (apply to the row), not per-member. Per-member visual status remains driven by the existing `bySession` flags.

### Sections that survive unchanged

- **§1 / §2** metaphor evaluation + ribbon-overlay recommendation — unchanged.
- **§3b mailbox graph** — edge encoding (opacity / width / color) survives; just iterate `TEAMS.messages[teamName]` to compute edges client-side rather than reading a pre-aggregated edge list.
- **§3d reply composer** — unchanged. POSTs to inbox endpoint defined in `TEAMS_DECISIONS.md §4`.
- **§3e per-teammate cost** — unchanged (already specified using `SESSION_USAGE[session_id]`).
- **§4 CSS class taxonomy + §3.1 standalone-DOM rule** — unchanged. Drop `.team-mate-shutdown` overlay (no shutdown_pending state); keep `.team-mate-working` / `.team-mate-idle` and **add** `.team-row.lifecycle-init` / `.lifecycle-archived` / `.lifecycle-deleted` modifiers on the team row (not on the mate). These are **separate row classes**, not `::before` overrides — §3.1 rule still holds.
- **§8b answers to frontend** — unchanged.

### Why this addendum, not a rewrite

By the time the architect's correction arrived, frontend (#3) had already
shipped against the actual schema. The earlier sections are preserved as
design-intent record (the metaphor evaluation, the §3.1 compliance reasoning,
the wireframes). Code is the source of truth for binding details; this
addendum is the single page to read when reconciling the doc with the code.

---

## 9. Verification plan (for QA #6)

- `screenshots/preview.html` (existing scaffolding) extended with a synthetic
  `TEAMS` payload featuring all three states.
- Visual diff: teammate state overlay swap (working → idle → shutdown_pending →
  back) does not flicker the underlying sprite.
- Stress test: 3 teams × 6 teammates × 30 mailbox messages should render
  in <500 ms (per existing performance baseline for `renderFloorPlan`).
- §3.1 regression check: with two teams whose mates overlap one project room,
  no `::before` collision; ribbons render distinct colors; no z-fighting.

---
