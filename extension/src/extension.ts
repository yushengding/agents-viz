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
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'Stop',
    'Notification',
] as const;

let panel: vscode.WebviewPanel | undefined;
let server: http.Server | undefined;
let discoveryFile: string | undefined;
let authToken: string | undefined;
let eventBuffer: HookEvent[] = [];
const MAX_BUFFER = 1000;

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
        if (cwdNorm !== wsNorm && !cwdNorm.startsWith(wsNorm + '/')) continue;
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
                if (cwdNorm && (cwdNorm === wsNorm || cwdNorm.startsWith(wsNorm + '/'))) {
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

function readDiskCache(sessionId: string, expectedMtime: number): HookEvent[] | null {
    try {
        const p = cachePath(sessionId);
        if (!fs.existsSync(p)) return null;
        const c = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!c || c.mtime !== expectedMtime || !Array.isArray(c.events)) return null;
        return c.events as HookEvent[];
    } catch { return null; }
}
function writeDiskCache(sessionId: string, mtime: number, events: HookEvent[]): void {
    try {
        if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(cachePath(sessionId), JSON.stringify({ mtime, events }));
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
    let raw: string;
    try { raw = fs.readFileSync(jsonlPath, 'utf8'); } catch { return null; }
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
let _usageCache: Record<string, FileCacheEntry> | null = null;
function getUsageCache(): Record<string, FileCacheEntry> {
    if (_usageCache) return _usageCache;
    try {
        const raw = fs.readFileSync(USAGE_CACHE_FILE, 'utf8');
        _usageCache = JSON.parse(raw);
    } catch { _usageCache = {}; }
    return _usageCache!;
}
function saveUsageCache(): void {
    if (!_usageCache) return;
    try {
        fs.mkdirSync(path.dirname(USAGE_CACHE_FILE), { recursive: true });
        fs.writeFileSync(USAGE_CACHE_FILE, JSON.stringify(_usageCache));
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
function scanPromptCosts_OLD(workspace: string, sessionsPerProject = 15): PromptCost[] {
    const wsNorm = (process.platform === 'win32' ? workspace.toLowerCase() : workspace).replace(/\\/g, '/');
    const out: PromptCost[] = [];
    if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return out;
    let projectDirs: string[] = [];
    try { projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR).map(d => path.join(CLAUDE_PROJECTS_DIR, d)); } catch { return out; }
    const collectJsonl = (root: string, depth = 0): { p: string, m: number, size: number }[] => {
        if (depth > 3) return [];
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
        const acc: { p: string, m: number, size: number }[] = [];
        for (const e of entries) {
            const full = path.join(root, e.name);
            if (e.isDirectory()) acc.push(...collectJsonl(full, depth + 1));
            else if (e.name.endsWith('.jsonl')) {
                try {
                    const st = fs.statSync(full);
                    acc.push({ p: full, m: st.mtimeMs, size: st.size });
                } catch {}
            }
        }
        return acc;
    };
    // Tail-read strategy: only the most recent ~512 KB of each JSONL is read.
    // Most user prompts of interest are recent; we don't need ancient messages.
    const TAIL_BYTES = 512 * 1024;
    const tailRead = (file: string, size: number): string => {
        if (size <= TAIL_BYTES) return fs.readFileSync(file, 'utf8');
        const fd = fs.openSync(file, 'r');
        try {
            const buf = Buffer.alloc(TAIL_BYTES);
            fs.readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
            const txt = buf.toString('utf8');
            // Drop the first (probably incomplete) line so parses don't fail mid-record
            const nl = txt.indexOf('\n');
            return nl >= 0 ? txt.slice(nl + 1) : txt;
        } finally { fs.closeSync(fd); }
    };
    const startMs = Date.now();
    const HARD_DEADLINE_MS = 1500;
    for (const dir of projectDirs) {
        if (Date.now() - startMs > HARD_DEADLINE_MS) break;
        const filesEntries = collectJsonl(dir)
            .sort((a, b) => b.m - a.m)
            .slice(0, sessionsPerProject);
        for (const fe of filesEntries) {
            if (Date.now() - startMs > HARD_DEADLINE_MS) break;
            try {
                const raw = tailRead(fe.p, fe.size);
                const lines = raw.split('\n');
                const file = fe.p;
                const fileBase = path.basename(file, '.jsonl');
                let sessionId = fileBase;
                let cwd: string | undefined;
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
                if (!cwd) continue;
                const cwdNorm = (process.platform === 'win32' ? cwd.toLowerCase() : cwd).replace(/\\/g, '/');
                if (cwdNorm !== wsNorm && !cwdNorm.startsWith(wsNorm + '/')) continue;

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
                        if (!txt || txt.startsWith('<')) continue; // skip system meta
                        if (cur) out.push(cur);
                        cur = { sessionId, promptText: txt.slice(0, 220), promptTs: ts, cost: 0, tokens: 0, cwd };
                    } else if (j.type === 'assistant' && cur) {
                        const u = j.message?.usage;
                        if (!u) continue;
                        const inp = u.input_tokens || 0;
                        const outp = u.output_tokens || 0;
                        const cc = u.cache_creation_input_tokens || 0;
                        const cr = u.cache_read_input_tokens || 0;
                        const ccBd = u.cache_creation || {};
                        const cc1h = ccBd.ephemeral_1h_input_tokens || 0;
                        const cc5m = ccBd.ephemeral_5m_input_tokens || 0;
                        const cc5m_eff = (cc1h + cc5m > 0) ? cc5m : cc;
                        const cc1h_eff = (cc1h + cc5m > 0) ? cc1h : 0;
                        const pr = priceFor(j.message?.model || '');
                        cur.cost += (inp * pr.in + outp * pr.out + cc5m_eff * pr.cwrite5m + cc1h_eff * pr.cwrite1h + cr * pr.cread) / 1_000_000;
                        cur.tokens += inp + outp + cc + cr;
                    }
                }
                if (cur) out.push(cur);
            } catch {}
        }
    }
    out.sort((a, b) => b.cost - a.cost);
    log(`prompt-cost scan: ws=${workspace} prompts=${out.length}`);
    return out.slice(0, 50);  // top 50 globally
}

/** New caching scanner: walks all matching JSONL files, uses per-file cache for
 *  unchanged files, full-reads + caches changed ones. Returns both per-session
 *  usage and per-prompt costs. Called once per panel build. */
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
            if (cwdNorm !== wsNorm && !cwdNorm.startsWith(wsNorm + '/')) continue;
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

function scanJsonlUsage_OLD(workspace: string, sessionsPerProject = 50): Map<string, SessionUsage> {
    const wsNorm = (process.platform === 'win32' ? workspace.toLowerCase() : workspace).replace(/\\/g, '/');
    const out = new Map<string, SessionUsage>();
    if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return out;
    let projectDirs: string[] = [];
    try { projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR).map(d => path.join(CLAUDE_PROJECTS_DIR, d)); } catch { return out; }
    // Recursively collect all *.jsonl files (incl. subagent transcripts in nested dirs).
    const collectJsonl = (root: string, depth = 0): { p: string, m: number, size: number }[] => {
        if (depth > 3) return [];
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
        const acc: { p: string, m: number, size: number }[] = [];
        for (const e of entries) {
            const full = path.join(root, e.name);
            if (e.isDirectory()) {
                acc.push(...collectJsonl(full, depth + 1));
            } else if (e.name.endsWith('.jsonl')) {
                try {
                    const st = fs.statSync(full);
                    acc.push({ p: full, m: st.mtimeMs, size: st.size });
                } catch {}
            }
        }
        return acc;
    };
    // Same tail-read strategy for first-load speed. Files <1MB get full read
    // (so small sessions are accurate); larger files only read last 1MB.
    const USAGE_TAIL_BYTES = 1024 * 1024;
    const usageTailRead = (file: string, size: number): string => {
        if (size <= USAGE_TAIL_BYTES) return fs.readFileSync(file, 'utf8');
        const fd = fs.openSync(file, 'r');
        try {
            const buf = Buffer.alloc(USAGE_TAIL_BYTES);
            fs.readSync(fd, buf, 0, USAGE_TAIL_BYTES, size - USAGE_TAIL_BYTES);
            const txt = buf.toString('utf8');
            const nl = txt.indexOf('\n');
            return nl >= 0 ? txt.slice(nl + 1) : txt;
        } finally { fs.closeSync(fd); }
    };
    const usageStartMs = Date.now();
    const USAGE_DEADLINE_MS = 2500;
    for (const dir of projectDirs) {
        if (Date.now() - usageStartMs > USAGE_DEADLINE_MS) break;
        const filesEntries = collectJsonl(dir).sort((a, b) => b.m - a.m).slice(0, sessionsPerProject);
        for (const fe of filesEntries) {
            if (Date.now() - usageStartMs > USAGE_DEADLINE_MS) break;
            const file = fe.p;
            try {
                const raw = usageTailRead(file, fe.size);
                const lines = raw.split('\n');
                const fileBase = path.basename(file, '.jsonl');
                // For subagent JSONL (<parent>/subagents/agent-*.jsonl): events inside
                // reference parent's UUID via sessionId. We aggregate USAGE under the
                // PARENT's UUID so the parent char in the floor plan reflects total
                // (parent + all child) cost. For top-level files, sessionId == filename.
                let sessionId = fileBase;
                if (fileBase.startsWith('agent-')) {
                    // pull parent UUID from events
                    for (const line of lines) {
                        if (line.indexOf('"sessionId"') === -1) continue;
                        try {
                            const j = JSON.parse(line);
                            if (j?.sessionId) { sessionId = j.sessionId; break; }
                        } catch {}
                    }
                }
                let cwd: string | undefined;
                for (const line of lines) {
                    if (line.indexOf('"cwd"') === -1) continue;
                    try {
                        const j = JSON.parse(line);
                        if (j?.cwd) { cwd = j.cwd; break; }
                    } catch {}
                }
                if (!cwd) continue;
                const cwdNorm = (process.platform === 'win32' ? cwd.toLowerCase() : cwd).replace(/\\/g, '/');
                if (cwdNorm !== wsNorm && !cwdNorm.startsWith(wsNorm + '/')) continue;

                const agg: SessionUsage = out.get(sessionId) || { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, models: [], msgCount: 0 };
                const modelSet = new Set<string>(agg.models);
                for (const line of lines) {
                    if (!line || line.indexOf('"usage"') === -1) continue;
                    try {
                        const j = JSON.parse(line);
                        if (j.type !== 'assistant') continue;
                        const msg = j.message;
                        if (!msg || typeof msg !== 'object') continue;
                        const u = msg.usage;
                        if (!u) continue;
                        const model = msg.model || 'unknown';
                        if (model !== '<synthetic>') modelSet.add(model);
                        agg.msgCount++;
                        const inp = u.input_tokens || 0;
                        const outp = u.output_tokens || 0;
                        const cc = u.cache_creation_input_tokens || 0;
                        const cr = u.cache_read_input_tokens || 0;
                        // Split cache creation into 5m vs 1h (different prices; 1h is 2×, 5m is 1.25×)
                        const cc_breakdown = u.cache_creation || {};
                        const cc1h = cc_breakdown.ephemeral_1h_input_tokens || 0;
                        const cc5m = cc_breakdown.ephemeral_5m_input_tokens || 0;
                        // Fall back to lumped cc if breakdown is missing (old format)
                        const cc5m_eff = (cc1h + cc5m > 0) ? cc5m : cc;
                        const cc1h_eff = (cc1h + cc5m > 0) ? cc1h : 0;
                        agg.input += inp;
                        agg.output += outp;
                        agg.cacheCreate += cc;
                        agg.cacheRead += cr;
                        const pr = priceFor(model);
                        agg.cost += (
                            inp * pr.in +
                            outp * pr.out +
                            cc5m_eff * pr.cwrite5m +
                            cc1h_eff * pr.cwrite1h +
                            cr * pr.cread
                        ) / 1_000_000;
                    } catch {}
                }
                agg.models = Array.from(modelSet);
                if (agg.msgCount > 0) out.set(sessionId, agg);
            } catch {}
        }
    }
    log(`usage scan: ws=${workspace} sessions=${out.size}`);
    return out;
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

        const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
        panel = vscode.window.createWebviewPanel(
            'agentsViz',
            'Agents Viz',
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaRoot] }
        );
        // Embed sprites as base64 data URIs to avoid any CSP/scheme issues in the webview.
        const spriteUris: string[] = [];
        for (let i = 0; i < 6; i++) {
            const p = path.join(context.extensionPath, 'media', 'characters', `char_${i}.png`);
            try {
                const b64 = fs.readFileSync(p).toString('base64');
                spriteUris.push('data:image/png;base64,' + b64);
            } catch {
                spriteUris.push('');
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
            // First-load fast path: ship HTML with EMPTY usage/promptCosts so the
            // panel renders immediately. Heavy scans run async below and post results.
            panel.webview.html = buildWebviewHtml({
                spriteUris, roomImages: rooms,
                extensionPath: context.extensionPath,
                sofaFront, sofaSide,
                sessionUsage: {},
                promptCosts: [],
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
                scanJsonlHistoryProgressive(workspace, 80, 15,
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
            removeDiscovery();
        }
    });

    log('activated');
}

export function deactivate() {
    if (server) server.close();
    removeDiscovery();
}
