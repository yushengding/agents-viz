#!/usr/bin/env node
// Extract HTML from webview.ts, wrap with vscode-api mock + synthetic events,
// emit preview.html that opens in Chrome headless or regular Chrome.

const fs = require('fs');
const path = require('path');

const WEBVIEW_HTML = path.join(__dirname, '..', 'extension', 'webview.html');
const SPRITES_DIR = path.join(__dirname, '..', 'extension', 'media', 'characters');
const OUT = path.join(__dirname, '..', 'screenshots', 'preview.html');

if (!fs.existsSync(WEBVIEW_HTML)) {
    console.error('webview.html not found at', WEBVIEW_HTML);
    process.exit(1);
}
let html = fs.readFileSync(WEBVIEW_HTML, 'utf8');
html = html.replace(/__BUILD_STAMP__/g, new Date().toTimeString().slice(0, 8));
html = html.replace(/__ROOM_IMAGES__/g, '{}');
html = html.replace(/__SOFA_FRONT__/g, '');
html = html.replace(/__SOFA_SIDE__/g, '');

// For preview, embed sprite images as base64 data URIs so Chrome can show them without localResourceRoots
const sprites = [];
const manifests = [];
let defaultManifest = null;
try {
    defaultManifest = JSON.parse(fs.readFileSync(path.join(SPRITES_DIR, '_default.json'), 'utf8'));
} catch { /* ok */ }
for (let i = 0; i < 6; i++) {
    const p = path.join(SPRITES_DIR, `char_${i}.png`);
    if (fs.existsSync(p)) {
        const b64 = fs.readFileSync(p).toString('base64');
        sprites.push('data:image/png;base64,' + b64);
    } else {
        sprites.push('');
    }
    const mp = path.join(SPRITES_DIR, `char_${i}.json`);
    try {
        manifests.push(JSON.parse(fs.readFileSync(mp, 'utf8')));
    } catch {
        manifests.push(defaultManifest);
    }
}
html = html.replace(/__SPRITE_URIS__/g, JSON.stringify(sprites));
html = html.replace(/__SPRITE_MANIFESTS__/g, JSON.stringify(manifests));
// Standalone preview: load ECharts from CDN (in VSCode extension context the URI
// is replaced via panel.webview.asWebviewUri pointing at extension/media/vendor/).
html = html.replace(/__ECHARTS_URI__/g, 'https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js');
html = html.replace(/__SESSION_USAGE__/g, JSON.stringify({
    bb0002: { input: 12000, output: 4000, cacheCreate: 8000, cacheRead: 100000, cost: 1.42, models: ['claude-opus-4-7'], msgCount: 38 },
    bbbb2222: { input: 8000, output: 3500, cacheCreate: 4000, cacheRead: 60000, cost: 0.78, models: ['claude-opus-4-7'], msgCount: 22 },
    cccc3333: { input: 5000, output: 1500, cacheCreate: 2000, cacheRead: 25000, cost: 0.21, models: ['claude-opus-4-7'], msgCount: 9 },
    dddd4444: { input: 800, output: 200, cacheCreate: 0, cacheRead: 0, cost: 0.03, models: [], msgCount: 1 },
    eeee5555: { input: 1500, output: 600, cacheCreate: 1000, cacheRead: 12000, cost: 0.18, models: [], msgCount: 4 },
}));
const _previewNow = Date.now();
html = html.replace(/__PROMPT_COSTS__/g, JSON.stringify([
    { sessionId: 'bb0002', promptText: 'tweak fusion UI legibility on mobile', promptTs: _previewNow - 1000, cost: 0.42, tokens: 18000, cwd: '~/projects/example_game' },
    { sessionId: 'bbbb2222', promptText: 'backtest VIX>30 entry with SPXL', promptTs: _previewNow - 2000, cost: 0.31, tokens: 12000, cwd: '~/projects/example_trading' },
    { sessionId: 'cccc3333', promptText: 'add pixel character avatars to the sidebar', promptTs: _previewNow - 3000, cost: 0.08, tokens: 4000, cwd: '~/projects/agents-viz' },
]));

const now = Date.now();
const mkEvt = (sid, cwd, name, extras = {}, dt = 0) => ({
    ts: now + dt,
    session_id: sid,
    cwd,
    hook_event_name: name,
    ...extras,
});

// Realistic multi-session scenario: 3 concurrent Claude sessions with renames
const events = [
    // Session A - stickerfort with custom-title "sticker-polish"
    mkEvt('bb0002', '~/projects/example_game', 'SessionStart', { session_title: 'sticker-polish' }, 0),
    mkEvt('bb0002', '~/projects/example_game', 'UserPromptSubmit',
        { session_title: 'sticker-polish', prompt: 'tweak fusion UI legibility on mobile' }, 500),
    mkEvt('bb0002', '~/projects/example_game', 'PreToolUse',
        { session_title: 'sticker-polish', tool_name: 'Read', tool_input: { file_path: 'stickerfort/scripts/fusion_ui.gd' } }, 900),
    mkEvt('bb0002', '~/projects/example_game', 'PostToolUse',
        { session_title: 'sticker-polish', tool_name: 'Read' }, 950),
    mkEvt('bb0002', '~/projects/example_game', 'PreToolUse',
        { session_title: 'sticker-polish', tool_name: 'Edit', tool_input: { file_path: 'fusion_ui.gd' } }, 1200),
    mkEvt('bb0002', '~/projects/example_game', 'PostToolUse',
        { session_title: 'sticker-polish', tool_name: 'Edit' }, 1350),
    // Now running Bash — leave as busy state
    mkEvt('bb0002', '~/projects/example_game', 'PreToolUse',
        { session_title: 'sticker-polish', tool_name: 'Bash', tool_input: { command: 'cd stickerfort && godot --headless --quit-after 3 test_fusion.tscn' } }, 1500),

    // Session B - trading, renamed to "vix-backtest"
    mkEvt('bbbb2222', '~/projects/example_trading', 'SessionStart', { session_title: 'vix-backtest' }, 200),
    mkEvt('bbbb2222', '~/projects/example_trading', 'UserPromptSubmit',
        { session_title: 'vix-backtest', prompt: 'backtest VIX>30 entry with SPXL' }, 600),
    mkEvt('bbbb2222', '~/projects/example_trading', 'PreToolUse',
        { session_title: 'vix-backtest', tool_name: 'WebFetch', tool_input: { url: 'https://cboe.com/vix/historical' } }, 800),
    mkEvt('bbbb2222', '~/projects/example_trading', 'PostToolUse',
        { session_title: 'vix-backtest', tool_name: 'WebFetch' }, 2100),
    mkEvt('bbbb2222', '~/projects/example_trading', 'PreToolUse',
        { session_title: 'vix-backtest', tool_name: 'Bash', tool_input: { command: 'python backtest_vix.py --rule vix_gt_30 --leverage 3x' } }, 2200),
    mkEvt('bbbb2222', '~/projects/example_trading', 'PostToolUse',
        { session_title: 'vix-backtest', tool_name: 'Bash' }, 5800),
    mkEvt('bbbb2222', '~/projects/example_trading', 'Notification',
        { session_title: 'vix-backtest', message: 'Awaiting user input: rule variant to test?' }, 6000),

    // Session C - agents-viz itself, this session (no rename), currently searching files
    mkEvt('cccc3333', '~/projects/agents-viz', 'SessionStart', {}, 400),
    mkEvt('cccc3333', '~/projects/agents-viz', 'UserPromptSubmit',
        { prompt: 'add pixel character avatars to the sidebar' }, 1000),
    mkEvt('cccc3333', '~/projects/agents-viz', 'PreToolUse',
        { tool_name: 'Grep', tool_input: { pattern: 'WEBVIEW_HTML', path: 'extension/src' } }, 1500),
    mkEvt('cccc3333', '~/projects/agents-viz', 'PostToolUse',
        { tool_name: 'Grep' }, 1600),
    mkEvt('cccc3333', '~/projects/agents-viz', 'PreToolUse',
        { tool_name: 'Read', tool_input: { file_path: 'extension/src/extension.ts' } }, 1800),

    // Session D - 90 min stale (sofa in Lounge) — uses bb0002 charIdx=0 (v17c blonde)
    //   to demo the new sit-on-sofa behaviour.
    mkEvt('bb0002b', '~/projects/example_game', 'SessionStart', { session_title: 'sleepy-blonde' }, -90 * 60 * 1000),
    mkEvt('bb0002b', '~/projects/example_game', 'UserPromptSubmit',
        { session_title: 'sleepy-blonde', prompt: 'paused project' }, -90 * 60 * 1000 + 500),
    mkEvt('bb0002b', '~/projects/example_game', 'Stop', { session_title: 'sleepy-blonde' }, -90 * 60 * 1000 + 8000),

    // Session E - 2 days stale (bed in Lounge)
    mkEvt('eeee5555', '~/projects/example_trading', 'SessionStart', { session_title: 'two-day-sleeper' }, -2 * 24 * 60 * 60 * 1000),
    mkEvt('eeee5555', '~/projects/example_trading', 'UserPromptSubmit',
        { session_title: 'two-day-sleeper', prompt: 'check last month PnL' }, -2 * 24 * 60 * 60 * 1000 + 500),
    mkEvt('eeee5555', '~/projects/example_trading', 'Stop', { session_title: 'two-day-sleeper' }, -2 * 24 * 60 * 60 * 1000 + 5000),
];

// Strip mode: per-event, dynamic cell count, last 1h.

// Session #1 — past 1h, one random tool every 5 minutes (12 events total).
// Deterministic pseudo-random so screenshots are reproducible.
const RAND_TOOLS = ['Bash','Read','Edit','Grep','WebFetch','Task','TodoWrite','Write'];
function _rand(seed) { let x = seed * 9301 + 49297; return ((x % 233280) / 233280); }
for (let i = 0; i < 12; i++) {
    const ageMin = 60 - (i + 1) * 5; // i=0 → 55min ago, i=11 → 0min ago
    const tool = RAND_TOOLS[Math.floor(_rand(i + 1) * RAND_TOOLS.length)];
    events.push(mkEvt('ffff6666', '~/projects/example_full', 'PreToolUse',
        { session_title: '5min-cadence', tool_name: tool, tool_input: { file_path: 'demo' } },
        -ageMin * 60 * 1000));
}
// Sticky "live now" event so this card sits at the top of the sidebar.
events.push(mkEvt('ffff6666', '~/projects/example_full', 'PreToolUse',
    { session_title: '5min-cadence', tool_name: 'Bash', tool_input: { command: 'echo live now' } }, 100));

// Session DENSE — 1000 events spread across last 1h, random tools. Verifies dots
// don't break layout at high cardinality (each dot is 2px wide; 1000 dots overlap
// into a density cloud).
for (let i = 0; i < 1000; i++) {
    const ageMs = Math.floor(_rand(i + 100) * 60 * 60 * 1000); // 0..60min ago
    const tool = RAND_TOOLS[Math.floor(_rand(i + 9999) * RAND_TOOLS.length)];
    events.push(mkEvt('dddddense', '~/projects/example_dense', 'PreToolUse',
        { session_title: 'dense-1000', tool_name: tool }, -ageMs));
}

const darkThemeCss = `
<style>
  :root {
    --vscode-foreground: #cccccc;
    --vscode-editor-background: #1e1e1e;
    --vscode-editorWidget-background: #2a2d2e;
    --vscode-panel-border: #3e3e42;
    --vscode-badge-background: #4d4d4d;
    --vscode-badge-foreground: #ffffff;
    --vscode-list-hoverBackground: #2d2d30;
    --vscode-list-activeSelectionBackground: #094771;
    --vscode-list-activeSelectionForeground: #ffffff;
    --vscode-textCodeBlock-background: #0a0a0a;
  }
  body { background: #1e1e1e !important; color: #cccccc !important; }
</style>`;

const AUTO_SELECT = process.env.PREVIEW_SELECTED || '';
const vscodeShim = darkThemeCss + `
<script>
  window.acquireVsCodeApi = function() {
    const state = ${JSON.stringify(AUTO_SELECT)} ? { selected: ${JSON.stringify(AUTO_SELECT)} } : null;
    return {
      getState: () => state,
      setState: () => {},
      postMessage: (m) => console.log('vscode.postMessage', m),
    };
  };
</script>`;

const eventInjection = `
<script>
  window.addEventListener('DOMContentLoaded', () => {
    const events = ${JSON.stringify(events)};
    setTimeout(() => { window.postMessage({ type: 'replay', data: events }, '*'); }, 50);
  });
</script>`;

const out = html.replace('</head>', vscodeShim + '</head>').replace('</body>', eventInjection + '</body>');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out);
console.log('wrote', OUT);
