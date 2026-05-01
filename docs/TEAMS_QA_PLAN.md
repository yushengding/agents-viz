# TEAMS_QA_PLAN.md — QA Plan for Agent Teams Visualization

> Status: PHASE 1 plan v2 (revised after reading product-lead's TEAMS_DECISIONS.md) · 2026-04-30
> Owner: qa-auditor
> Project: `C:\Users\Yusheng Ding\Desktop\projects\agents-viz`

---

## 0. Scope & Premise

Per `docs/TEAMS_DECISIONS.md` (product-lead, accepted 2026-04-30):

- **Phase 1 ships READ-ONLY**: roster, tasks, messages, lifecycle states, per-teammate spend. **No reply UI.**
- **Phase 2** adds file inbox + `UserPromptSubmit` hook reply path.
- **Phase 3** (deferred): proxy teammate for sub-second bidirectional UX.

Phase 1 features under test:

1. Sidebar grouping per team (replaces flat session list)
2. Mailbox display (SVG graph or message ribbon — frontend's call) showing who→whom from `~/.claude/projects/{p}/transcript.jsonl` SendMessage events
3. Task kanban (per-team task list, status columns)
4. Per-teammate token cost column
5. **Lifecycle states** — 5 states `init / active / idle / archived / deleted` derived from config.json mtime + tasks activity (NEW per §3 of decisions)
6. **Persistence via `~/.agents-viz/team-cache.json`** (key: `(team_name, mtime, size)` of `config.json`, schema versioned at `version: 1`)

**Phase 1 scope contract** (locked by product-lead 2026-04-30):

IN SCOPE for Phase 1 testing:
- Team config recovery from `team-cache.json` (Inv 1, 6)
- Task state recovery (re-projection from `~/.claude/tasks/`)
- Stale teammate flag derivation post-restart (lifecycle: `idle` if >60min, `archived` if >24h)
- Mailbox edges persistence (5,000-msg ring per team in `team-cache.json`, FIFO eviction; Inv 2)
- Token cost agreement between `team-cache.json` `tasks_summary` and a fresh `usage-cache.json` read

OUT OF SCOPE for Phase 1 (test as Phase 2/3 future work, NOT failures):
- Reply mechanism (file inbox + UserPromptSubmit hook) → Phase 2 — Test 2 + Test 7 deferred
- Proxy teammate (sub-second bidirectional) → Phase 3, behind feature flag
- Tombstone GC verification (7-day retention) → skip if test runs <7 days

This plan defines 7 end-to-end tests (5 Phase 1 active + 2 Phase 2 deferred) + 3 race probes + a 28-question cold-audit checklist.

**Ground-truth files** to read for cold-audit (not DM summaries — see `feedback_skill_is_hypothesis_not_evidence.md`):

| Teammate | Deliverable file(s) | What to verify |
|---|---|---|
| `architect` (Task #2) | `extension/src/extension.ts`, new `extension/src/teams-watcher.ts` (likely), `team-cache.json` writer | TS data layer reads `~/.claude/teams/*/config.json` + `~/.claude/tasks/*/*.json`, writes `~/.agents-viz/team-cache.json` per decisions §1 schema, emits to webview |
| `frontend` (Task #3) | `extension/webview.html` (sidebar grouping + mailbox display + kanban + cost col); decisions §1 says NO reply composer in Phase 1 | DOM structure exists, CSS doesn't share `::before`/`::after` per §3.1, lifecycle state badges (`init`/`active`/`idle`/`archived`/`deleted`) per decisions §3 |
| `hooks-devops` (Task #4) | If Phase 1 only: forwarder extension for SendMessage events. If Phase 2 too: `~/.agents-viz/inbox-hook.js`, `UserPromptSubmit` config in `Configure Claude Code Hooks` flow | Hook reads `~/.agents-viz/inbox/{team}/{teammate}/{ts}.json`, atomic-writes via `*.tmp`+rename, drops on TTL expiry, concats up to 10 pending |
| `product-lead` (Task #5, ✅ done) | `docs/TEAMS_DECISIONS.md` | ✅ Read — 4 ADRs locked: persistence (file JSON, no SQLite), retention (5K-msg ring), lifecycle (5 states), reply (P2 file inbox) |

---

## 1. Five end-to-end tests

### Test 1 — Display correctness

**Goal**: Spawn a 2-teammate test team and verify all 4 visual elements render correctly in a single dashboard view.

**Pre-conditions**:
- VS Code with `agents-viz` extension installed (latest build from `npm run compile`)
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` already set in `~/.claude/settings.json` (verified)
- `~/.claude/teams/` and `~/.claude/tasks/` empty or only contains stale folders (clean baseline)

**Steps**:
1. In a fresh Claude Code session: `TeamCreate({team_name: "qa-test-team", description: "QA dogfood", agent_type: "team-lead"})`
2. `TaskCreate({subject: "Test task A", activeForm: "Doing A"})` ×2 with different IDs
3. `Agent({subagent_type: "general-purpose", team_name: "qa-test-team", name: "alpha", run_in_background: true, prompt: "<dummy task>"})` — spawn `alpha`
4. Same for `beta`
5. Have `alpha` send 2 messages to `beta` via `SendMessage`, `beta` reply 1 message
6. Open `agents-viz` panel: `Ctrl+Shift+P` → `Agents Viz: Open Panel`
7. Within 3s of panel open, screenshot the full webview to `screenshots/qa/test1_display.png`

**Pass criteria** (verify each independently in screenshot via Read):
- [ ] **Sidebar grouping**: A `qa-test-team` collapsible section appears, with `alpha` and `beta` as child rows (not flat under sessions list)
- [ ] **Mailbox SVG graph**: 2 directed edges visible (alpha→beta thicker [weight 2], beta→alpha thinner [weight 1])
- [ ] **Task kanban**: 2 task cards visible, columns are pending/in_progress/completed (or similar)
- [ ] **Per-teammate token cost column**: alpha and beta each show a $X.XX cost cell (could be $0.00 if no tools used yet, but cell must exist)
- [ ] No console errors in VS Code Output → Agents Viz channel

**Fail modes to call out**:
- Sidebar still shows flat session list with team members mixed in → grouping not implemented
- Mailbox graph has 0 edges or self-loops → message direction parsing broken
- Cost column shows `undefined` or `NaN` → token-estimator not wired for teammates
- All teammates render but no team header → grouping logic regressed

---

### Test 2 — Reply round-trip [DEFERRED to Phase 2 per product-lead 2026-04-30]

> **Status**: DEFERRED. Per product-lead, reply mechanism (file inbox + UserPromptSubmit hook) is Phase 2 scope. Don't test bidirectional message delivery in Phase 1 — flag as future work, not test failure. Hooks-devops's `inbox-reader-hook.js` was landed early but is not wired through frontend reply UI in Phase 1.
>
> Test plan kept below for Phase 2 reuse.

**Goal**: Verify user can type a reply in the panel and it reaches the target teammate as a UserPromptSubmit injection.

**Pre-conditions**:
- Test 1 setup (qa-test-team with `alpha` running)
- File-inbox path: `~/.agents-viz/inbox/qa-test-team/alpha.json`

**Steps** (programmatic, not via UI — to isolate hook from frontend):
1. Programmatically write to inbox:
```bash
mkdir -p ~/.agents-viz/inbox/qa-test-team
echo '{"from":"qa-test","ts":1714450000,"text":"PING test 2"}' > ~/.agents-viz/inbox/qa-test-team/alpha.json
```
2. `alpha` is currently idle (waiting for input). Wait up to 10s for hook trigger.
3. Check `alpha`'s next response — it must contain text indicating it received "PING test 2".
4. Verify `~/.agents-viz/inbox/qa-test-team/alpha.json` is **deleted** by the hook (one-shot).
5. Then test via UI: open panel, click `alpha` row, find reply composer, type "PING via UI", click send.
6. Verify `alpha` receives this prompt within 5s.
7. Screenshot: `screenshots/qa/test2_reply_received.png`

**Pass criteria**:
- [ ] Programmatic file-inbox path works (alpha sees "PING test 2")
- [ ] Inbox file deleted after consumption (no stale file leak)
- [ ] UI reply composer also works (alpha sees "PING via UI")
- [ ] Hook does NOT inject when teammate is busy (race-safe — see Test 3 for stricter check)

**Fail modes**:
- Hook fires but alpha never sees the text → `UserPromptSubmit` payload format wrong
- File never deleted → inbox accumulates → repeated injection
- Hook fires for ALL teammates (broadcast) instead of just the one targeted by filename → routing bug

---

### Test 3 — Race condition: file-locked task claim

**Goal**: Verify two teammates can't both claim the same task — file-locking prevents double-claim.

**Pre-conditions**:
- Fresh team with 1 unowned task
- 2 teammates `alpha` and `beta` ready to claim

**Steps**:
1. `TaskCreate({subject: "Race-target", status: "pending"})` — get its taskId
2. Send identical message to both `alpha` and `beta` simultaneously: `"Claim task <taskId> via TaskUpdate(owner=<your-name>) immediately when you read this"`
3. Wait 30s for both to respond
4. `TaskGet({taskId: <id>})` — read final state
5. Inspect `~/.claude/tasks/qa-test-team/<id>.json` for owner field

**Pass criteria**:
- [ ] Final task owner is exactly ONE of `{alpha, beta}` — not both
- [ ] The losing teammate either (a) sees a TaskUpdate error / rejection, OR (b) sees a status indicating already-claimed when they try
- [ ] No corrupted JSON in task file (no partial write artifacts like trailing comma)

**Fail modes**:
- Owner field shows `"alpha,beta"` or last-write-wins silently → no locking
- One teammate's `TaskUpdate` returns success but final state shows other → race window unprotected
- Both teammates start working on the task → wasted compute + likely conflict downstream

**Note**: This relies on the SDK's `TaskUpdate` having atomic file-lock semantics — agents-viz should NOT need to implement locking, but should DISPLAY the loser correctly. Verify dashboard does NOT show double-claim visually.

---

### Test 4 — Stale data detection

**Goal**: Verify dashboard flags a teammate that died mid-task without firing TaskCompleted hook.

**Pre-conditions**:
- Team with `alpha` actively working on a task (status=in_progress, owner=alpha)

**Steps**:
1. Identify alpha's PID (Windows: `tasklist /fi "windowtitle eq *alpha*"` or via VS Code task manager)
2. Force-kill the process: `taskkill /F /PID <alpha-pid>`
3. Verify `~/.claude/teams/qa-test-team/config.json` still lists alpha as a member (kill doesn't auto-clean)
4. Verify alpha's task is still status=in_progress (TaskCompleted hook never fired — that's the stale signal)
5. Wait 60s, screenshot `screenshots/qa/test4_stale_30s.png`
6. Wait additional 30 min (or fast-forward if dashboard has a debug knob), screenshot `screenshots/qa/test4_stale_30min.png`

**Pass criteria**:
- [ ] After 60s, alpha row shows some "no recent activity" indicator (e.g., grayed out, ⚠️ badge, or `idle 1m+`)
- [ ] After 30m, alpha row shows clear stale flag (e.g., "owner: alpha, idle 30+ min" or similar) — not still pretending alpha is busy
- [ ] Task card in kanban also shows orphan status (e.g., `⚠️ owner offline`) — not just stuck in `in_progress` silently
- [ ] No false stale flag for a teammate that's just thinking (don't conflate "no PostToolUse for 60s" with "process dead")

**Fail modes**:
- Dashboard happily shows alpha as `busy` forever → no liveness check
- Dashboard removes alpha entirely from sidebar (over-aggressive) → user can't tell it died vs. cleanly shut down

**Implementation hint to verify in code**: there should be a periodic `setInterval` somewhere (probably webview.html) checking `Date.now() - lastEventTs > THRESHOLD` for each teammate, NOT relying on a `Stop` hook that never came.

---

### Test 5 — Persistence via `team-cache.json` after VS Code restart

**Goal**: Verify dashboard recovers team state from `~/.agents-viz/team-cache.json` per decisions §1 schema, with all 6 Appendix invariants honored.

**Pre-conditions**:
- Team with state from Tests 1-4 still on disk (don't clean up before this test)
- `~/.claude/teams/qa-test-team/config.json` and `~/.claude/tasks/qa-test-team/*.json` exist
- `~/.agents-viz/team-cache.json` exists with `version: 1` and qa-test-team entry

**Steps**:
1. `cat ~/.agents-viz/team-cache.json` — verify schema matches decisions §1 (version field, teams.{name}, messages.{name})
2. Note dashboard state — screenshot `screenshots/qa/test5_before_restart.png`
3. Send 5,001 messages between alpha and beta (script via SendMessage in a loop) — verify ring buffer trims to 5,000
4. Close VS Code entirely (not just reload window — full quit)
5. Reopen VS Code, open `agents-viz` panel
6. Within 5s of panel open, screenshot `screenshots/qa/test5_after_restart.png`
7. `cat ~/.agents-viz/team-cache.json` after restart — verify size unchanged (cache hit, not full rebuild)

**Pass criteria** (mapped to decisions §Appendix invariants):
- [ ] **Inv 1 — No message loss across restart**: send N messages pre-restart, verify all N in panel post-restart
- [ ] **Inv 2 — Ring buffer FIFO at 5,000**: 5,001st write evicts 1st; 2nd onward intact in `messages.{team}` array
- [ ] **Inv 3 — Lifecycle monotonic forward**: alpha was `active` pre-restart → still `active` post-restart (or correctly transitioned to `idle` if past 60min STALE_MS); never resets to `init`
- [ ] **Inv 6 — Cache version mismatch wipes file**: manually edit cache file `version: 99`, restart → cache rebuilt fresh (no stale entries leaked)
- [ ] Same team appears in sidebar with same member names
- [ ] Same kanban task statuses (pending/in_progress/completed) preserved
- [ ] Stale teammate from Test 4 still shown as stale (state recovered, not reset)
- [ ] No duplicate teammates (file-watcher should debounce on init)
- [ ] `lifecycle_state` field reads correctly from cache (not recomputed wrong on restart)

**Fail modes**:
- Sidebar empty after restart → cache not loaded, falls back to live-only data
- Mailbox messages lost despite ring buffer → ring buffer not persisted
- Lifecycle resets to `init` on restart → derived state not stable across restart
- Cache version mismatch silently keeps stale data → invariant 6 broken

---

### Test 6 — Lifecycle state derivation (per decisions §3)

**Goal**: Verify the 5 lifecycle states transition correctly based on config.json mtime + tasks activity.

**Steps**:
1. **init**: TeamCreate without spawning teammates → verify dashboard shows `init` badge + "spawning..." indicator + roster only (no message ribbon)
2. **active**: Spawn alpha+beta, both run a task → dashboard shows `active` badge with full ribbon
3. **idle**: Wait 61 min (or fast-forward via debug knob), with 1 task still in_progress → dashboard shows `idle` (visually dimmed, matches existing 1h sofa convention)
4. **archived**: 24h+1m elapsed AND no in-flight tasks → `archived` badge + collapsed last-10-messages
5. **deleted**: `rm -rf ~/.claude/teams/qa-test-team/` → tombstone row "deleted YYYY-MM-DD" appears within 5s
6. Screenshot each state: `screenshots/qa/test6_state_<name>.png`

**Pass criteria**:
- [ ] All 5 states render with distinct visual indicators
- [ ] `STALE_MS` and `LONG_STALE_MS` constants reused (NOT new threshold constants — see decisions §3 "reuse existing")
- [ ] Transitions are monotonic forward — `archived` does NOT auto-revert to `active` even if late events arrive (per decisions §3 "we ignore late events from archived teams")
- [ ] Tombstone for `deleted` retained 7 days, then GC'd from `team-cache.json`
- [ ] No panel buttons that mutate Claude Code's own state (per decisions §3 "Out of scope" — only derived states)

---

### Test 7 — Inbox atomic write + TTL drop [DEFERRED to Phase 2 per product-lead 2026-04-30]

> **Status**: DEFERRED. Reply path is Phase 2 scope. The hook code itself was cold-audited (5 spec divergences DM'd to hooks-devops on 2026-04-30) but end-to-end testing waits until frontend writer + reply UI ship in Phase 2.
>
> Test plan kept below for Phase 2 reuse.

**Goal**: Verify the file inbox honors decisions §4 mitigations.

**Pre-conditions**: Phase 2 reply path implemented (`~/.agents-viz/inbox-hook.js` + `inbox/{team}/{teammate}/{ts}.json`).

**Steps**:
1. **Atomic write**: Use a Python/Node script to start writing a 100KB JSON to `inbox/qa/alpha/<ts>.json` — kill mid-write at byte 50KB. Verify hook does NOT pick up the partial file. (Implementation: hook should only read files that complete the `*.tmp` → rename ceremony.)
2. **TTL drop**: Write a message with `ttl_ms: 1000`, wait 2s, then trigger the hook. Verify message is dropped + log line added to `~/.agents-viz/inbox/_dropped.log`.
3. **Concat cap**: Write 15 messages while alpha is busy. When alpha boundaries to next prompt, verify hook concatenates ≤ 10 with `--- next message ---` separator + remaining 5 stay in inbox for next round.
4. **O_EXCL lock**: Spawn 2 instances of inbox-hook.js trying to write simultaneously to same `*.tmp`. Verify one succeeds, other returns lock error (no corrupt file).

**Pass criteria** (mapped to decisions Appendix invariants):
- [ ] **Inv 4 — Inbox atomic writes**: mid-write crash leaves no partial file readable to the hook
- [ ] **Inv 5 — TTL drops happen**: expired message logged + skipped, not silently delivered late
- [ ] Concat cap = 10 messages per delivery
- [ ] O_EXCL prevents corrupt double-writes
- [ ] Failure-soft: hook errors don't crash teammate session

### Test 7.5 — log.md forensic audit (per decisions §6, added 2026-04-30 final)

**Goal**: Verify per-team `log.md` forensic audit log invariants. Per product-lead's final ruling, log.md is **delivery audit** (hook-side proof of what was delivered), distinct from transcript.jsonl (what teammate received) and team-cache.json (240-char ring for UI ribbon).

**Steps**:
1. **Presence + content after delivery**: Trigger 3 message deliveries to alpha. Verify `~/.agents-viz/inbox/qa-test-team/log.md` exists with 3 `## <ts> <KIND> <from> → alpha` headed sections, each with FULL body (not 240-char excerpt).
2. **Rotation at 10 MB**: Pre-seed `log.md` to 10 MB exactly, trigger 1 more delivery. Verify rename to `log.<YYYY-MM-DD>.md` and fresh `log.md` starts with the new entry. Implementation reference: hook line 138 `st.size >= AUDIT_LOG_MAX_BYTES`.
3. **Same-day collision suffix**: Pre-seed both `log.md` (10 MB) and `log.<today>.md`, trigger delivery. Verify second archive becomes `log.<today>-2.md`. Counter increments to 99 (line 147 `if (n > 99) break`) then gives up gracefully (appends to existing log.md without rotation).
4. **Malformed-JSON gating**: Drop a malformed `{ts}.json` into inbox alongside a valid one. Verify only the valid one writes to log.md; the malformed appears in `_dropped.log` only (no log.md entry — failure-soft hook discipline).
5. **Race C carve-out — preserve through archived/deleted**: Per product-lead's clarification, `log.md` and rotation siblings must survive lifecycle GC. Only pending `{teammate}/*.json` dirs get cleaned. Trigger archived/deleted state on team, verify `log.md` still readable on disk.

**Pass criteria**:
- [ ] log.md presence + full-body content (NOT 240-char excerpt — distinct from team-cache.json ring)
- [ ] 10 MB rotation triggers rename to dated archive
- [ ] Same-day collision uses `-N` suffix up to 99
- [ ] Malformed JSON does NOT pollute log.md (only `_dropped.log` records it)
- [ ] Archived/deleted lifecycle preserves log.md (forensic audit not GC'd)
- [ ] log.md and transcript.jsonl can diverge under failure-soft swallow — divergence detectable by comparing `## <ts>` count vs transcript USER prompt count

---

## 2b. Additional race probes from product-lead (2026-04-30)

Per product-lead DM, three specific race scenarios MUST be probed in addition to Tests 1-7:

### Race A — Two extension instances writing to same inbox dir

**Goal**: Verify O_EXCL on tmp file serializes concurrent writers (decisions §4 mitigation row 5).

**Steps**:
1. Open VS Code window 1 with agents-viz panel
2. Open VS Code window 2 same workspace (concurrent extension hosts active)
3. From window 1, trigger a write to `~/.agents-viz/inbox/qa-test-team/alpha.json`
4. Within 50ms (use a script invoking the writer code path), trigger a write from window 2 to same path
5. Inspect resulting file + `~/.agents-viz/inbox-reader-debug.log`

**Pass**: Final inbox.json is one of the two writes (not corrupted/merged); the other writer either retried successfully OR errored loudly (not silent clobber). Tracked under **Test 7.4**.

### Race B — Idle→archived transition collides with TaskCompleted

**Goal**: Verify late TaskCompleted on a team mid-archival doesn't resurrect (decisions §3 "no resurrection thrash").

**Steps**:
1. Set up team where alpha has 1 in_progress task; let team go idle
2. Wait until lifecycle is JUST about to transition to `archived` (24h - 30s)
3. While still in idle: alpha completes its task → `TaskCompleted` event fires
4. After 30s, transition fires → check final lifecycle state in `team-cache.json`

**Pass**: Per decisions §3, archived state ignores late events → final state is `archived` (not bumped back to `active` or `idle`). UI does NOT show team as live again.

**Cheap-test caveat**: 24h+30s wait isn't cheap. Need a debug knob `AGENTS_VIZ_LIFECYCLE_FAST=1` (or equivalent mtime mock) from architect. **If absent, FLAG AS DOCUMENTATION GAP** per product-lead's instruction. Fallback test: manually edit `team-cache.json` `last_active_ts` to simulate elapsed time, restart panel, observe.

### Race C — config.json deleted mid-flight

**Goal**: Verify dashboard handles team disappearance gracefully when teammate is still emitting events.

**Steps**:
1. Team active with alpha generating PreToolUse events
2. While alpha is mid-task, `rm ~/.claude/teams/qa-test-team/config.json` (don't kill alpha)
3. Watch dashboard for 30s as alpha continues to emit events
4. Verify lifecycle transitions to `deleted` with tombstone
5. Verify alpha's incoming events do NOT resurrect the deleted team in `team-cache.json`

**Pass**: Per decisions §3, deleted state shows tombstone "deleted YYYY-MM-DD"; teammate's events are ignored (no resurrection). No console errors in `Output → Agents Viz` channel.

**Documentation gap to flag** (cheap-test analysis): depends on whether `extension.ts` watches `~/.claude/teams/*` for `unlink` events (vs. only polling on panel-open). Architect to confirm via deliverable cold-audit.

---

## 2c. Invariant-to-test mapping (decisions §Appendix vs my Tests)

| Decisions Inv | Test (cheap?) |
|---|---|
| 1. No message loss across restart | Test 5 sub-criterion 1 (cheap) |
| 2. Ring buffer FIFO at 5,000 | Test 5 sub-criterion 2 (cheap) |
| 3. Lifecycle monotonic forward | Test 5 sub-criterion 3 + Test 6 + Race B (Race B EXPENSIVE — needs debug knob) |
| 4. Inbox atomic writes | Test 7.1 + Race A (cheap if writer code is testable in isolation) |
| 5. TTL drops | Test 7.2 (cheap) |
| 6. Cache version wipes file | Test 5 sub-criterion 6 (cheap) |

**Documentation gaps RESOLVED to firm specs** (per product-lead 2026-04-30 ruling):

- **Inv 3 + Race B — debug knob CONFIRMED REQUIRED**: architect MUST ship `AGENTS_VIZ_LIFECYCLE_FAST_MS` env var (dev-only, default unset = real 60min/24h thresholds). When set, divides thresholds. Behind dev env, NOT runtime setting (prod path untouched). **Audit criterion**: if architect's deliverable ships without this knob, FAIL the audit on Race B and route fix back to task #2. Do NOT accept mtime-mock fallback as passing evidence.

- **Race C — fs.watch CONFIRMED REQUIRED, NOT poll-only**: tombstone must appear within 5 s of `config.json` unlink (hard requirement, not nice-to-have). **Audit criterion**: if architect's deliverable uses only periodic polling on `~/.claude/teams/*` (no `fs.watch` unlink listener), FAIL the audit on Race C and route fix back to task #2.

Both criteria will be surfaced explicitly in `TEAMS_QA_REPORT.md` Phase 2 deliverable.

---

## 2. Cold-audit checklist (28 questions)

> Apply per `feedback_cold_audit_methodology.md`: zero-context independent review of each deliverable file. **Read the file directly, not the DM summary.** Don't critique design (that's ux-designer's lane); critique correctness vs. spec.

### A. Convention compliance (CLAUDE.md §3.1-3.6)

1. **§3.1 — CSS isolation**: Does any new CSS rule add `.room-char.<state>::before` or `::after` that conflicts with existing `.stale` / `.long-stale` rules? (If yes, scope drift toward known-broken pattern.)
2. **§3.1 — DOM separation**: Are new visual states (e.g., `.team-pod`, `.mailbox-edge`) implemented as standalone DOM subtrees, not as modifier classes on `.room-char`?
3. **§3.2 — Replace /g**: Does `webview.ts` use `/regex/g` for ALL new placeholder substitutions? Search for any `.replace("__NEW_X__", ...)` without `/g`.
4. **§3.3 — Render purity**: Do any new `_render*` / `update*` functions in webview.html assign to state fields or dispatch events? They must be pure reads.
5. **§3.4 — Project routing**: If team grouping reuses cwd voting, does it still skip `cwd ∈ {~, projects-root}` per the existing rules? Or has new code re-introduced naive cwd parsing?
6. **§3.5 — Boundary validation only**: Does new code add null-checks for fields the schema (config.json / tasks/*.json) guarantees? (Should NOT — only validate at HTTP/JSONL boundary.)
7. **§3.6 — typeof guard**: Are new placeholders (e.g., `__TEAMS_DATA__`, `__INBOX_PATH__`) defended with `typeof X !== 'undefined' ? X : <default>`?

### B. State ownership

8. Where is the canonical `teams` state stored — `extension.ts` memory, on-disk only, or both with bidirectional sync? Is the source-of-truth direction documented?
9. Is per-teammate token cost computed in the same place as per-session token cost (reuse `scanCachedAll` / `token-estimator.ts`)? Or is there a parallel implementation?
10. When a teammate is added (file-watcher detects new `config.json` member), is the state update atomic — single `state.teams[X].members[Y] = ...` — or does it walk multiple maps with potential mid-update reads?
11. Who clears `state.teams[X]` when `~/.claude/teams/X/` is deleted? Is there a TeamDelete watcher or only an additive watcher?

### C. Race condition coverage

12. Does the file-inbox hook (`UserPromptSubmit` for teammates) handle concurrent writes to the same `inbox/{team}/{name}.json`? (E.g., if user sends 2 replies in 100ms, are both delivered or does one get clobbered?)
13. Is there protection against the dashboard reading `tasks/*.json` mid-write by the SDK? (The SDK's atomic write should handle this via temp+rename, but verify the watcher uses `fs.watch` + size>0 check, not naive readFileSync.)
14. Multi-VS-Code-window: if user has 2 windows open, both running the agents-viz panel, do they both fire UserPromptSubmit hooks for the same teammate (causing double-injection)?
15. When a teammate dies mid-message-write to mailbox, is the partial JSON line in the transcript handled (skip vs. crash)?

### D. Screenshot evidence (per `feedback_visual_output_verify.md`)

16. Does the QA report (Phase 2 deliverable) include actual PNG screenshots, or just descriptions of what was tested?
17. For each PASS test, is the screenshot Read by the auditor (visually inspected) before claiming PASS — not just "screenshot created"?
18. Do FAIL screenshots show the specific broken element with annotations (red arrows, zoom-ins) or just full-window dumps?

### E. Reply round-trip soundness

19. What happens when the file inbox is deleted by user mid-hook-run? (E.g., race between `fs.readFileSync` and `fs.unlinkSync`.)
20. Does the inbox file format support multi-line text (newlines in user reply)? If JSON-encoded, that's free; if text-only, verify escaping.
21. If the `UserPromptSubmit` hook fails (network/disk error), does it return non-zero and surface error to user, or silently swallow? (Should fail loudly per `feedback_silent_load_failures.md`.)
22. Is there a max inbox file size to prevent OOM if user pastes a huge reply?

### F. Persistence soundness

23. After restart, where does the dashboard pull historical mailbox edges from — JSONL transcripts (slow, complete) or in-memory only (fast, lossy)? Documented choice?
24. Is the persistence reload path tested at `agents-viz` startup — i.e., does `extension.ts` activate hook handle the case where `~/.claude/teams/` already has 5 teams from a prior session?
25. Does the on-disk cache (`~/.agents-viz/usage-cache.json`) version-bump when team-related data is added? (Per existing CLAUDE.md gotcha: "if you change how usage is computed, bump a version field".)

### G. Scope drift detection

26. Did any teammate add features OUTSIDE their task spec? (E.g., did `frontend` also rewrite `extension.ts` parts that weren't in Task #3?) — pull `git diff` to verify.
27. Did any teammate skip a sub-deliverable from their task spec? (E.g., Task #3 might list 5 UI elements; check all 5 exist in webview.html, not just 3.)
28. Are there any new dependencies added to `extension/package.json` that weren't pre-approved? (Bundle bloat for shipping.)

---

## 3. Phase 2 execution plan (after teammates 2/3/4 DM done)

1. **Read deliverable files first** — for each of architect/frontend/hooks-devops, Read the actual modified files (not the summary). List concrete file paths in the QA report.
2. **Run cold-audit checklist** against each deliverable, marking PASS/FAIL/N/A per question with file:line citation where issue found.
3. **Spawn test team** — coordinate with `team-lead` to spawn `qa-test-team` (since teammates can't spawn nested teams per Skill doc §"Known limitations").
4. **Run all 5 tests sequentially** — between each, screenshot evidence to `screenshots/qa/`.
5. **Read each screenshot** before claiming PASS — verify visually that the element under test actually rendered.
6. **Write `TEAMS_QA_REPORT.md`** with: per-test PASS/FAIL + screenshot path, per-question audit result, prioritized fix list (P0 = ship-blocker, P1 = should-fix-before-ship, P2 = nice-to-have).

---

## 4. Anti-patterns I will NOT do

- Parroting deliverable summaries verbatim (cold-audit means independent reading)
- Claiming PASS without screenshot + Read verification of the screenshot
- Critiquing UX/design decisions (that's `ux-designer`'s lane — out of scope for QA)
- Running fewer than 5 tests because "looks fine in summary" (per `feedback_skill_is_hypothesis_not_evidence.md`)
- Marking task #6 complete if any P0 still open (per `feedback_progress_inflation_pattern.md`)
- Adding more tests for hypothetical scenarios beyond the 5 specified (no scope inflation per CLAUDE.md "Don't add features beyond what task requires")

---

## 5. Coordination

- **Notify** `architect` / `frontend` / `hooks-devops` when I've read their deliverables (so they know if I missed a recent edit).
- **DM** `product-lead` to align on persistence invariants Test 5 must check (e.g., is mailbox-edge persistence in scope or future work?).
- **DM** `team-lead` if a P0 ship-blocker found OR if testing reveals a missing invariant that needs a new task.
