#!/usr/bin/env node
// configure_hooks.js — standalone version of the extension's "Configure Claude Code Hooks"
// command. Patches ~/.claude/settings.json to add agents-viz silent forwarder to all
// session + team hook events, and (optionally) the inbox-reader hook for bidirectional
// reply via UserPromptSubmit.
//
// Idempotent: skips events that already have a matching agents-viz entry.
//
// Usage:
//   node scripts/configure_hooks.js                  # forwarder only
//   node scripts/configure_hooks.js --with-inbox     # also install inbox-reader hook
//   node scripts/configure_hooks.js --no-team        # skip the 3 team hooks
//   node scripts/configure_hooks.js --uninstall      # remove every agents-viz entry

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Session-scoped events (existing). Carry a per-session cwd → routed by workspace.
const SESSION_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification'];
// Team-scoped events (Claude Code Teams Feb 2026 experimental). Broadcast to all
// alive panels — no cwd routing.
const TEAM_EVENTS = ['TeammateIdle', 'TaskCreated', 'TaskCompleted'];

const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const FORWARDER_PATH = path.join(os.homedir(), 'Desktop', 'projects', 'agents-viz', 'extension', 'dist', 'hooks', 'hook-forwarder.js');
const INBOX_READER_PATH = path.join(os.homedir(), 'Desktop', 'projects', 'agents-viz', 'extension', 'dist', 'hooks', 'inbox-reader-hook.js');

const args = process.argv.slice(2);
const withInbox = args.includes('--with-inbox');
const skipTeam = args.includes('--no-team');
const uninstall = args.includes('--uninstall');

const nodeExe = process.platform === 'win32' ? '"C:\\Program Files\\nodejs\\node.exe"' : 'node';
const forwarderCmd = `${nodeExe} "${FORWARDER_PATH}"`;
const inboxReaderCmd = `${nodeExe} "${INBOX_READER_PATH}"`;

if (!uninstall) {
    if (!fs.existsSync(FORWARDER_PATH)) {
        console.error('hook-forwarder.js not built at ' + FORWARDER_PATH);
        console.error('run `npm run compile` in extension/');
        process.exit(1);
    }
    if (withInbox && !fs.existsSync(INBOX_READER_PATH)) {
        console.error('inbox-reader-hook.js not built at ' + INBOX_READER_PATH);
        console.error('run `npm run compile` in extension/');
        process.exit(1);
    }
}

let settings = {};
if (fs.existsSync(CLAUDE_SETTINGS)) {
    try { settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')); }
    catch (e) { console.error('failed to parse settings.json:', e.message); process.exit(1); }
}
settings.hooks = settings.hooks || {};

// --- helpers ----------------------------------------------------------------

/** Match an agents-viz hook entry by SPECIFIC script path (forwarder vs inbox-reader),
 *  not just by the substring "agents-viz" — otherwise we conflate the two when both
 *  live under the same agents-viz/ directory. */
function entryMatches(entry, scriptBasename) {
    if (!entry || !entry.hooks) return false;
    return entry.hooks.some(h => h.command && h.command.includes(scriptBasename));
}

function addHook(eventName, cmd, scriptBasename) {
    settings.hooks[eventName] = settings.hooks[eventName] || [];
    const existing = settings.hooks[eventName];
    if (existing.some(e => entryMatches(e, scriptBasename))) {
        console.log(`  ${eventName} (${scriptBasename}): already configured, skip`);
        return false;
    }
    existing.push({ hooks: [{ type: 'command', command: cmd, timeout: 2 }] });
    console.log(`  ${eventName} (${scriptBasename}): added`);
    return true;
}

function removeHook(eventName, scriptBasename) {
    if (!settings.hooks[eventName]) return 0;
    const before = settings.hooks[eventName].length;
    settings.hooks[eventName] = settings.hooks[eventName].filter(e => !entryMatches(e, scriptBasename));
    const removed = before - settings.hooks[eventName].length;
    if (removed) console.log(`  ${eventName} (${scriptBasename}): removed ${removed}`);
    return removed;
}

// --- run --------------------------------------------------------------------

let added = 0, removed = 0;

if (uninstall) {
    for (const ev of SESSION_EVENTS) removed += removeHook(ev, 'hook-forwarder.js');
    for (const ev of TEAM_EVENTS)    removed += removeHook(ev, 'hook-forwarder.js');
    removed += removeHook('UserPromptSubmit', 'inbox-reader-hook.js');
} else {
    for (const ev of SESSION_EVENTS) if (addHook(ev, forwarderCmd, 'hook-forwarder.js')) added++;
    if (!skipTeam) {
        for (const ev of TEAM_EVENTS) if (addHook(ev, forwarderCmd, 'hook-forwarder.js')) added++;
    }
    if (withInbox) {
        if (addHook('UserPromptSubmit', inboxReaderCmd, 'inbox-reader-hook.js')) added++;
    }
}

fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
console.log(`\nDone. ${uninstall ? 'removed' : 'added'}=${uninstall ? removed : added}  settings=${CLAUDE_SETTINGS}`);
if (!uninstall && !skipTeam) console.log('Team hooks installed: TeammateIdle, TaskCreated, TaskCompleted (Claude Code Teams Feb 2026 experimental).');
if (!uninstall && withInbox) console.log('Inbox-reader hook installed. Drop messages into ~/.agents-viz/inbox/{team}/{teammate}.json — they will be injected on the next UserPromptSubmit.');
