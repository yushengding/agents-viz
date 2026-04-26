#!/usr/bin/env node
// configure_hooks.js — standalone version of the extension's "Configure Claude Code Hooks"
// command. Patches ~/.claude/settings.json to add agents-viz silent forwarder to all 6 events.
// Idempotent: skips events that already have an agents-viz entry.

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification'];
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK_PATH = path.join(os.homedir(), 'Desktop', 'projects', 'agents-viz', 'extension', 'dist', 'hooks', 'hook-forwarder.js');

if (!fs.existsSync(HOOK_PATH)) {
    console.error('hook-forwarder.js not built. run `npm run compile` in extension/');
    process.exit(1);
}

const nodeExe = process.platform === 'win32' ? '"C:\\Program Files\\nodejs\\node.exe"' : 'node';
const cmd = `${nodeExe} "${HOOK_PATH}"`;

let settings = {};
if (fs.existsSync(CLAUDE_SETTINGS)) {
    try { settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')); }
    catch (e) { console.error('failed to parse settings.json:', e.message); process.exit(1); }
}
settings.hooks = settings.hooks || {};

let added = 0;
let skipped = 0;
for (const eventName of HOOK_EVENTS) {
    settings.hooks[eventName] = settings.hooks[eventName] || [];
    const existing = settings.hooks[eventName];
    const alreadyHas = existing.some(entry =>
        entry.hooks && entry.hooks.some(h => h.command && h.command.includes('agents-viz'))
    );
    if (alreadyHas) {
        console.log(`  ${eventName}: already configured, skip`);
        skipped++;
        continue;
    }
    existing.push({
        hooks: [{ type: 'command', command: cmd, timeout: 2 }]
    });
    console.log(`  ${eventName}: added`);
    added++;
}

fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
console.log(`\nDone. added=${added} skipped=${skipped}  settings=${CLAUDE_SETTINGS}`);
