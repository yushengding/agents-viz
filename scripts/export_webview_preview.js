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
html = html.replace('__BUILD_STAMP__', new Date().toTimeString().slice(0, 8));
html = html.replace('__ROOM_IMAGES__', '{}');
html = html.replace('__SOFA_FRONT__', '');
html = html.replace('__SOFA_SIDE__', '');

// For preview, embed sprite images as base64 data URIs so Chrome can show them without localResourceRoots
const sprites = [];
for (let i = 0; i < 6; i++) {
    const p = path.join(SPRITES_DIR, `char_${i}.png`);
    if (fs.existsSync(p)) {
        const b64 = fs.readFileSync(p).toString('base64');
        sprites.push('data:image/png;base64,' + b64);
    } else {
        sprites.push('');
    }
}
html = html.replace('__SPRITE_URIS__', JSON.stringify(sprites));
html = html.replace('__SESSION_USAGE__', JSON.stringify({
    aaaa1111: { input: 12000, output: 4000, cacheCreate: 8000, cacheRead: 100000, cost: 1.42, models: ['claude-opus-4-7'], msgCount: 38 },
    bbbb2222: { input: 8000, output: 3500, cacheCreate: 4000, cacheRead: 60000, cost: 0.78, models: ['claude-opus-4-7'], msgCount: 22 },
    cccc3333: { input: 5000, output: 1500, cacheCreate: 2000, cacheRead: 25000, cost: 0.21, models: ['claude-opus-4-7'], msgCount: 9 },
    dddd4444: { input: 800, output: 200, cacheCreate: 0, cacheRead: 0, cost: 0.03, models: [], msgCount: 1 },
    eeee5555: { input: 1500, output: 600, cacheCreate: 1000, cacheRead: 12000, cost: 0.18, models: [], msgCount: 4 },
}));
html = html.replace('__PROMPT_COSTS__', JSON.stringify([
    { sessionId: 'aaaa1111', promptText: 'tweak fusion UI legibility on mobile', promptTs: now - 1000, cost: 0.42, tokens: 18000, cwd: 'C:/Users/redacted/Desktop/projects/stickerfort_clean' },
    { sessionId: 'bbbb2222', promptText: 'backtest VIX>30 entry with SPXL', promptTs: now - 2000, cost: 0.31, tokens: 12000, cwd: 'C:/Users/redacted/Desktop/projects/trading' },
    { sessionId: 'cccc3333', promptText: 'add pixel character avatars to the sidebar', promptTs: now - 3000, cost: 0.08, tokens: 4000, cwd: 'C:/Users/redacted/Desktop/projects/agents-viz' },
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
    mkEvt('aaaa1111', 'C:/Users/redacted/Desktop/projects/stickerfort_clean', 'SessionStart', { session_title: 'sticker-polish' }, 0),
    mkEvt('aaaa1111', 'C:/Users/redacted/Desktop/projects/stickerfort_clean', 'UserPromptSubmit',
        { session_title: 'sticker-polish', prompt: 'tweak fusion UI legibility on mobile' }, 500),
    mkEvt('aaaa1111', 'C:/Users/redacted/Desktop/projects/stickerfort_clean', 'PreToolUse',
        { session_title: 'sticker-polish', tool_name: 'Read', tool_input: { file_path: 'stickerfort/scripts/fusion_ui.gd' } }, 900),
    mkEvt('aaaa1111', 'C:/Users/redacted/Desktop/projects/stickerfort_clean', 'PostToolUse',
        { session_title: 'sticker-polish', tool_name: 'Read' }, 950),
    mkEvt('aaaa1111', 'C:/Users/redacted/Desktop/projects/stickerfort_clean', 'PreToolUse',
        { session_title: 'sticker-polish', tool_name: 'Edit', tool_input: { file_path: 'fusion_ui.gd' } }, 1200),
    mkEvt('aaaa1111', 'C:/Users/redacted/Desktop/projects/stickerfort_clean', 'PostToolUse',
        { session_title: 'sticker-polish', tool_name: 'Edit' }, 1350),
    // Now running Bash — leave as busy state
    mkEvt('aaaa1111', 'C:/Users/redacted/Desktop/projects/stickerfort_clean', 'PreToolUse',
        { session_title: 'sticker-polish', tool_name: 'Bash', tool_input: { command: 'cd stickerfort && godot --headless --quit-after 3 test_fusion.tscn' } }, 1500),

    // Session B - trading, renamed to "vix-backtest"
    mkEvt('bbbb2222', 'C:/Users/redacted/Desktop/projects/trading', 'SessionStart', { session_title: 'vix-backtest' }, 200),
    mkEvt('bbbb2222', 'C:/Users/redacted/Desktop/projects/trading', 'UserPromptSubmit',
        { session_title: 'vix-backtest', prompt: 'backtest VIX>30 entry with SPXL' }, 600),
    mkEvt('bbbb2222', 'C:/Users/redacted/Desktop/projects/trading', 'PreToolUse',
        { session_title: 'vix-backtest', tool_name: 'WebFetch', tool_input: { url: 'https://cboe.com/vix/historical' } }, 800),
    mkEvt('bbbb2222', 'C:/Users/redacted/Desktop/projects/trading', 'PostToolUse',
        { session_title: 'vix-backtest', tool_name: 'WebFetch' }, 2100),
    mkEvt('bbbb2222', 'C:/Users/redacted/Desktop/projects/trading', 'PreToolUse',
        { session_title: 'vix-backtest', tool_name: 'Bash', tool_input: { command: 'python backtest_vix.py --rule vix_gt_30 --leverage 3x' } }, 2200),
    mkEvt('bbbb2222', 'C:/Users/redacted/Desktop/projects/trading', 'PostToolUse',
        { session_title: 'vix-backtest', tool_name: 'Bash' }, 5800),
    mkEvt('bbbb2222', 'C:/Users/redacted/Desktop/projects/trading', 'Notification',
        { session_title: 'vix-backtest', message: 'Awaiting user input: rule variant to test?' }, 6000),

    // Session C - agents-viz itself, this session (no rename), currently searching files
    mkEvt('cccc3333', 'C:/Users/redacted/Desktop/projects/agents-viz', 'SessionStart', {}, 400),
    mkEvt('cccc3333', 'C:/Users/redacted/Desktop/projects/agents-viz', 'UserPromptSubmit',
        { prompt: 'add pixel character avatars to the sidebar' }, 1000),
    mkEvt('cccc3333', 'C:/Users/redacted/Desktop/projects/agents-viz', 'PreToolUse',
        { tool_name: 'Grep', tool_input: { pattern: 'WEBVIEW_HTML', path: 'extension/src' } }, 1500),
    mkEvt('cccc3333', 'C:/Users/redacted/Desktop/projects/agents-viz', 'PostToolUse',
        { tool_name: 'Grep' }, 1600),
    mkEvt('cccc3333', 'C:/Users/redacted/Desktop/projects/agents-viz', 'PreToolUse',
        { tool_name: 'Read', tool_input: { file_path: 'extension/src/extension.ts' } }, 1800),

    // Session D - 10 min stale (sofa in Lounge)
    mkEvt('dddd4444', 'C:/Users/redacted/Desktop/projects/stickerfort_clean', 'SessionStart', { session_title: 'old-explore' }, -10 * 60 * 1000),
    mkEvt('dddd4444', 'C:/Users/redacted/Desktop/projects/stickerfort_clean', 'UserPromptSubmit',
        { session_title: 'old-explore', prompt: 'what is in this project' }, -10 * 60 * 1000 + 500),
    mkEvt('dddd4444', 'C:/Users/redacted/Desktop/projects/stickerfort_clean', 'Stop', { session_title: 'old-explore' }, -10 * 60 * 1000 + 8000),

    // Session E - 2 days stale (bed in Lounge)
    mkEvt('eeee5555', 'C:/Users/redacted/Desktop/projects/trading', 'SessionStart', { session_title: 'two-day-sleeper' }, -2 * 24 * 60 * 60 * 1000),
    mkEvt('eeee5555', 'C:/Users/redacted/Desktop/projects/trading', 'UserPromptSubmit',
        { session_title: 'two-day-sleeper', prompt: 'check last month PnL' }, -2 * 24 * 60 * 60 * 1000 + 500),
    mkEvt('eeee5555', 'C:/Users/redacted/Desktop/projects/trading', 'Stop', { session_title: 'two-day-sleeper' }, -2 * 24 * 60 * 60 * 1000 + 5000),
];

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
