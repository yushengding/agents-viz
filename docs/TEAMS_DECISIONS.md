# TEAMS_DECISIONS.md

> ADR for Claude Code agent-teams support in agents-viz.
> Status: Accepted (2026-04-30) · Owner: product-lead
> Scope: persistence, retention, lifecycle, reply mechanism, roadmap.

This document locks the four ambiguous policy decisions blocking architect, hooks-devops, and frontend. Each section states the decision first; rationale follows.

---

## 1. Persistence policy

**Decision: file-based JSON at `~/.agents-viz/team-cache.json`, keyed by `(team_name, mtime, size)` of `~/.claude/teams/{team-name}/config.json`. No SQLite.**

### Rationale

- Existing `usage-cache.json` already proves the (size, mtime) invalidation pattern at `extension.ts` `scanFileWithCache`. Reuse it; do not introduce a second persistence stack.
- Team state lives across **two** trees that we already watch: `~/.claude/teams/{team}/config.json` (member roster) and `~/.claude/tasks/{team}/*.json` (one file per task). Both are JSON. Mirroring them as JSON in our cache is zero impedance mismatch.
- SQLite would buy: indexed queries, concurrent writers, transactional integrity. We have none of those needs — the panel is a single-reader, the source-of-truth files are owned by Claude Code (we never write to them), and the dataset is small (see §2 disk projection).
- SQLite would cost: a native dep (`better-sqlite3`) that breaks the current pure-JS bundle, schema migration overhead, and a second persistence pattern in the codebase that AI-agents-onboarded-via-CLAUDE.md will not understand.

### Schema

```json
{
  "version": 1,
  "teams": {
    "<team-name>": {
      "config_size": 4321,
      "config_mtime": 1714500000000,
      "members": [ {"name": "...", "agent_id": "...", "agent_type": "...", "session_id": "..."} ],
      "first_seen_ts": 1714400000000,
      "last_active_ts": 1714500000000,
      "lifecycle_state": "active",
      "tasks_summary": { "total": 12, "completed": 9, "in_progress": 2, "pending": 1 }
    }
  },
  "messages": {
    "<team-name>": [
      {"ts": 1714500000000, "from": "lead", "to": "researcher", "text_excerpt": "...", "transcript_path": "..."}
    ]
  }
}
```

`version` field is a hard precondition for §2 retention changes — bump on schema break, drop the file on read mismatch (matches current usage-cache convention).

### Migration path

- New file. No migration of `usage-cache.json` content — they are siblings, not the same store.
- First panel open after teams support ships: `team-cache.json` is absent → full scan of `~/.claude/teams/*` and `~/.claude/tasks/*`, write fresh cache. Identical to how `usage-cache.json` warmed on its first run.
- Hand-delete to force rescan. Same UX as usage-cache.

---

## 2. Mailbox retention

**Decision: ring buffer, last 5,000 messages per team, in `team-cache.json`. Full audit trail lives in Claude Code's own per-teammate transcripts (`~/.claude/projects/{project}/transcript.jsonl`) — we do not duplicate that storage.**

### Rationale

- mclaude pattern (append-only markdown, audit > storage) optimises for audit. We are a **dashboard**, not an audit tool. The user already gets full audit from Claude Code's transcripts. Re-storing every message in our cache is duplicate state, not durability.
- 5,000 msgs covers a busy 50-day window at the disk projection below — well beyond the dashboard's "see who's active right now" use case.
- Ring is per-team, not global. A team going dormant doesn't bleed retention from active teams. Eviction is FIFO on `ts`.

### Disk usage projection

Hypothesis: 10 teammates × 100 msgs/day × 30 days = 30,000 msgs/team/month.

Per-message stored fields: `ts (8) + from (~16) + to (~16) + text_excerpt (240) + transcript_path (~120)` ≈ 400 bytes JSON.

| Retention | Per-team JSON | 5 active teams | Notes |
|---|---|---|---|
| Append-forever (mclaude) | ~12 MB/month, ~150 MB/year | 60 MB/mo, 750 MB/yr | Linear growth, no LRU. Reads paginate. |
| **5,000-msg ring (chosen)** | **~2 MB steady-state** | **10 MB total** | Stable footprint. |
| 1,000-msg ring | ~400 KB | 2 MB | Too tight; 1 day of busy team can drop yesterday. |

5,000 is the knee: ~50 days of busy-team coverage, 2 MB ceiling, well under the existing usage-cache footprint.

### Mitigations

- `text_excerpt` is capped at 240 chars on write (matches the existing tooltip preview cap in webview.html). Full body lives in transcript.jsonl. Frontend renders `text_excerpt` in the dashboard ribbon, links to transcript for full text.
- If a user wants forever-append later, add a `retention: "ring" | "append" | <int>` field per team in v2. Out of scope for Phase 1.

### Final v1 store layout

Four on-disk stores total. No fifth audit log; transcript.jsonl is the canonical record and any team-level forensic query can be reconstructed post-hoc from it.

1. `~/.agents-viz/inbox/{team}/{teammate}/{ts}.json` — pending message slot, delete-on-consume (hook)
2. `~/.agents-viz/inbox/_dropped.log` — workspace-global TTL drop record (hook)
3. `~/.agents-viz/team-cache.json` `messages` block — 5,000-msg ring, 240-char excerpts (extension data layer)
4. `~/.claude/projects/.../transcript.jsonl` — Claude Code canonical full audit (read-only)

---

## 3. Team lifecycle states

**Decision: 5 states — `init` → `active` → `idle` → `archived` → `deleted`. State derived from `config.json` mtime + tasks activity, never user-editable from the panel.**

State is a **derived projection** computed when `team-cache.json` is updated; it is not stored in `~/.claude/teams/`. We never write to Claude Code's own state.

| State | Trigger | Data shown | Hooks active | User actions |
|---|---|---|---|---|
| `init` | `config.json` exists, no SessionStart events from any teammate yet | Roster only, "spawning..." badge, no message ribbon | None (no teammates running) | View roster, cancel-spawn (kills the TeamCreate via OS signal — Phase 2 only) |
| `active` | At least one teammate's SessionStart in last 60 min, or at least one in-flight task | Full: roster, message ribbon (last 50), task list, per-teammate spend | All 3 (TeammateIdle / TaskCreated / TaskCompleted) consumed for badge updates | View roster, view tasks, view messages, send reply (via §4 mechanism) |
| `idle` | No teammate activity for ≥ 60 min AND ≥ 1 in-flight task remains | Same as active but visually dimmed (matches existing 1h sofa convention) | TaskCompleted still consumed (idle teammate may finish work) | All active actions; "wake up" sends a SendMessage via reply mechanism |
| `archived` | No activity for ≥ 24 h AND no in-flight tasks | Roster + final task summary + last 10 messages collapsed | None consumed (we ignore late events from archived teams to avoid resurrection thrash) | View only; "unarchive" forces back to active for 1h |
| `deleted` | `config.json` removed from disk | Tombstone row, "deleted YYYY-MM-DD" | None | Hide from view; manual purge from `team-cache.json` after 7 days |

### Why these specific thresholds

- 60 min idle and 24 h archive **reuse the existing `STALE_MS` and `LONG_STALE_MS` constants** in webview.html. One vocabulary, one convention.
- `init` is a real state, not a transient — TeamCreate spawn can take 10+ seconds across many teammates. Distinguishing "spawning" from "active but quiet" prevents false-empty UIs.
- `deleted` retains a tombstone for 7 days so the user can scroll back through the heatmap and see "yes, this team existed last week". After 7 days, GC.

### Out of scope

Manual user transitions (e.g., "force this team to archived"). Lifecycle is derived. If the user wants a team gone, they delete the `~/.claude/teams/{name}/` dir or the team-cache entry — we never offer panel buttons that mutate Claude Code's own state.

---

## 4. Bidirectional reply mechanism

**Decision: confirm P2 — file inbox + `UserPromptSubmit` hook. Phase 3 proxy teammate deferred. tmux send-keys rejected (Windows-unfriendly, see CLAUDE.md cross-platform expectation).**

### Comparison

| Option | Latency | Reliability | Windows | Code surface | Coupling to Claude Code internals |
|---|---|---|---|---|---|
| **File inbox + UserPromptSubmit hook (P2, chosen)** | 0.5 – 2 s (hook polls on next user-turn boundary or via fs.watch) | Strong: hook is documented, file ownership is ours | Yes (forward slashes, no shell quoting issues) | ~120 LOC: writer in extension.ts, reader script in `~/.agents-viz/inbox-hook.js` | Low: hook config is the same surface we already own via `Configure Claude Code Hooks` |
| Proxy teammate (P3, deferred) | Sub-second (in-process SendMessage) | Medium: requires an always-on extra teammate per team — 3-4x token cost amplified | Yes | ~200 LOC + spawn-management UX | High: depends on TeamCreate inbound semantics that have shifted in Feb 2026 betas |
| HTTP send-keys to tmux | Sub-second | Brittle on Windows; tmux not standard | **No** (rejected) | ~60 LOC | Medium |

### Why P2 wins now

- Reuses the hook-configuration UX the user already invokes once (`Agents Viz: Configure Claude Code Hooks`). Zero extra setup.
- File inbox is `~/.agents-viz/inbox/{team}/{teammate}/{ts}.json` — namespace already ours.
- Failure mode is failure-soft: if the hook script errors, the teammate's session is unaffected (matches the silent-forwarder discipline in §3 of CLAUDE.md).
- It's the same architecture pattern as `hook-forwarder.js`. Hooks-devops will recognize the shape.

### Failure modes + mitigations

| Failure | Mitigation |
|---|---|
| Hook fires but inbox file is mid-write (partial JSON) | Atomic write: write to `*.tmp` then rename. Hook reads only complete `.json` files. |
| Teammate is mid-task and ignores the prompt for minutes | Inbox messages have `ttl_ms` (default 5 min). Hook drops expired messages with a warning written to `~/.agents-viz/inbox/_dropped.log`. |
| User sends 50 messages while teammate is running | Hook concatenates pending messages with `--- next message ---` separators on next prompt boundary. Caps at 10 messages per concat (configurable). |
| Teammate session crashed; messages pile up | Lifecycle state goes to `idle` then `archived`. Inbox dir for archived teams is GC'd after 7 days. |
| Two extension instances both writing to inbox | File-locking via O_EXCL on the tmp file (matches Claude Code's own task-list locking pattern per memory facts §"On-disk state"). |

### Why P3 is deferred, not killed

Proxy teammate is the right shape for sub-second bidirectional UX, but: (a) the inbound-message API (anthropics/claude-code#27441) is still open as of 2026-04, (b) the cost amplification is real (3-4x base team cost per extra teammate), and (c) we do not have user demand for sub-second replies in a *dashboard*. Park behind feature-flag, revisit when #27441 closes or a user complains about 1-2 s latency.

---

## 5. Roadmap

- **Phase 1 (immediate, ships with first teams release)**: full read + reply — roster, tasks, messages, lifecycle states, per-teammate spend, **plus reply composer modal** wired to the §4 file-inbox path. Architect implements §1+§2; hooks-devops implements §4 reader hook; frontend implements panel rows + composer modal. (Override 2026-05-01: user's verbatim ask was reply-first — "agents-viz上进行对指定agent的消息查看的回复" — so the reply composer is the headline feature, not a Phase 2 follow-up.)
- **Phase 2 (next milestone)**: polish + persistence hardening — fault-injection test coverage, lifecycle GC, multi-extension-instance race hardening. (Per-team forensic audit log deferred indefinitely behind real user demand; transcript.jsonl post-hoc aggregation suffices for now.)
- **Phase 3 (deferred, gated on community signal)**: proxy teammate for sub-second bidirectional UX. Behind a `agentsViz.experimentalProxyTeammate` setting; default off.

---

## Appendix — invariants to test

QA must verify:

1. **No message loss across restart**: send N messages, kill extension host, restart → all N visible in panel.
2. **Ring buffer FIFO**: write 5,001st message → 1st is gone, 2nd onward intact.
3. **Lifecycle transitions are monotonic forward**: `init → active` and `active → idle → archived` happen automatically; reverse only via explicit user "unarchive" or new activity.
4. **Inbox atomic writes**: mid-write crash leaves no partial file readable to the hook.
5. **TTL drops happen**: message older than `ttl_ms` is logged and skipped, not silently delivered late.
6. **Cache version mismatch wipes file**: bump `version` field, restart → cache rebuilt, no stale entries leaked.
