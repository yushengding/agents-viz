import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as child_process from 'child_process';
import { buildWebviewHtml, webviewHtmlPath } from './webview';

/** Move a file to the OS recycle bin (Windows only; falls back to unlink elsewhere). */
function sendToRecycleBin(filePath: string): boolean {
    if (!fs.existsSync(filePath)) return false;
    if (process.platform === 'win32') {
        // Use PowerShell + VB FileSystem API to route through Windows recycle bin
        const psCmd =
            `Add-Type -AssemblyName Microsoft.VisualBasic; ` +
            `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(` +
            `'${filePath.replace(/'/g, "''")}', ` +
            `'OnlyErrorDialogs', 'SendToRecycleBin')`;
        try {
            child_process.execFileSync('powershell', ['-NoProfile', '-Command', psCmd], { stdio: 'ignore' });
            return !fs.existsSync(filePath);
        } catch { return false; }
    }
    // Non-Windows: regular unlink as fallback
    try { fs.unlinkSync(filePath); return true; } catch { return false; }
}

const DISCOVERY_DIR = path.join(os.homedir(), '.agents-viz');
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK_EVENTS = [
    // Session-scoped — carry per-session cwd, routed by workspace match.
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'Stop',
    'Notification',
    // Team-scoped (Claude Code Teams Feb 2026 experimental). No cwd; the
    // forwarder broadcasts these to every alive panel. Architect's
    // handleHookEvent() dispatches by hook_event_name.
    'TeammateIdle',
    'TaskCreated',
    'TaskCompleted',
] as const;

let panel: vscode.WebviewPanel | undefined;
let server: http.Server | undefined;
let discoveryFile: string | undefined;
let authToken: string | undefined;
let eventBuffer: HookEvent[] = [];
const MAX_BUFFER = 5000;  // raised 1000→5000 so live event ring keeps ~hours of activity

// Dev hot-reload: poll dist/extension.js for changes, re-render webview HTML on save.
// Only covers webview (HTML/CSS/JS) — changes to activate()/handlers still need reload.
// NOTE: use fs.watchFile (polling) instead of fs.watch — on Windows, fs.watch over a
// directory junction often fires zero events. Polling at 500ms is negligible cost.
let hotReloadWatchedFile: string | undefined;
let hotReloadTimer: NodeJS.Timeout | undefined;
let hotReloadRebuild: (() => void) | undefined;

interface HookEvent {
    ts: number;
    hook_event_name?: string;
    session_id?: string;
    cwd?: string;
    tool_name?: string;
    tool_input?: any;
    tool_response?: any;
    prompt?: string;
    [k: string]: any;
}

// ─── Claude Code Teams (Feb 2026 experimental) state.
//     Schema mirrors `docs/TEAMS_DECISIONS.md` §1 (snake_case fields, derived
//     lifecycle/spend, message ring buffer). Persisted to
//     `~/.agents-viz/team-cache.json` keyed by (config_size, config_mtime),
//     same invalidation pattern as `usage-cache.json` (`scanFileWithCache`).
//     File layout for source-of-truth:
//       ~/.claude/teams/{team-name}/config.json   ← member roster
//       ~/.claude/tasks/{team-name}/*.json        ← one file per task
interface TeamMember {
    name: string;
    agent_id?: string;
    agent_type?: string;
    session_id?: string;
}
type LifecycleState = 'init' | 'active' | 'idle' | 'archived' | 'deleted';
interface TasksSummary {
    total: number;
    completed: number;
    in_progress: number;
    pending: number;
}
interface TeamTaskFull {
    id: string;
    subject: string;
    description?: string;
    status: 'pending' | 'in_progress' | 'completed';
    owner?: string;
    blockedBy?: string[];
    blocks?: string[];
    createdAt?: number;
    updatedAt?: number;
}
interface TeamEntry {
    config_size: number;
    config_mtime: number;
    members: TeamMember[];
    first_seen_ts: number;
    last_active_ts: number;
    lifecycle_state: LifecycleState;
    tasks_summary: TasksSummary;
    tasks: TeamTaskFull[];           // full bodies for kanban dependency rendering
    pending_inbox: Record<string, number>;   // teammate-name → count of pending inbox files
    deleted_at?: number;   // wall-clock when config.json went missing; tombstone GC after 7d
    inbox_gc_done?: boolean;   // set once we wipe ~/.agents-viz/inbox/{team}/ on archived/deleted-tombstone
}
interface TeamMessage {
    ts: number;
    from: string;
    to: string;
    text_excerpt: string;       // capped at TEXT_EXCERPT_MAX (240) on write
    transcript_path?: string;
}
interface TeamCache {
    version: number;
    teams: Record<string, TeamEntry>;
    messages: Record<string, TeamMessage[]>;  // ring buffer per team, FIFO
}
const TEAMS_DIR = path.join(os.homedir(), '.claude', 'teams');
const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks');
const INBOX_DIR = path.join(os.homedir(), '.agents-viz', 'inbox');
const TEAM_CACHE_FILE = path.join(os.homedir(), '.agents-viz', 'team-cache.json');
const TEAM_CACHE_VERSION = 4;     // bumps: v1→v2 added `tasks`+`pending_inbox`; v2→v3 added `inbox_gc_done`; v3→v4 purges phantom UUID-name entries that leaked in from misreading ~/.claude/tasks/* as teams
const TEXT_EXCERPT_MAX = 240;
const MSG_RING_PER_TEAM = 5000;
// Lifecycle thresholds. AGENTS_VIZ_LIFECYCLE_FAST_MS env override (in ms) shrinks
// BOTH stale and long-stale to ~1× and ~24× of that base — used by qa-auditor to
// run Race B / Inv 3 (lifecycle monotonic-forward) without 1h/24h waits.
function _lifecycleThresholds() {
    const fast = parseInt(process.env.AGENTS_VIZ_LIFECYCLE_FAST_MS || '', 10);
    if (Number.isFinite(fast) && fast > 0) {
        return { stale: fast, longStale: fast * 24, tombstone: fast * 168 };
    }
    return { stale: 60 * 60 * 1000, longStale: 24 * 60 * 60 * 1000, tombstone: 7 * 24 * 60 * 60 * 1000 };
}
const STALE_MS_TEAMS = _lifecycleThresholds().stale;
const LONG_STALE_MS_TEAMS = _lifecycleThresholds().longStale;
const TOMBSTONE_MS = _lifecycleThresholds().tombstone;
let teamsCache: TeamCache = { version: TEAM_CACHE_VERSION, teams: {}, messages: {} };
let teamsConfigWatcher: fs.FSWatcher | undefined;
let teamsTasksWatcher: fs.FSWatcher | undefined;
let teamsInboxWatcher: fs.FSWatcher | undefined;
let teamsRefreshTimer: NodeJS.Timeout | undefined;
let inboxRefreshTimer: NodeJS.Timeout | undefined;

let outputChannel: vscode.OutputChannel | undefined;
function log(msg: string) {
    const line = `[${new Date().toTimeString().slice(0, 8)}] ${msg}`;
    console.log(`[agents-viz] ${line}`);
    if (outputChannel) outputChannel.appendLine(line);
}

function workspaceHash(ws: string): string {
    return crypto.createHash('sha256').update(ws).digest('hex').slice(0, 16);
}

async function startHookServer(workspace: string): Promise<number> {
    return new Promise((resolve, reject) => {
        authToken = crypto.randomBytes(16).toString('hex');
        server = http.createServer((req, res) => {
            // Read-only debug + frontend read-back endpoint for the live teams state.
            // Returns the §1 TeamCache shape ({version, teams, messages}) verbatim.
            if (req.method === 'GET' && req.url === '/api/teams') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(teamsCache));
                return;
            }
            if (req.method !== 'POST' || req.url !== '/api/hooks/claude') {
                res.writeHead(404); res.end(); return;
            }
            const auth = req.headers['authorization'];
            if (auth !== `Bearer ${authToken}`) {
                // Auth optional — warn but accept for now (localhost-only)
            }
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    handleHookEvent(data);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end('{"ok":true}');
                } catch (e: any) {
                    res.writeHead(400); res.end(e.message);
                }
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server!.address();
            if (typeof addr === 'object' && addr) {
                resolve(addr.port);
            } else reject(new Error('no address'));
        });
        server.on('error', reject);
    });
}

// sessionId -> most recent resolved custom-title (read from transcript JSONL)
const sessionTitles = new Map<string, string>();

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const ROOMS_DIR = path.join(os.homedir(), '.agents-viz', 'rooms');

/** Hash a cwd to a safe filename stem (lowercase basename). */
function cwdToRoomKey(cwd: string): string {
    const base = path.basename(cwd).toLowerCase().replace(/[^a-z0-9._-]/g, '_');
    return base || 'root';
}

/** Scan ~/.agents-viz/rooms/ for PNG/JPG matching project basenames, embed as data URIs. */
function scanRoomImages(): Record<string, string> {
    const out: Record<string, string> = {};
    if (!fs.existsSync(ROOMS_DIR)) return out;
    let files: string[] = [];
    try { files = fs.readdirSync(ROOMS_DIR); } catch { return out; }
    for (const f of files) {
        const ext = path.extname(f).toLowerCase();
        if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) continue;
        const key = path.basename(f, ext).toLowerCase();
        try {
            const b = fs.readFileSync(path.join(ROOMS_DIR, f));
            const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
            out[key] = 'data:' + mime + ';base64,' + b.toString('base64');
        } catch {}
    }
    return out;
}

// Best-effort JSONL history replay when panel opens.
// JSONL events use a different schema from hook events; we synthesize PreToolUse/
// PostToolUse/UserPromptSubmit/Stop events so the existing timeline rendering works.
/** Enumerate matching session JSONL files under CLAUDE_PROJECTS_DIR, newest-first per project. */
function enumerateMatchingSessions(workspace: string, sessionsPerProject = 15): { sessionId: string; path: string; mtime: number }[] {
    const result: { sessionId: string; path: string; mtime: number }[] = [];
    if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return result;
    let projectDirs: string[] = [];
    try { projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR).map(d => path.join(CLAUDE_PROJECTS_DIR, d)); } catch { return result; }
    for (const dir of projectDirs) {
        let files: string[] = [];
        try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
        const ranked = files
            .map(f => ({ f, p: path.join(dir, f), m: (() => { try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch { return 0; } })() }))
            .sort((a, b) => b.m - a.m)
            .slice(0, sessionsPerProject);
        for (const entry of ranked) {
            result.push({ sessionId: path.basename(entry.f, '.jsonl'), path: entry.p, mtime: entry.m });
        }
    }
    // Across-all-projects: newest first so we stream most-relevant sessions first
    result.sort((a, b) => b.mtime - a.mtime);
    return result;
}

/** Synchronous batched scan (back-compat). Uses parseSessionJsonl → benefits from caching. */
function scanJsonlHistory(workspace: string, perSessionLimit = 150, sessionsPerProject = 15): HookEvent[] {
    const wsNorm = (process.platform === 'win32' ? workspace.toLowerCase() : workspace).replace(/\\/g, '/');
    const out: HookEvent[] = [];
    const stats = { filesChecked: 0, sessionsMatched: 0, eventsEmitted: 0 };
    for (const entry of enumerateMatchingSessions(workspace, sessionsPerProject)) {
        stats.filesChecked++;
        const events = parseSessionJsonl(entry.sessionId);
        if (!events || events.length === 0) continue;
        const cwd = events[0].cwd;
        if (!cwd) continue;
        const cwdNorm = (process.platform === 'win32' ? cwd.toLowerCase() : cwd).replace(/\\/g, '/');
        // Accept: cwd === ws, cwd is descendant of ws, OR ws is descendant of cwd
        // (last case: Claude session was opened from a parent dir like ~/Desktop/projects
        //  but touches files inside ws; webview file-op voting routes per-session, so
        //  letting parent-cwd sessions through here lets that routing work.)
        if (cwdNorm !== wsNorm
            && !cwdNorm.startsWith(wsNorm + '/')
            && !wsNorm.startsWith(cwdNorm + '/')) continue;
        stats.sessionsMatched++;
        const slice = events.slice(-perSessionLimit);
        stats.eventsEmitted += slice.length;
        for (const e of slice) out.push(e);
    }
    out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    log(`scan: ws=${workspace} | files=${stats.filesChecked} sessions_matched=${stats.sessionsMatched} events=${stats.eventsEmitted}`);
    return out;
}

/** Progressive streaming scan — invokes onBatch(events) once per matching session.
 *  Uses setImmediate between files so the extension host stays responsive. */
function scanJsonlHistoryProgressive(
    workspace: string,
    perSessionLimit: number,
    sessionsPerProject: number,
    onBatch: (events: HookEvent[], sessionId: string) => void,
    onDone: () => void,
): void {
    const wsNorm = (process.platform === 'win32' ? workspace.toLowerCase() : workspace).replace(/\\/g, '/');
    const entries = enumerateMatchingSessions(workspace, sessionsPerProject);
    let i = 0;
    const tick = () => {
        if (i >= entries.length) { onDone(); return; }
        const e = entries[i++];
        try {
            const events = parseSessionJsonl(e.sessionId);
            if (events && events.length > 0) {
                const cwd = events[0].cwd;
                const cwdNorm = cwd ? (process.platform === 'win32' ? cwd.toLowerCase() : cwd).replace(/\\/g, '/') : '';
                if (cwdNorm && (cwdNorm === wsNorm
                                || cwdNorm.startsWith(wsNorm + '/')
                                || wsNorm.startsWith(cwdNorm + '/'))) {
                    onBatch(events.slice(-perSessionLimit), e.sessionId);
                }
            }
        } catch (err: any) { log(`stream parse ${e.sessionId} failed: ${err.message}`); }
        setImmediate(tick);
    };
    setImmediate(tick);
}

/** In-memory cache for parsed session events (reset each panel session). */
const sessionEventCache = new Map<string, { events: HookEvent[]; touchedAt: number; fileMtime: number }>();

/** On-disk cache directory — persists across panel reloads so the FIRST open after
 *  restart doesn't have to reparse huge JSONLs. */
const CACHE_DIR = path.join(os.homedir(), '.agents-viz', 'cache');
function cachePath(sessionId: string): string { return path.join(CACHE_DIR, sessionId + '.json'); }

// Bump when parser semantics change so stale caches get invalidated automatically.
// v=2 (2026-04-27): tool_result parts inside user messages now emit PostToolUse;
// older caches had 0 PostToolUse and silently broke tool-duration metrics.
const PARSE_CACHE_VERSION = 2;
function readDiskCache(sessionId: string, expectedMtime: number): HookEvent[] | null {
    try {
        const p = cachePath(sessionId);
        if (!fs.existsSync(p)) return null;
        const c = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!c || c.mtime !== expectedMtime || c.v !== PARSE_CACHE_VERSION || !Array.isArray(c.events)) return null;
        return c.events as HookEvent[];
    } catch { return null; }
}
function writeDiskCache(sessionId: string, mtime: number, events: HookEvent[]): void {
    try {
        if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(cachePath(sessionId), JSON.stringify({ v: PARSE_CACHE_VERSION, mtime, events }));
    } catch (e: any) { log(`cache write failed for ${sessionId}: ${e.message}`); }
}

function parseSessionJsonl(sessionId: string): HookEvent[] | null {
    // Cache hit? (invalidate if JSONL file changed on disk)
    const cached = sessionEventCache.get(sessionId);
    let jsonlPath: string | undefined;
    if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return null;
    try {
        const pdirs = fs.readdirSync(CLAUDE_PROJECTS_DIR);
        for (const pd of pdirs) {
            const c = path.join(CLAUDE_PROJECTS_DIR, pd, sessionId + '.jsonl');
            if (fs.existsSync(c)) { jsonlPath = c; break; }
        }
    } catch { return null; }
    if (!jsonlPath) return null;
    let mtime = 0;
    try { mtime = fs.statSync(jsonlPath).mtimeMs; } catch {}
    // For RECENTLY-MODIFIED JSONLs (last 2 min) — session is probably still being written.
    // Don't trust any cache; always re-parse so we don't miss events flushed between cache-write
    // and now. For older/settled sessions, cache is safe.
    const RECENT_MS = 2 * 60 * 1000;
    const isRecent = Date.now() - mtime < RECENT_MS;
    if (!isRecent && cached && cached.fileMtime === mtime) {
        cached.touchedAt = Date.now();
        return cached.events;
    }
    if (!isRecent) {
        // On-disk cache (persists across panel restarts)
        const disk = readDiskCache(sessionId, mtime);
        if (disk) {
            sessionEventCache.set(sessionId, { events: disk, touchedAt: Date.now(), fileMtime: mtime });
            return disk;
        }
    }
    // For huge JSONLs (>5MB) — read only the tail. perSessionLimit caps replay to last 500 events,
    // so reading the entire 65MB file just to slice the last 500 is wasteful AND blocks the event
    // loop for several seconds (which delays subsequent session replays so the strip never fills
    // for active sessions). Tail read keeps active-session replay snappy.
    let raw: string;
    let fileSize = 0;
    try { fileSize = fs.statSync(jsonlPath).size; } catch {}
    const TAIL_THRESHOLD = 5 * 1024 * 1024;
    const TAIL_BYTES = 4 * 1024 * 1024;
    try {
        if (fileSize > TAIL_THRESHOLD) {
            const fd = fs.openSync(jsonlPath, 'r');
            try {
                const buf = Buffer.allocUnsafe(TAIL_BYTES);
                const start = fileSize - TAIL_BYTES;
                fs.readSync(fd, buf, 0, TAIL_BYTES, start);
                raw = buf.toString('utf8');
                // Drop the partial first line (we started mid-line)
                const nl = raw.indexOf('\n');
                if (nl >= 0) raw = raw.slice(nl + 1);
            } finally { fs.closeSync(fd); }
        } else {
            raw = fs.readFileSync(jsonlPath, 'utf8');
        }
    } catch { return null; }
    const lines = raw.split('\n');
    let title: string | undefined;
    let cwd: string | undefined;
    const all: HookEvent[] = [];
    for (const line of lines) {
        if (!line) continue;
        // Fast pre-filter: only attempt JSON.parse for lines that look relevant to events we emit
        const hasTs = line.indexOf('"timestamp"') !== -1;
        const hasTitle = line.indexOf('custom-title') !== -1;
        const hasCwd = line.indexOf('"cwd"') !== -1;
        if (!hasTs && !hasTitle && !hasCwd) continue;
        let j: any;
        try { j = JSON.parse(line); } catch { continue; }
        if (j?.type === 'custom-title' && j.customTitle) title = j.customTitle;
        if (j?.cwd) cwd = j.cwd;
        const ts = j.timestamp ? new Date(j.timestamp).getTime() : 0;
        if (!ts) continue;
        const base: HookEvent = { session_id: sessionId, cwd, session_title: title, ts, historical: true };
        if (j.type === 'user' && j.message?.content) {
            const c = j.message.content;
            const promptText = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((x: any) => x.type === 'text')?.text || '') : '';
            if (promptText && promptText.length > 0 && !promptText.startsWith('<')) {
                all.push({ ...base, hook_event_name: 'UserPromptSubmit', prompt: promptText });
            }
            // tool_result parts arrive INSIDE user messages (Claude Code wraps the
            // tool execution result as a user-role message before the model sees it).
            // Without iterating these, historical replay produces 0 PostToolUse events
            // and any "tool duration" metric is silently broken.
            if (Array.isArray(c)) {
                for (const part of c) {
                    if (part?.type === 'tool_result') {
                        all.push({ ...base, hook_event_name: 'PostToolUse', tool_name: '', tool_use_id: part.tool_use_id });
                    }
                }
            }
        } else if (j.message?.content && Array.isArray(j.message.content)) {
            for (const part of j.message.content) {
                if (part.type === 'tool_use') {
                    all.push({ ...base, hook_event_name: 'PreToolUse', tool_name: part.name, tool_input: part.input, tool_use_id: part.id });
                } else if (part.type === 'tool_result') {
                    all.push({ ...base, hook_event_name: 'PostToolUse', tool_name: '', tool_use_id: part.tool_use_id });
                }
            }
        }
    }
    all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    sessionEventCache.set(sessionId, { events: all, touchedAt: Date.now(), fileMtime: mtime });
    // Persist to disk so next panel open skips the reparse (only for sessions large enough to matter)
    if (all.length > 30) writeDiskCache(sessionId, mtime, all);
    // Evict stale cache entries (touched > 5min ago)
    const evictBefore = Date.now() - 5 * 60_000;
    for (const [k, v] of sessionEventCache.entries()) {
        if (v.touchedAt < evictBefore) sessionEventCache.delete(k);
    }
    return all;
}

/** Load older events for a specific session (used by timeline scroll-up pagination). */
function loadMoreSessionHistory(sessionId: string, beforeTs: number, limit: number): HookEvent[] {
    const all = parseSessionJsonl(sessionId);
    if (!all) return [];
    // Binary-search for the cutoff to avoid O(n) filter on large sessions
    let lo = 0, hi = all.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if ((all[mid].ts || 0) < beforeTs) lo = mid + 1;
        else hi = mid;
    }
    // all[0..lo) is the events with ts < beforeTs; return the most recent `limit`
    const start = Math.max(0, lo - limit);
    return all.slice(start, lo);
}

// Token/cost accounting per session. Pricing per 1M tokens, April 2026 (official Anthropic docs).
// NOTE: this computes the API-equivalent cost. Claude Max/Pro subscribers pay a flat
// subscription fee regardless of per-token usage — this number is a reference, not a bill.
const MODEL_PRICING: Record<string, { in: number; out: number; cwrite5m: number; cwrite1h: number; cread: number }> = {
    // Opus 4.7 was repriced 3× cheaper vs 4.x (Apr 2026): $5 input / $25 output
    'claude-opus-4-7':           { in:  5, out: 25, cwrite5m:  6.25, cwrite1h: 10, cread: 0.50 },
    'claude-opus-4-7[1m]':       { in:  5, out: 25, cwrite5m:  6.25, cwrite1h: 10, cread: 0.50 },
    // Older Opus 4.x stayed on legacy pricing
    'claude-opus-4-6':           { in: 15, out: 75, cwrite5m: 18.75, cwrite1h: 30, cread: 1.50 },
    'claude-sonnet-4-6':         { in:  3, out: 15, cwrite5m:  3.75, cwrite1h:  6, cread: 0.30 },
    'claude-sonnet-4-5':         { in:  3, out: 15, cwrite5m:  3.75, cwrite1h:  6, cread: 0.30 },
    'claude-haiku-4-5':          { in:  1, out:  5, cwrite5m:  1.25, cwrite1h:  2, cread: 0.10 },
    'claude-haiku-4-5-20251001': { in:  1, out:  5, cwrite5m:  1.25, cwrite1h:  2, cread: 0.10 },
};
function priceFor(model: string) {
    if (MODEL_PRICING[model]) return MODEL_PRICING[model];
    // Fallback heuristics by model family keyword
    if (/opus/i.test(model))   return MODEL_PRICING['claude-opus-4-7'];
    if (/sonnet/i.test(model)) return MODEL_PRICING['claude-sonnet-4-6'];
    if (/haiku/i.test(model))  return MODEL_PRICING['claude-haiku-4-5'];
    return MODEL_PRICING['claude-sonnet-4-6']; // conservative default
}

export interface SessionUsage {
    input: number;
    output: number;
    cacheCreate: number;
    cacheRead: number;
    cost: number;      // USD
    models: string[];  // distinct models seen
    msgCount: number;  // assistant message count
}

interface PromptCost {
    sessionId: string;
    promptText: string;       // truncated 220 chars
    promptTs: number;
    cost: number;
    tokens: number;
    cwd?: string;
}

// ─── Per-file cache for usage + prompt-cost aggregation. Keyed by file path,
//     invalidated when (size, mtime) change. Persisted to ~/.agents-viz/.
interface FileCacheEntry {
    size: number;
    mtime: number;
    sessionId: string;
    cwd: string;
    usage: SessionUsage;
    prompts: PromptCost[];
}
const USAGE_CACHE_FILE = path.join(os.homedir(), '.agents-viz', 'usage-cache.json');
// Bump when the cost formula (MODEL_PRICING table or 1h/5m cache split) changes
// so existing on-disk entries get discarded instead of carrying stale dollar values.
const CACHE_VERSION = 2;
interface CacheFile { __version: number; entries: Record<string, FileCacheEntry>; }
let _usageCache: Record<string, FileCacheEntry> | null = null;
function getUsageCache(): Record<string, FileCacheEntry> {
    if (_usageCache) return _usageCache;
    try {
        const raw = fs.readFileSync(USAGE_CACHE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        // v2+ format: { __version, entries }. Older flat-Record format is discarded.
        if (parsed && typeof parsed === 'object' && parsed.__version === CACHE_VERSION) {
            _usageCache = parsed.entries || {};
        } else {
            log(`usage cache version mismatch (have ${parsed?.__version ?? 'flat'}, want ${CACHE_VERSION}) — discarding`);
            _usageCache = {};
        }
    } catch { _usageCache = {}; }
    return _usageCache!;
}
function saveUsageCache(): void {
    if (!_usageCache) return;
    try {
        fs.mkdirSync(path.dirname(USAGE_CACHE_FILE), { recursive: true });
        const wrapped: CacheFile = { __version: CACHE_VERSION, entries: _usageCache };
        fs.writeFileSync(USAGE_CACHE_FILE, JSON.stringify(wrapped));
    } catch (e) { log(`save usage cache failed: ${(e as any).message}`); }
}

/** Aggregate USAGE + PROMPT-COSTS for one JSONL file. Result is cached on disk by
 *  (path, size, mtime); unchanged files return the cached entry without reading. */
function scanFileWithCache(file: string, size: number, mtime: number): FileCacheEntry | null {
    const cache = getUsageCache();
    const cached = cache[file];
    if (cached && cached.size === size && cached.mtime === mtime) return cached;

    let raw: string;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
    const lines = raw.split('\n');
    const fileBase = path.basename(file, '.jsonl');
    let sessionId = fileBase;
    let cwd = '';
    if (fileBase.startsWith('agent-')) {
        for (const line of lines) {
            if (line.indexOf('"sessionId"') === -1) continue;
            try { const j = JSON.parse(line); if (j?.sessionId) { sessionId = j.sessionId; break; } } catch {}
        }
    }
    for (const line of lines) {
        if (line.indexOf('"cwd"') === -1) continue;
        try { const j = JSON.parse(line); if (j?.cwd) { cwd = j.cwd; break; } } catch {}
    }
    if (!cwd) return null;

    const usage: SessionUsage = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, models: [], msgCount: 0 };
    const modelSet = new Set<string>();
    const prompts: PromptCost[] = [];
    let cur: PromptCost | null = null;
    for (const line of lines) {
        if (!line) continue;
        if (line.indexOf('"type":"user"') === -1 && line.indexOf('"type":"assistant"') === -1) continue;
        let j: any;
        try { j = JSON.parse(line); } catch { continue; }
        const ts = j.timestamp ? new Date(j.timestamp).getTime() : 0;
        if (j.type === 'user' && j.message?.content) {
            const c = j.message.content;
            const txt = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((x: any) => x.type === 'text')?.text || '') : '';
            if (!txt || txt.startsWith('<')) continue;
            if (cur) prompts.push(cur);
            cur = { sessionId, promptText: txt.slice(0, 220), promptTs: ts, cost: 0, tokens: 0, cwd };
        } else if (j.type === 'assistant') {
            const u = j.message?.usage; if (!u) continue;
            const model = j.message?.model || 'unknown';
            if (model !== '<synthetic>') modelSet.add(model);
            usage.msgCount++;
            const inp = u.input_tokens || 0, outp = u.output_tokens || 0;
            const cc = u.cache_creation_input_tokens || 0, cr = u.cache_read_input_tokens || 0;
            const ccBd = u.cache_creation || {};
            const cc1h = ccBd.ephemeral_1h_input_tokens || 0, cc5m = ccBd.ephemeral_5m_input_tokens || 0;
            const cc5m_eff = (cc1h + cc5m > 0) ? cc5m : cc;
            const cc1h_eff = (cc1h + cc5m > 0) ? cc1h : 0;
            const pr = priceFor(model);
            const lineCost = (inp * pr.in + outp * pr.out + cc5m_eff * pr.cwrite5m + cc1h_eff * pr.cwrite1h + cr * pr.cread) / 1_000_000;
            usage.input += inp; usage.output += outp; usage.cacheCreate += cc; usage.cacheRead += cr;
            usage.cost += lineCost;
            if (cur) { cur.cost += lineCost; cur.tokens += inp + outp + cc + cr; }
        }
    }
    if (cur) prompts.push(cur);
    usage.models = Array.from(modelSet);
    const entry: FileCacheEntry = { size, mtime, sessionId, cwd, usage, prompts };
    cache[file] = entry;
    return entry;
}

/** Walk all JSONLs and produce per-user-prompt cost. Each user prompt is followed
 *  by N assistant messages (and tool uses) until the next user prompt — those
 *  assistant messages' usage cost is attributed to that prompt. */
function scanCachedAll(workspace: string, sessionsPerProject = 50): { usage: Map<string, SessionUsage>, prompts: PromptCost[] } {
    const wsNorm = (process.platform === 'win32' ? workspace.toLowerCase() : workspace).replace(/\\/g, '/');
    const usage = new Map<string, SessionUsage>();
    const allPrompts: PromptCost[] = [];
    if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return { usage, prompts: allPrompts };
    let projectDirs: string[] = [];
    try { projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR).map(d => path.join(CLAUDE_PROJECTS_DIR, d)); } catch { return { usage, prompts: allPrompts }; }
    const collectJsonl = (root: string, depth = 0): { p: string, m: number, size: number }[] => {
        if (depth > 3) return [];
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
        const acc: { p: string, m: number, size: number }[] = [];
        for (const e of entries) {
            const full = path.join(root, e.name);
            if (e.isDirectory()) acc.push(...collectJsonl(full, depth + 1));
            else if (e.name.endsWith('.jsonl')) {
                try { const st = fs.statSync(full); acc.push({ p: full, m: st.mtimeMs, size: st.size }); } catch {}
            }
        }
        return acc;
    };
    let scanned = 0, cacheHits = 0, parsed = 0;
    const startMs = Date.now();
    const HARD_DEADLINE_MS = 8000;  // generous — first scan can take a while; later runs hit cache
    for (const dir of projectDirs) {
        if (Date.now() - startMs > HARD_DEADLINE_MS) break;
        const files = collectJsonl(dir).sort((a, b) => b.m - a.m).slice(0, sessionsPerProject);
        for (const fe of files) {
            if (Date.now() - startMs > HARD_DEADLINE_MS) break;
            scanned++;
            const cached = getUsageCache()[fe.p];
            const wasCached = cached && cached.size === fe.size && cached.mtime === fe.m;
            const entry = scanFileWithCache(fe.p, fe.size, fe.m);
            if (!entry) continue;
            if (wasCached) cacheHits++; else parsed++;
            const cwdNorm = (process.platform === 'win32' ? entry.cwd.toLowerCase() : entry.cwd).replace(/\\/g, '/');
            if (cwdNorm !== wsNorm
                && !cwdNorm.startsWith(wsNorm + '/')
                && !wsNorm.startsWith(cwdNorm + '/')) continue;
            // Merge into session usage map (subagent's parent UUID can collect multiple files)
            const prev = usage.get(entry.sessionId);
            if (prev) {
                prev.input += entry.usage.input;
                prev.output += entry.usage.output;
                prev.cacheCreate += entry.usage.cacheCreate;
                prev.cacheRead += entry.usage.cacheRead;
                prev.cost += entry.usage.cost;
                prev.msgCount += entry.usage.msgCount;
                const ms = new Set([...prev.models, ...entry.usage.models]);
                prev.models = Array.from(ms);
            } else {
                usage.set(entry.sessionId, { ...entry.usage, models: [...entry.usage.models] });
            }
            for (const p of entry.prompts) allPrompts.push(p);
        }
    }
    saveUsageCache();
    log(`cached scan: ws=${workspace} files=${scanned} cacheHits=${cacheHits} parsed=${parsed} sessions=${usage.size} prompts=${allPrompts.length}`);
    allPrompts.sort((a, b) => b.cost - a.cost);
    return { usage, prompts: allPrompts.slice(0, 50) };
}


// ─── Persistence: load + save team-cache.json. Mirrors usage-cache.json
//     conventions — discard on version mismatch, atomic write via mkdir + writeFile.
function loadTeamCache(): void {
    try {
        const raw = fs.readFileSync(TEAM_CACHE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.version === TEAM_CACHE_VERSION) {
            teamsCache = {
                version: TEAM_CACHE_VERSION,
                teams: parsed.teams || {},
                messages: parsed.messages || {},
            };
        } else {
            log(`team-cache version mismatch (have ${parsed?.version}, want ${TEAM_CACHE_VERSION}) — discarding`);
            teamsCache = { version: TEAM_CACHE_VERSION, teams: {}, messages: {} };
        }
    } catch { /* missing — leave empty */ }
}
function saveTeamCache(): void {
    try {
        fs.mkdirSync(path.dirname(TEAM_CACHE_FILE), { recursive: true });
        fs.writeFileSync(TEAM_CACHE_FILE, JSON.stringify(teamsCache));
    } catch (e: any) { log(`save team cache failed: ${e.message}`); }
}

// Wipe ~/.agents-viz/inbox/{team}/ when team enters archived OR tombstone-GC'd deleted.
// Per TEAMS_DECISIONS.md §2 "Final v1 store layout" (line 87 — "No fifth audit log;
// transcript.jsonl is the canonical record"): the v1 stores under inbox/ are exactly
// (1) {team}/{teammate}/{ts}.json pending slots and (2) workspace-global _dropped.log.
// _dropped.log lives OUTSIDE {team}/ so rm -rf of {team}/ never touches it.
// Resurrection note: per §3, "unarchive" forces back to active for 1h. If hooks-devops
// already delivered messages from the dir before we wiped, those landed in transcript
// already — no preservation needed.
function wipeInboxDir(teamName: string): void {
    const safe = teamName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const dir = path.join(INBOX_DIR, safe);
    if (!fs.existsSync(dir)) return;
    try {
        fs.rmSync(dir, { recursive: true, force: true });
        log(`inbox GC: wiped ${dir}`);
    } catch (e: any) { log(`inbox GC failed for ${dir}: ${e.message}`); }
}

// Derive lifecycle state from §3 truth table. Inputs: most-recent activity
// timestamp + open-task count. Reuses STALE_MS / LONG_STALE_MS thresholds.
function deriveLifecycle(
    hasConfig: boolean,
    lastActiveTs: number,
    openTasks: number,
    everSeenActivity: boolean,
): LifecycleState {
    if (!hasConfig) return 'deleted';
    if (!everSeenActivity) return 'init';
    const since = Date.now() - lastActiveTs;
    if (since >= LONG_STALE_MS_TEAMS && openTasks === 0) return 'archived';
    if (since >= STALE_MS_TEAMS && openTasks > 0) return 'idle';
    return 'active';
}

// ─── Teams: re-derive `teamsCache.teams` (and bookkeeping) from disk.
//     Called on a debounced refresh from fs.watch + on every team-hook event.
//     Schema follows TEAMS_DECISIONS.md §1.
// Reject names that look like Claude Code session UUIDs (8-4-4-4-12 hex).
// Claude Code's regular TaskCreate tool stores per-session task lists at
// `~/.claude/tasks/<session-uuid>/` — those are NOT teams. Without this filter
// every running session's task dir leaked into the cache as a phantom team.
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function looksLikeTeamName(name: string): boolean {
    return !!name && !SESSION_UUID_RE.test(name);
}

function refreshTeamsFromDisk(): void {
    let teamDirs: string[] = [];
    try { teamDirs = fs.readdirSync(TEAMS_DIR); } catch { /* ENOENT — no teams yet */ }
    // Authoritative team list = directories under TEAMS_DIR that actually carry
    // a `config.json`. The TASKS_DIR is shared with Claude Code's regular
    // session-scoped task store and MUST NOT be used to discover team names —
    // it would (and historically did) flood the cache with UUID phantoms.
    const validTeamDirs = teamDirs.filter(name => {
        if (!looksLikeTeamName(name)) return false;
        try { return fs.statSync(path.join(TEAMS_DIR, name, 'config.json')).isFile(); } catch { return false; }
    });
    // Also keep visiting cached entries (so tombstones still GC) but reject UUIDs.
    const cachedNames = Object.keys(teamsCache.teams).filter(looksLikeTeamName);
    const allTeamNames = new Set<string>([...validTeamDirs, ...cachedNames]);
    // Drop any UUID phantoms still sitting in the cache from older builds.
    for (const k of Object.keys(teamsCache.teams)) {
        if (!looksLikeTeamName(k)) {
            delete teamsCache.teams[k];
            delete teamsCache.messages[k];
        }
    }
    const now = Date.now();

    for (const teamName of allTeamNames) {
        const cfgPath = path.join(TEAMS_DIR, teamName, 'config.json');
        let configSize = 0, configMtime = 0;
        let hasConfig = false;
        try {
            const st = fs.statSync(cfgPath);
            configSize = st.size; configMtime = st.mtimeMs;
            hasConfig = true;
        } catch {}

        // Race C unlink-defer (per product-lead option (a)): on Windows, fs.watch
        // can fire an unlink event before the OS releases the file (antivirus, AV-scanner,
        // dir-junction quirks). If the previous frame had this team alive AND now config
        // is missing, treat it as suspect this frame: skip the deletion transition,
        // schedule a re-check in 200ms. If the file is genuinely gone, the re-check
        // will see it absent again and proceed. If a false positive (file reappears),
        // the team stays in its prior state. Per-event, only on the deletion edge.
        if (!hasConfig && teamsCache.teams[teamName] && teamsCache.teams[teamName].lifecycle_state !== 'deleted') {
            log(`Race C: deferring delete-state transition for team=${teamName} (200ms re-stat)`);
            setTimeout(() => scheduleTeamsRefresh(), 200);
            continue;   // keep prev entry as-is this frame
        }

        // (size, mtime) cache check — skip re-parse when config unchanged AND tasks dir unchanged.
        // Tasks dir mtime is cheap (single stat) and bumps on file create/delete inside.
        const prev = teamsCache.teams[teamName];
        let tasksDirMtime = 0;
        try { tasksDirMtime = fs.statSync(path.join(TASKS_DIR, teamName)).mtimeMs; } catch {}
        const configUnchanged = prev && prev.config_size === configSize && prev.config_mtime === configMtime;
        const tasksDirUnchanged = prev && (prev as any)._tasks_dir_mtime === tasksDirMtime;

        let members: TeamMember[] = prev ? prev.members : [];
        if (!configUnchanged && hasConfig) {
            try {
                const cfgRaw = fs.readFileSync(cfgPath, 'utf8');
                const cfg = JSON.parse(cfgRaw);
                // Tolerate either source-of-truth shape (snake or camel) — emit snake.
                const rawMembers = Array.isArray(cfg?.members) ? cfg.members : [];
                members = rawMembers.map((m: any) => ({
                    name: m.name || '',
                    agent_id: m.agent_id ?? m.agentId,
                    agent_type: m.agent_type ?? m.agentType,
                    session_id: m.session_id ?? (Array.isArray(m.sessionIds) ? m.sessionIds[0] : m.sessionId),
                }));
            } catch { /* mid-write — keep prev members */ }
        }

        // Tasks summary + full bodies + last-active recompute. Always re-stat tasks dir; small cost.
        let tasksSummary: TasksSummary = { total: 0, completed: 0, in_progress: 0, pending: 0 };
        let tasksFull: TeamTaskFull[] = [];
        let mostRecentTaskTs = 0;
        const taskDir = path.join(TASKS_DIR, teamName);
        let taskFiles: string[] = [];
        try { taskFiles = fs.readdirSync(taskDir).filter(f => f.endsWith('.json')); } catch {}
        if (!tasksDirUnchanged || !prev) {
            for (const f of taskFiles) {
                try {
                    const fp = path.join(taskDir, f);
                    const raw = fs.readFileSync(fp, 'utf8');
                    const t = JSON.parse(raw);
                    if (!t || !t.id) continue;
                    tasksSummary.total++;
                    if (t.status === 'completed') tasksSummary.completed++;
                    else if (t.status === 'in_progress') tasksSummary.in_progress++;
                    else tasksSummary.pending++;
                    const ts = t.updatedAt || t.createdAt || 0;
                    if (ts > mostRecentTaskTs) mostRecentTaskTs = ts;
                    tasksFull.push({
                        id: String(t.id),
                        subject: t.subject || '',
                        description: t.description,
                        status: (t.status === 'completed' || t.status === 'in_progress') ? t.status : 'pending',
                        owner: t.owner,
                        blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy.map(String) : undefined,
                        blocks: Array.isArray(t.blocks) ? t.blocks.map(String) : undefined,
                        createdAt: t.createdAt,
                        updatedAt: t.updatedAt,
                    });
                } catch { /* mid-write race — skip; next refresh picks it up */ }
            }
        } else {
            tasksSummary = prev.tasks_summary;
            tasksFull = prev.tasks || [];
            mostRecentTaskTs = prev.last_active_ts;
        }

        const firstSeenTs = prev ? prev.first_seen_ts : (hasConfig ? configMtime || now : now);
        const lastActiveTs = Math.max(prev?.last_active_ts || 0, mostRecentTaskTs, hasConfig ? configMtime : 0);
        const everSeenActivity = (prev?.lifecycle_state && prev.lifecycle_state !== 'init')
            || tasksSummary.total > 0
            || (members.length > 0 && hasConfig);
        const openTasks = tasksSummary.pending + tasksSummary.in_progress;
        const lifecycle = deriveLifecycle(hasConfig, lastActiveTs, openTasks, !!everSeenActivity);

        const entry: TeamEntry = {
            config_size: configSize,
            config_mtime: configMtime,
            members,
            first_seen_ts: firstSeenTs,
            last_active_ts: lastActiveTs,
            lifecycle_state: lifecycle,
            tasks_summary: tasksSummary,
            tasks: tasksFull,
            pending_inbox: prev?.pending_inbox || {},
        };
        // tasks_dir_mtime kept on the entry as an internal _ field for cache short-circuit
        (entry as any)._tasks_dir_mtime = tasksDirMtime;
        // Inbox GC: on first transition into archived OR at tombstone GC, wipe the
        // per-team inbox dir. Idempotent via inbox_gc_done flag.
        if (lifecycle === 'archived' && !prev?.inbox_gc_done) {
            wipeInboxDir(teamName);
            entry.inbox_gc_done = true;
        } else if (prev?.inbox_gc_done) {
            entry.inbox_gc_done = true;   // preserve flag across refreshes
        }
        if (lifecycle === 'deleted') {
            entry.deleted_at = prev?.deleted_at || now;
            // Tombstone GC after 7d: drop entry entirely + wipe inbox dir if not already.
            if (now - entry.deleted_at > TOMBSTONE_MS) {
                if (!entry.inbox_gc_done) wipeInboxDir(teamName);
                delete teamsCache.teams[teamName];
                delete teamsCache.messages[teamName];
                continue;
            }
        }
        teamsCache.teams[teamName] = entry;
    }
    saveTeamCache();
}

// Append a message to a team's ring buffer, FIFO-evicting the oldest when full.
// Excerpts hard-capped at TEXT_EXCERPT_MAX. Use when a SendMessage hook is observed
// (Phase 2 — currently no producer; ring stays empty, frontend tolerates absence).
function appendTeamMessage(teamName: string, msg: TeamMessage): void {
    if (!teamsCache.messages[teamName]) teamsCache.messages[teamName] = [];
    const ring = teamsCache.messages[teamName];
    msg.text_excerpt = (msg.text_excerpt || '').slice(0, TEXT_EXCERPT_MAX);
    ring.push(msg);
    if (ring.length > MSG_RING_PER_TEAM) ring.splice(0, ring.length - MSG_RING_PER_TEAM);
    // Bump last_active_ts so lifecycle reflects message activity, not just task changes.
    const entry = teamsCache.teams[teamName];
    if (entry) entry.last_active_ts = Math.max(entry.last_active_ts, msg.ts);
    saveTeamCache();
}

function scheduleTeamsRefresh(): void {
    if (teamsRefreshTimer) return;  // already pending — debounce coalesces bursts
    teamsRefreshTimer = setTimeout(() => {
        teamsRefreshTimer = undefined;
        refreshTeamsFromDisk();
        if (panel) panel.webview.postMessage({ type: 'teams-update', teams: teamsCache });
    }, 500);
}

// ─── Inbox: count pending messages per (team, teammate) by walking
//     ~/.agents-viz/inbox/{team}/{teammate}/*.json. Push counts into TeamEntry
//     and emit `inbox-pending` to webview so the composer shows pending state.
function refreshInboxPending(): void {
    let teamDirs: string[] = [];
    try { teamDirs = fs.readdirSync(INBOX_DIR); } catch { /* ENOENT — no inbox yet */ }
    for (const teamName of teamDirs) {
        if (teamName.startsWith('_')) continue;     // skip _dropped.log etc.
        const teamPath = path.join(INBOX_DIR, teamName);
        let teammateDirs: string[] = [];
        try { teammateDirs = fs.readdirSync(teamPath); } catch { continue; }
        const counts: Record<string, number> = {};
        for (const teammate of teammateDirs) {
            const inboxPath = path.join(teamPath, teammate);
            try {
                const stat = fs.statSync(inboxPath);
                if (!stat.isDirectory()) continue;
                const pending = fs.readdirSync(inboxPath).filter(f => f.endsWith('.json'));
                counts[teammate] = pending.length;
            } catch {}
        }
        // Update existing entry; if team isn't in cache yet (Phase 2 race), defer.
        const entry = teamsCache.teams[teamName];
        if (entry) entry.pending_inbox = counts;
        if (panel) {
            for (const [teammate, count] of Object.entries(counts)) {
                panel.webview.postMessage({ type: 'inbox-pending', team: teamName, teammate, count });
            }
        }
    }
}

function scheduleInboxRefresh(): void {
    if (inboxRefreshTimer) return;
    inboxRefreshTimer = setTimeout(() => {
        inboxRefreshTimer = undefined;
        refreshInboxPending();
    }, 300);
}

// Atomic write: tmp + rename. Filename includes both ts and a 6-char crypto random
// suffix so two simultaneous dashboard replies in the same ms don't collide.
function writeInboxMessage(team: string, teammate: string, payload: any): { ok: boolean; error?: string; path?: string } {
    if (!team || !teammate) return { ok: false, error: 'team and teammate are required' };
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_');
    const dir = path.join(INBOX_DIR, safe(team), safe(teammate));
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e: any) { return { ok: false, error: `mkdir failed: ${e.message}` }; }
    const ts = payload.ts || Date.now();
    const suffix = crypto.randomBytes(3).toString('hex');
    const finalPath = path.join(dir, `${ts}-${suffix}.json`);
    const tmpPath = finalPath + '.tmp';
    const body = {
        ts,
        from: payload.from || 'dashboard-user',
        to: teammate,
        kind: payload.kind || 'request',
        text: payload.text || '',
        ...(payload.ttl_ms ? { ttl_ms: payload.ttl_ms } : {}),
    };
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(body));
        fs.renameSync(tmpPath, finalPath);
    } catch (e: any) {
        try { fs.unlinkSync(tmpPath); } catch {}
        return { ok: false, error: `write failed: ${e.message}` };
    }
    log(`team_reply: wrote inbox slot ${finalPath}`);
    scheduleInboxRefresh();
    return { ok: true, path: finalPath };
}

// fs.watch over the two team roots. Watchers are recursive so a new team-dir
// or task-file inside it bubbles up. Survive ENOENT — directories are created
// lazily by Claude Code when the first team / task is created.
function startTeamsWatchers(): void {
    stopTeamsWatchers();
    loadTeamCache();
    try { fs.mkdirSync(TEAMS_DIR, { recursive: true }); } catch {}
    try { fs.mkdirSync(TASKS_DIR, { recursive: true }); } catch {}
    try { fs.mkdirSync(INBOX_DIR, { recursive: true }); } catch {}
    try {
        teamsConfigWatcher = fs.watch(TEAMS_DIR, { recursive: true }, () => scheduleTeamsRefresh());
    } catch (e: any) { log(`teams config watcher failed: ${e.message}`); }
    try {
        teamsTasksWatcher = fs.watch(TASKS_DIR, { recursive: true }, () => scheduleTeamsRefresh());
    } catch (e: any) { log(`teams tasks watcher failed: ${e.message}`); }
    // One recursive watcher on inbox/ — fires for any *.json create/delete inside
    // any team/teammate subdir. Avoids the per-teammate watcher explosion.
    try {
        teamsInboxWatcher = fs.watch(INBOX_DIR, { recursive: true }, () => scheduleInboxRefresh());
    } catch (e: any) { log(`teams inbox watcher failed: ${e.message}`); }
    refreshTeamsFromDisk();
    refreshInboxPending();
}

function stopTeamsWatchers(): void {
    if (teamsConfigWatcher) { try { teamsConfigWatcher.close(); } catch {} teamsConfigWatcher = undefined; }
    if (teamsTasksWatcher) { try { teamsTasksWatcher.close(); } catch {} teamsTasksWatcher = undefined; }
    if (teamsInboxWatcher) { try { teamsInboxWatcher.close(); } catch {} teamsInboxWatcher = undefined; }
    if (teamsRefreshTimer) { clearTimeout(teamsRefreshTimer); teamsRefreshTimer = undefined; }
    if (inboxRefreshTimer) { clearTimeout(inboxRefreshTimer); inboxRefreshTimer = undefined; }
}

function readCustomTitle(transcriptPath: string): string | undefined {
    try {
        // Reasonably small read; titles usually appear near the top but can be rewritten
        const raw = fs.readFileSync(transcriptPath, 'utf8');
        const lines = raw.split('\n');
        let title: string | undefined;
        for (const line of lines) {
            if (!line) continue;
            if (line.indexOf('custom-title') === -1) continue;
            try {
                const j = JSON.parse(line);
                if (j && j.type === 'custom-title' && typeof j.customTitle === 'string') {
                    title = j.customTitle;
                }
            } catch {}
        }
        return title;
    } catch { return undefined; }
}

// Track parent-child relationships for subagents.
// parent_tool_use_id appears in Agent/Task PreToolUse, and subagent events reference it.
const toolUseToParentSession = new Map<string, string>(); // tool_use_id → parent session_id
const subagentParent = new Map<string, { parentSessionId: string; toolUseId: string; agentName?: string }>(); // child session_id → parent info

function handleHookEvent(data: any) {
    const evt: HookEvent = { ts: Date.now(), ...data };
    // Resolve session title from transcript JSONL if we have one
    if (evt.session_id && evt.transcript_path && !sessionTitles.has(evt.session_id)) {
        const t = readCustomTitle(evt.transcript_path);
        if (t) sessionTitles.set(evt.session_id, t);
    }
    if (evt.session_id && sessionTitles.has(evt.session_id)) {
        evt.session_title = sessionTitles.get(evt.session_id);
    }

    // Subagent detection (best-effort):
    // 1) When parent Claude fires Agent/Task PreToolUse, record its tool_use_id → parent session
    // 2) When a hook event carries parent_tool_use_id, link that session as a subagent
    const toolUseId: string | undefined = evt.tool_use_id || (evt.tool_input && evt.tool_input.tool_use_id);
    if (evt.hook_event_name === 'PreToolUse' && (evt.tool_name === 'Agent' || evt.tool_name === 'Task') && toolUseId && evt.session_id) {
        toolUseToParentSession.set(toolUseId, evt.session_id);
        evt.agent_spawn = true;
        evt.agent_name = evt.tool_input?.description || evt.tool_input?.subagent_type || 'subagent';
    }
    const parentToolUse: string | undefined = evt.parent_tool_use_id;
    if (parentToolUse && evt.session_id && !subagentParent.has(evt.session_id)) {
        const parentSession = toolUseToParentSession.get(parentToolUse);
        if (parentSession) {
            subagentParent.set(evt.session_id, { parentSessionId: parentSession, toolUseId: parentToolUse });
        }
    }
    if (evt.session_id && subagentParent.has(evt.session_id)) {
        const info = subagentParent.get(evt.session_id)!;
        evt.parent_session_id = info.parentSessionId;
        evt.parent_tool_use_id = info.toolUseId;
        evt.is_subagent = true;
    }

    // Teams hooks (Feb 2026): re-derive teams state from disk on every event.
    // The forwarder data shape is trusted (per CLAUDE.md §3.5) — we just need
    // the trigger; the disk is the source of truth.
    if (evt.hook_event_name === 'TeammateIdle'
        || evt.hook_event_name === 'TaskCreated'
        || evt.hook_event_name === 'TaskCompleted') {
        scheduleTeamsRefresh();
    }

    eventBuffer.push(evt);
    if (eventBuffer.length > MAX_BUFFER) eventBuffer.shift();
    log(`event: ${evt.hook_event_name || '?'} tool=${evt.tool_name || '-'} title=${evt.session_title || '-'}${evt.is_subagent ? ' [sub]' : ''}`);
    if (panel) {
        panel.webview.postMessage({ type: 'event', data: evt });
    }
}

function writeDiscovery(workspace: string, port: number) {
    fs.mkdirSync(DISCOVERY_DIR, { recursive: true });
    const file = path.join(DISCOVERY_DIR, `${workspaceHash(workspace)}-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify({
        port,
        pid: process.pid,
        token: authToken,
        workspace,
    }, null, 2));
    discoveryFile = file;
    log(`discovery file written: ${file}`);
}

function removeDiscovery() {
    if (discoveryFile && fs.existsSync(discoveryFile)) {
        try { fs.unlinkSync(discoveryFile); } catch {}
    }
}

function hookForwarderPath(context: vscode.ExtensionContext): string {
    return path.join(context.extensionPath, 'dist', 'hooks', 'hook-forwarder.js');
}

async function configureClaudeHooks(context: vscode.ExtensionContext) {
    const nodeExe = process.platform === 'win32' ? '"C:\\Program Files\\nodejs\\node.exe"' : 'node';
    const hookPath = hookForwarderPath(context);
    const cmd = `${nodeExe} "${hookPath}"`;

    let settings: any = {};
    if (fs.existsSync(CLAUDE_SETTINGS)) {
        try { settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')); } catch {}
    }
    settings.hooks = settings.hooks || {};

    let added = 0;
    for (const eventName of HOOK_EVENTS) {
        settings.hooks[eventName] = settings.hooks[eventName] || [];
        const existing = settings.hooks[eventName] as any[];
        const alreadyHas = existing.some(entry =>
            entry.hooks?.some((h: any) => h.command?.includes('agents-viz'))
        );
        if (alreadyHas) continue;
        existing.push({
            hooks: [{ type: 'command', command: cmd, timeout: 2 }]
        });
        added++;
    }

    fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
    fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
    vscode.window.showInformationMessage(
        `Agents Viz: configured ${added} new hook event(s). Restart Claude Code sessions to apply.`
    );
}


export async function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Agents Viz');
    context.subscriptions.push(outputChannel);
    log(`activating, extensionPath=${context.extensionPath}`);

    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
    log(`workspace resolved to: ${workspace}`);

    context.subscriptions.push(vscode.commands.registerCommand('agentsViz.open', async () => {
        if (panel) { panel.reveal(); return; }

        const port = await startHookServer(workspace);
        writeDiscovery(workspace, port);
        log(`hook server listening on ${port}`);
        startTeamsWatchers();
        log(`teams watchers started (teams=${Object.keys(teamsCache.teams).length})`);

        const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
        panel = vscode.window.createWebviewPanel(
            'agentsViz',
            'Agents Viz',
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaRoot] }
        );
        // Embed sprites + per-char manifests (cell/sheet dims, frame map).
        // Manifest enables flexible sprite sizes per char (v17c uses 96x192 cells,
        // legacy LPC uses 48x96). webview reads manifest via CSS variables.
        const spriteUris: string[] = [];
        const spriteManifests: any[] = [];
        let defaultManifest: any = null;
        try {
            defaultManifest = JSON.parse(fs.readFileSync(
                path.join(context.extensionPath, 'media', 'characters', '_default.json'), 'utf-8'));
        } catch { /* no default — fall back to baked LPC dims */ }
        // Roster expanded 6→50: 50 character variants generated by Z-Image-Turbo
        // pipeline (see SPRITE_FLEXIBLE_DESIGN.md + pixel-character-pipeline skill).
        // Empty slots auto-skip via try/catch — adding more chars later: drop the
        // PNG+JSON in characters/ and bump this loop.
        // CHAR_SLOTS = how many char_X.png slots to load. Bump as more sheets are added.
        // Only count actually-existing PNG files so hashIdx doesn't map sessions to empty slots.
        const fsCharsDir = path.join(context.extensionPath, 'media', 'characters');
        let CHAR_SLOTS = 6;  // safe default
        try {
            const existing = fs.readdirSync(fsCharsDir)
                .filter(f => /^char_(\d+)\.png$/.test(f))
                .map(f => parseInt(f.match(/^char_(\d+)\.png$/)![1], 10));
            if (existing.length) CHAR_SLOTS = Math.max(...existing) + 1;
        } catch { /* keep default 6 */ }
        for (let i = 0; i < CHAR_SLOTS; i++) {
            const p = path.join(context.extensionPath, 'media', 'characters', `char_${i}.png`);
            try {
                const b64 = fs.readFileSync(p).toString('base64');
                spriteUris.push('data:image/png;base64,' + b64);
            } catch {
                spriteUris.push('');
            }
            const mp = path.join(context.extensionPath, 'media', 'characters', `char_${i}.json`);
            try {
                spriteManifests.push(JSON.parse(fs.readFileSync(mp, 'utf-8')));
            } catch {
                spriteManifests.push(defaultManifest);
            }
        }
        // Furniture sprites for sleeping state
        const readFurniture = (name: string) => {
            try {
                const p = path.join(context.extensionPath, 'media', 'furniture', name);
                return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
            } catch { return ''; }
        };
        const sofaFront = readFurniture('SOFA_FRONT.png');
        const sofaSide = readFurniture('SOFA_SIDE.png');
        // Function to (re)build + push webview HTML — reused by hot-reload watcher.
        // Reads extension/webview.html from disk each call so edits take effect instantly.
        hotReloadRebuild = () => {
            if (!panel) return;
            const rooms = scanRoomImages();
            // Resolve the bundled echarts.min.js into a webview-scheme URI so the
            // dashboard can <script src=...> it without the default-CSP rejecting
            // a file:/// path.
            const echartsUri = panel.webview.asWebviewUri(
                vscode.Uri.joinPath(context.extensionUri, 'media', 'vendor', 'echarts.min.js')
            ).toString();
            // First-load fast path: ship HTML with EMPTY usage/promptCosts so the
            // panel renders immediately. Heavy scans run async below and post results.
            panel.webview.html = buildWebviewHtml({
                spriteUris, spriteManifests, roomImages: rooms,
                extensionPath: context.extensionPath,
                sofaFront, sofaSide,
                sessionUsage: {},
                promptCosts: [],
                echartsUri,
                teams: teamsCache,
            });
            // Background scan with on-disk cache. First load: full read + populate cache.
            // Subsequent loads: only re-read changed files. Then post results to webview.
            setTimeout(() => {
                if (!panel) return;
                try {
                    const { usage, prompts } = scanCachedAll(workspace);
                    const sessionUsage: Record<string, any> = {};
                    for (const [sid, u] of usage) sessionUsage[sid] = u;
                    panel.webview.postMessage({ type: 'usage-update', sessionUsage });
                    panel.webview.postMessage({ type: 'prompt-costs-update', promptCosts: prompts });
                } catch (e) { log(`usage+prompt scan failed: ${(e as any).message}`); }
            }, 50);

            // Progressive streaming: send sessions to webview one-by-one (newest first).
            // Each session is a separate 'replay' message so the UI renders incrementally.
            setTimeout(() => {
                if (!panel) return;
                // Live buffer first (fastest to populate)
                if (eventBuffer.length > 0) {
                    panel.webview.postMessage({ type: 'replay', data: eventBuffer.slice() });
                }
                let sessionsSent = 0;
                let eventsSent = 0;
                // Per-session 80→500 (~last hour of activity). sessionsPerProject 15→30.
                scanJsonlHistoryProgressive(workspace, 500, 30,
                    (batch, sid) => {
                        if (!panel) return;
                        panel.webview.postMessage({ type: 'replay', data: batch });
                        sessionsSent++;
                        eventsSent += batch.length;
                    },
                    () => {
                        log(`replay done: ${sessionsSent} sessions, ${eventsSent} events streamed`);
                    },
                );
            }, 50);
        };
        hotReloadRebuild();

        // Poll extension/webview.html for changes. Since the HTML is a plain file read
        // at rebuild time (not bundled into extension.js), any edit/save triggers a
        // true hot-reload without extension host restart.
        try {
            const watchFile = webviewHtmlPath(context.extensionPath);
            if (hotReloadWatchedFile) { fs.unwatchFile(hotReloadWatchedFile); }
            hotReloadWatchedFile = watchFile;
            let lastSeenMtime = 0;
            try { lastSeenMtime = fs.statSync(watchFile).mtimeMs; } catch {}
            // Polling every 500ms via setInterval — most reliable across platforms/junctions
            const pollInterval = setInterval(() => {
                try {
                    const s = fs.statSync(watchFile);
                    if (s.mtimeMs !== lastSeenMtime && s.size > 0) {
                        lastSeenMtime = s.mtimeMs;
                        log(`webview.html changed (mtime=${s.mtimeMs}) → hot-reloading`);
                        if (hotReloadRebuild) hotReloadRebuild();
                    }
                } catch {}
            }, 500);
            (panel as any)._fallbackInterval = pollInterval;
            log(`hot-reload: polling ${watchFile} @500ms`);
        } catch (e: any) { log(`hot-reload watcher failed: ${e.message}`); }

        panel.onDidDispose(() => {
            const fi = (panel as any)?._fallbackInterval;
            if (fi) clearInterval(fi);
            panel = undefined;
            if (server) { server.close(); server = undefined; }
            if (hotReloadWatchedFile) { fs.unwatchFile(hotReloadWatchedFile); hotReloadWatchedFile = undefined; }
            if (hotReloadTimer) { clearTimeout(hotReloadTimer); hotReloadTimer = undefined; }
            hotReloadRebuild = undefined;
            stopTeamsWatchers();
            removeDiscovery();
        });

        // Handle messages from webview (e.g. delete-session, load-more-history)
        panel.webview.onDidReceiveMessage(async (msg: any) => {
            if (msg?.type === 'load-more-history' && msg.session_id && msg.before_ts) {
                const events = loadMoreSessionHistory(msg.session_id, msg.before_ts, msg.limit || 200);
                if (panel) panel.webview.postMessage({
                    type: 'history-chunk',
                    session_id: msg.session_id,
                    before_ts: msg.before_ts,
                    events,
                });
                return;
            }
            // team_reply: composer → atomic write to ~/.agents-viz/inbox/{team}/{teammate}/{ts}-{6hex}.json
            // Hook reader (UserPromptSubmit) consumes the slot on next prompt boundary; we just write.
            // Frontend accepts msg.text (architect canonical) AND msg.body (frontend draft alias) for compatibility.
            if (msg?.type === 'team_reply' && msg.team && msg.teammate && (typeof msg.text === 'string' || typeof msg.body === 'string')) {
                const ts = Date.now();
                const text = typeof msg.text === 'string' ? msg.text : msg.body;
                const result = writeInboxMessage(msg.team, msg.teammate, {
                    ts,
                    text,
                    kind: msg.kind || 'request',
                    from: 'dashboard-user',
                });
                // Phase 1 producer: append to dashboard ring on successful write so the
                // mailbox ribbon shows the outgoing message immediately. (Per team-lead's
                // §5 phase override: composer is in scope this milestone, not Phase 2.)
                if (result.ok) {
                    appendTeamMessage(msg.team, {
                        ts, from: 'dashboard-user', to: msg.teammate,
                        text_excerpt: text,   // appendTeamMessage caps at 240ch
                    });
                    if (panel) panel.webview.postMessage({ type: 'teams-update', teams: teamsCache });
                }
                if (panel) panel.webview.postMessage({
                    type: 'team_reply_result',
                    team: msg.team,
                    teammate: msg.teammate,
                    ok: result.ok,
                    path: result.path,
                    ts,
                    error: result.error,
                });
                return;
            }
            if (msg?.type === 'delete-session' && msg.session_id) {
                const sid = msg.session_id;
                const before = eventBuffer.length;
                eventBuffer = eventBuffer.filter(e => e.session_id !== sid);
                log(`delete-session ${sid}: purged ${before - eventBuffer.length} events from buffer`);
                sessionTitles.delete(sid);
                subagentParent.delete(sid);

                if (msg.alsoDeleteFile) {
                    // Find the matching JSONL file(s) and send to recycle bin (not permanent)
                    try {
                        if (fs.existsSync(CLAUDE_PROJECTS_DIR)) {
                            const pdirs = fs.readdirSync(CLAUDE_PROJECTS_DIR);
                            for (const pd of pdirs) {
                                const candidate = path.join(CLAUDE_PROJECTS_DIR, pd, sid + '.jsonl');
                                if (fs.existsSync(candidate)) {
                                    const ok = sendToRecycleBin(candidate);
                                    log(`recycle transcript ${candidate}: ${ok ? 'OK' : 'FAIL'}`);
                                    const meta = candidate.replace(/\.jsonl$/, '.meta.json');
                                    if (fs.existsSync(meta)) sendToRecycleBin(meta);
                                    // Notify webview
                                    if (panel) panel.webview.postMessage({ type: 'delete-result', session_id: sid, recycled: ok });
                                    break;
                                }
                            }
                        }
                    } catch (e: any) { log(`recycle failed: ${e.message}`); }
                }
            }
        });

        // Initial replay is now handled inside hotReloadRebuild (history + live merged).
    }));

    context.subscriptions.push(vscode.commands.registerCommand('agentsViz.configureHooks', async () => {
        await configureClaudeHooks(context);
    }));

    // Manual reload command — forces webview HTML rebuild regardless of mtime watching.
    context.subscriptions.push(vscode.commands.registerCommand('agentsViz.reloadPanel', () => {
        if (!panel) { vscode.window.showInformationMessage('Agents Viz: panel not open'); return; }
        if (hotReloadRebuild) {
            hotReloadRebuild();
            vscode.window.showInformationMessage('Agents Viz: panel HTML reloaded');
        }
    }));

    // Show diagnostic output channel
    context.subscriptions.push(vscode.commands.registerCommand('agentsViz.showLogs', () => {
        outputChannel?.show(true);
    }));

    // Restart extension host — reloads extension.ts code WITHOUT killing integrated terminals.
    // Use this when extension code (non-webview) changed; terminals + other windows survive.
    context.subscriptions.push(vscode.commands.registerCommand('agentsViz.restartHost', async () => {
        const choice = await vscode.window.showInformationMessage(
            'Restart extension host? This reloads all extensions (keeps terminals alive).',
            { modal: false },
            'Restart', 'Cancel'
        );
        if (choice === 'Restart') {
            vscode.commands.executeCommand('workbench.action.restartExtensionHost');
        }
    }));

    context.subscriptions.push({
        dispose: () => {
            if (server) server.close();
            if (hotReloadWatchedFile) fs.unwatchFile(hotReloadWatchedFile);
            stopTeamsWatchers();
            removeDiscovery();
        }
    });

    log('activated');
}

export function deactivate() {
    if (server) server.close();
    removeDiscovery();
}
