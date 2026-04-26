#!/usr/bin/env node
// install_link.js — replace installed extension dir with a symlink/junction to the
// dev extension/ dir. Combined with `npm run watch`, edits hot-reload via Ctrl+R
// in the VS Code window (no vsce package → vsce install cycle).
//
// Windows requires admin OR Developer Mode for symlinks; we fall back to mklink /J (junction)
// which does not require privilege and works for directories.

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const pkg = require(path.join(__dirname, '..', 'extension', 'package.json'));
const publisher = pkg.publisher; // "ysding"
const name = pkg.name;           // "agents-viz"
const version = pkg.version;     // "0.0.1"

const EXT_ID = publisher + '.' + name;
const VERSIONED = EXT_ID + '-' + version;
const EXT_HOME = path.join(os.homedir(), '.vscode', 'extensions');
const TARGET = path.join(EXT_HOME, VERSIONED);
const SRC = path.resolve(__dirname, '..', 'extension');

if (!fs.existsSync(EXT_HOME)) {
    console.error('VS Code extensions dir not found:', EXT_HOME);
    process.exit(1);
}

console.log('target:', TARGET);
console.log('src:   ', SRC);

// If target exists and is a real dir (not a link), back up first
if (fs.existsSync(TARGET)) {
    const st = fs.lstatSync(TARGET);
    if (st.isSymbolicLink() || st.isDirectory() && isJunction(TARGET)) {
        fs.rmSync(TARGET, { force: true });
        console.log('removed existing link');
    } else if (st.isDirectory()) {
        const backup = TARGET + '.bak.' + Date.now();
        fs.renameSync(TARGET, backup);
        console.log('backed up real dir to:', backup);
    }
}

// Create junction (Windows) — does NOT require admin
if (process.platform === 'win32') {
    try {
        execSync(`cmd /c mklink /J "${TARGET}" "${SRC}"`, { stdio: 'inherit' });
        console.log('\nJunction created.');
    } catch (e) {
        console.error('mklink failed:', e.message);
        process.exit(1);
    }
} else {
    fs.symlinkSync(SRC, TARGET, 'dir');
    console.log('symlink created');
}

console.log('\nNext steps:');
console.log('  1) npm run watch      (in extension/ dir — auto-rebuild on save)');
console.log('  2) in VS Code: Developer: Reload Window (Ctrl+R in each window) to pick up new build');
console.log('  3) edit src/*.ts → watcher rebuilds dist/ → reload window → new code live');

function isJunction(p) {
    // On Windows, junctions show as directory but have FILE_ATTRIBUTE_REPARSE_POINT
    // Node doesn't expose it directly — we detect by trying readlink which succeeds on junctions
    try { fs.readlinkSync(p); return true; } catch { return false; }
}
