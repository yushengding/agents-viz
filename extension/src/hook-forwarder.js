#!/usr/bin/env node
// Agents Viz hook forwarder.
// Adapted from Agent Flow (Apache-2.0) hook.js + Pixel Agents claude-hook.js.
//
// Invoked by Claude Code as a command hook. Reads event JSON from stdin,
// looks up live Agents Viz panel via discovery dir, forwards via HTTP POST.
// Silent: no stdout. Zero-token cost.
//
// Discovery dir: ~/.agents-viz/
// Discovery file: {workspace-hash}-{pid}.json  →  { port, pid, token, workspace }
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

// Hard exit deadline — guarantees exit well before Claude Code's 2s kill.
setTimeout(() => process.exit(0), 1500);

const DIR = path.join(os.homedir(), '.agents-viz');
const IS_WIN = process.platform === 'win32';

function normPath(p) {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch {}
  // Windows: drive-letter case varies across sources (VS Code lowercases, Claude uppercases).
  // Normalize to a canonical case-insensitive form by lowercasing on win32.
  if (process.platform === 'win32') r = r.toLowerCase();
  return r;
}

function isAlive(pid) {
  if (IS_WIN) return true; // Windows PID check unreliable
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// DEBUG: log every invocation to file (temporary, for UAT diagnosis)
const DEBUG_LOG = path.join(DIR, 'forwarder-debug.log');
function debugLog(msg) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(DEBUG_LOG, new Date().toISOString() + ' pid=' + process.pid + ' ' + msg + '\n');
  } catch {}
}
debugLog('forwarder invoked argv=' + JSON.stringify(process.argv.slice(2)));

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  debugLog('stdin end, input.length=' + input.length + ' first120=' + input.slice(0, 120));
  let cwd;
  try { cwd = JSON.parse(input).cwd; } catch (e) { debugLog('parse fail: ' + e.message); process.exit(0); }
  if (!cwd) { debugLog('no cwd in input'); process.exit(0); }

  const resolvedCwd = normPath(cwd);
  debugLog('cwd input=' + cwd + ' resolvedCwd=' + resolvedCwd);

  let allFiles;
  try {
    allFiles = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
  } catch { process.exit(0); }
  if (!allFiles.length) process.exit(0);

  const matches = [];
  for (const file of allFiles) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')); } catch { continue; }
    if (!d.workspace || !d.pid || !d.port) continue;

    if (!isAlive(d.pid)) {
      try { fs.unlinkSync(path.join(DIR, file)); } catch {}
      continue;
    }

    const ws = normPath(d.workspace);
    const m = resolvedCwd === ws || resolvedCwd.startsWith(ws + path.sep);
    debugLog('  probe ws=' + ws + ' match=' + m);
    if (m) {
      matches.push({ d, file, wsLen: ws.length });
    }
  }

  if (!matches.length) { debugLog('NO MATCH, exit'); process.exit(0); }

  // Longest-match wins: most specific workspace first
  matches.sort((a, b) => b.wsLen - a.wsLen);
  const bestLen = matches[0].wsLen;
  const targets = matches.filter(m => m.wsLen === bestLen);

  let pending = targets.length;
  for (const { d } of targets) {
    let settled = false;
    const finish = () => { if (settled) return; settled = true; done(); };
    const headers = { 'Content-Type': 'application/json' };
    if (d.token) headers['Authorization'] = `Bearer ${d.token}`;
    const req = http.request({
      hostname: '127.0.0.1', port: d.port, method: 'POST',
      path: '/api/hooks/claude',
      headers,
      timeout: 1000,
    }, res => { res.resume(); res.on('end', finish); });
    req.on('error', finish);
    req.on('timeout', () => { req.destroy(); });
    req.write(input);
    req.end();
  }

  function done() { if (--pending <= 0) process.exit(0); }
});
