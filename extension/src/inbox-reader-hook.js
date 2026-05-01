#!/usr/bin/env node
// Agents Viz inbox reader hook (UserPromptSubmit).
//
// Bidirectional reply path for Claude Code Teams. External tools (VS Code panel,
// scripts, agents-viz UI) atomically write per-message JSON files into
// ~/.agents-viz/inbox/{team}/{teammate}/{ts}.json — using *.tmp + rename(). On
// the next UserPromptSubmit fired by that teammate, this hook concatenates up to
// 10 oldest non-expired messages (FIFO delivery order), prepends them to the
// prompt as system notes, then deletes the consumed inbox files. Anything beyond
// the 10-msg cap stays on disk for the next prompt boundary — no message loss.
//
// Per TEAMS_DECISIONS.md §2: we are a dashboard, not an audit tool. Canonical
// audit is Claude Code's own ~/.claude/projects/.../transcript.jsonl (read-only
// to us). We deliberately do NOT mirror delivered messages into a parallel log.
//
// Two on-disk stores owned by this hook:
//   1. inbox/{team}/{teammate}/*.json — pending message slots (delete-on-consume)
//   2. inbox/_dropped.log             — workspace-global TTL drop record only
//                                       (NOT a delivery audit)
// (team-cache.json — owned by extension.ts, not this hook — is a separate store:
//  240-char-excerpt 5,000-msg ring for the dashboard UI ribbon. See §2.)
//
// Why files: Claude Code Teams has no public inbound message-injection API
// (anthropics/claude-code#27441). UserPromptSubmit hook + file inbox is the
// always-works fallback channel.
//
// Locked protocol (TEAMS_DECISIONS.md §4, accepted 2026-04-30):
//
//   ~/.agents-viz/inbox/{team}/{teammate}/{ts}.json   per-message file
//                                       /{ts}.tmp     in-flight write (we MUST skip)
//   ~/.agents-viz/inbox/_dropped.log                  workspace-global TTL drop log
//
// Message shape:
//   { from: "user|architect|...", to: "{teammate-name}", ts: 1745000000000,
//     body: "...", kind: "REQUEST|ANSWER|NOTE", ttl_ms?: 300000 }
//
// Failure-soft contract: any error here is silently swallowed and the teammate's
// session proceeds with no injection. Hook errors must NEVER block the session.
//
// Hard exit deadline: 1.5 s (well below Claude Code's 2 s hook kill).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// Test-mode overrides (qa-auditor harness). Off by default; production path unchanged.
//   NODE_ENV=test                        skip the 1.5 s deadline so debugger can step
//   AGENTS_VIZ_INBOX_ROOT=/tmp/x         override inbox root for ephemeral test dirs
//   AGENTS_VIZ_HOOK_DEBUG=1              reserved — debug is currently unconditional
//                                        during UAT; once gated this re-enables it
const TEST_MODE = process.env.NODE_ENV === 'test';

const DEADLINE_MS = 1500;
if (!TEST_MODE) setTimeout(() => process.exit(0), DEADLINE_MS);

const INBOX_ROOT = process.env.AGENTS_VIZ_INBOX_ROOT
  ? path.resolve(process.env.AGENTS_VIZ_INBOX_ROOT)
  : path.join(os.homedir(), '.agents-viz', 'inbox');
const DROPPED_LOG = path.join(INBOX_ROOT, '_dropped.log');
const DEFAULT_TTL_MS = 5 * 60 * 1000;   // 5 min
const MAX_CONCAT = 10;                  // cap per prompt boundary
const SEPARATOR = '\n--- next message ---\n';

// Debug log follows INBOX_ROOT's parent so tests scoped to /tmp/x stay
// self-contained and don't leak lines into ~/.agents-viz/.
const DEBUG_LOG = path.join(path.dirname(INBOX_ROOT), 'inbox-reader-debug.log');
function debugLog(msg) {
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    fs.appendFileSync(DEBUG_LOG, new Date().toISOString() + ' pid=' + process.pid + ' ' + msg + '\n');
  } catch {}
}

function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function safeUnlink(p) { try { fs.unlinkSync(p); } catch {} }

/** Identify the current teammate from CLAUDE_CODE_TEAM_NAME / CLAUDE_CODE_TEAMMATE_NAME
 *  env vars (set by the Teams runtime), payload fields, or by walking
 *  ~/.claude/teams/ {team}/config.json for the running session_id. */
function resolveTeamAndMember(parsed) {
  const team = process.env.CLAUDE_CODE_TEAM_NAME || parsed.team_name || null;
  const member = process.env.CLAUDE_CODE_TEAMMATE_NAME || parsed.teammate_name || null;
  if (team && member) return { team, member };

  const sessionId = parsed.session_id;
  if (!sessionId) return { team: null, member: null };
  const teamsDir = path.join(os.homedir(), '.claude', 'teams');
  let teamDirs;
  try { teamDirs = fs.readdirSync(teamsDir, { withFileTypes: true }).filter(e => e.isDirectory()); }
  catch { return { team: null, member: null }; }
  for (const td of teamDirs) {
    const raw = safeRead(path.join(teamsDir, td.name, 'config.json'));
    if (!raw) continue;
    let cfg; try { cfg = JSON.parse(raw); } catch { continue; }
    for (const m of cfg.members || []) {
      const sids = m.session_ids || (m.session_id ? [m.session_id] : []);
      if (sids.includes(sessionId)) return { team: td.name, member: m.name || null };
    }
  }
  return { team: null, member: null };
}

/** Render one message as a system note. */
function renderInjection(msg) {
  const kind = (msg.kind || 'NOTE').toUpperCase();
  const from = msg.from || 'unknown';
  const tsIso = msg.ts ? new Date(msg.ts).toISOString() : new Date().toISOString();
  const body = msg.body || '';
  return `[INBOX ${kind} from ${from} at ${tsIso}]\n${body}`;
}

/** Append a TTL-drop record to the workspace-global _dropped.log. */
function logDropped(team, member, file, msg, reason) {
  try {
    fs.mkdirSync(INBOX_ROOT, { recursive: true });
    const ts = new Date().toISOString();
    const preview = String(msg && msg.body || '').replace(/\s+/g, ' ').slice(0, 80);
    const line = `${ts} team=${team} to=${member} file=${path.basename(file)} reason=${reason} from=${msg && msg.from || '?'} | ${preview}\n`;
    fs.appendFileSync(DROPPED_LOG, line);
  } catch (e) { debugLog('dropped-log append failed: ' + e.message); }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  let parsed;
  try { parsed = JSON.parse(input); } catch { process.exit(0); }

  const { team, member } = resolveTeamAndMember(parsed);
  if (!team || !member) {
    debugLog('not a teammate session (team=' + team + ' member=' + member + '), skip');
    process.exit(0);
  }

  const memberDir = path.join(INBOX_ROOT, team, member);

  let entries;
  try { entries = fs.readdirSync(memberDir); }
  catch { process.exit(0); }   // no dir = no inbox; common silent path

  // Per protocol §4: hook reads ONLY *.json. *.tmp is in-flight writer state.
  const messageFiles = entries.filter(f => f.endsWith('.json'));
  if (messageFiles.length === 0) process.exit(0);

  const now = Date.now();

  // Read + classify every candidate first. Sort by effective-ts ascending so
  // concat order is delivery-order. We pick the OLDEST 10; any beyond the cap
  // stay on disk for the next prompt boundary (FIFO, no message loss).
  // effective ts = msg.ts if writer set one, else file mtime as fallback —
  // protects against writers that omit `ts` (otherwise such messages would
  // never age, never sort correctly, and break TTL).
  const candidates = [];
  for (const f of messageFiles) {
    const full = path.join(memberDir, f);
    const raw = safeRead(full);
    if (raw === null) continue;       // file vanished mid-walk; skip silently
    let msg;
    try { msg = JSON.parse(raw); }
    catch (e) {
      // Malformed — drop it so it doesn't block the queue forever.
      debugLog('malformed JSON, dropping: ' + full + ' err=' + e.message);
      logDropped(team, member, full, { from: '?', body: raw.slice(0, 80) }, 'malformed_json');
      safeUnlink(full);
      continue;
    }
    let effectiveTs = (typeof msg.ts === 'number' && msg.ts > 0) ? msg.ts : 0;
    if (!effectiveTs) {
      try { effectiveTs = fs.statSync(full).mtimeMs; } catch { effectiveTs = now; }
    }
    candidates.push({ file: full, msg, effectiveTs });
  }
  if (candidates.length === 0) process.exit(0);

  candidates.sort((a, b) => a.effectiveTs - b.effectiveTs);

  const fresh = [];
  for (const c of candidates) {
    const ttl = (typeof c.msg.ttl_ms === 'number' && c.msg.ttl_ms > 0) ? c.msg.ttl_ms : DEFAULT_TTL_MS;
    if ((now - c.effectiveTs) > ttl) {
      logDropped(team, member, c.file, c.msg, 'ttl_expired');
      safeUnlink(c.file);
      continue;
    }
    fresh.push(c);
  }
  if (fresh.length === 0) process.exit(0);

  const toDeliver = fresh.slice(0, MAX_CONCAT);

  const rendered = toDeliver.map(c => renderInjection(c.msg)).join(SEPARATOR);
  const injection = rendered + '\n\n---\n\n';
  process.stdout.write(injection);

  // Per §2: transcript.jsonl is the canonical audit. Delete consumed inbox files;
  // we do NOT mirror to a parallel log.
  for (const c of toDeliver) safeUnlink(c.file);

  debugLog('injected ' + toDeliver.length + '/' + fresh.length + ' msgs (' + injection.length + ' bytes), '
    + (fresh.length - toDeliver.length) + ' deferred');
  process.exit(0);
});
