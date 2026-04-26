// smoke.js — end-to-end validation of the hook forwarder
// 1. spin up mock HTTP server
// 2. write discovery file with port + token + workspace
// 3. spawn hook-forwarder with fake event JSON on stdin
// 4. assert POST arrived with correct path, body, auth, within timeout
// 5. repeat for workspace mismatch (should be silently dropped)
// 6. cleanup

'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DIR = path.join(os.homedir(), '.agents-viz');
const FORWARDER = path.join(__dirname, '..', 'dist', 'hooks', 'hook-forwarder.js');
const WORKSPACE = process.cwd();
const TEST_PID = 99999999; // fake pid that isAlive() treats as alive on Windows

let received = [];
let server;
let discoveryPath;
let token = 'test-token-' + Math.random().toString(36).slice(2);

function startServer() {
    return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                received.push({
                    method: req.method,
                    url: req.url,
                    auth: req.headers['authorization'],
                    body: JSON.parse(body || '{}'),
                });
                res.writeHead(200); res.end('{"ok":true}');
            });
        });
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
        server.on('error', reject);
    });
}

function writeDiscovery(port, workspace) {
    fs.mkdirSync(DIR, { recursive: true });
    discoveryPath = path.join(DIR, `smoke-test-${TEST_PID}.json`);
    fs.writeFileSync(discoveryPath, JSON.stringify({
        port, pid: TEST_PID, token, workspace,
    }));
}

function runForwarder(stdinPayload) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [FORWARDER], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', c => stdout += c);
        child.stderr.on('data', c => stderr += c);
        child.stdin.write(JSON.stringify(stdinPayload));
        child.stdin.end();
        child.on('exit', code => resolve({ code, stdout, stderr }));
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function assert(name, cond, detail = '') {
    if (cond) {
        console.log(`  PASS  ${name}${detail ? ': ' + detail : ''}`);
    } else {
        console.log(`  FAIL  ${name}${detail ? ': ' + detail : ''}`);
        process.exitCode = 1;
    }
}

async function main() {
    console.log('[smoke] forwarder:', FORWARDER);
    if (!fs.existsSync(FORWARDER)) {
        console.error('FAIL: forwarder not built. run `npm run compile` first.');
        process.exit(1);
    }

    console.log('[smoke] starting mock HTTP server...');
    const port = await startServer();
    console.log(`[smoke] server on :${port}`);

    // --- Test 1: workspace matches → hook should forward ---
    console.log('\n[TEST 1] cwd matches workspace → forward expected');
    writeDiscovery(port, WORKSPACE);
    received = [];
    const r1 = await runForwarder({
        cwd: WORKSPACE,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo hello' },
    });
    await sleep(150);
    await assert('forwarder exited cleanly', r1.code === 0, `exit=${r1.code}`);
    await assert('no stdout leak', r1.stdout === '', r1.stdout ? `got: ${r1.stdout.slice(0,100)}` : '');
    await assert('no stderr leak', r1.stderr === '', r1.stderr ? `got: ${r1.stderr.slice(0,200)}` : '');
    await assert('HTTP POST received', received.length === 1, `count=${received.length}`);
    if (received[0]) {
        await assert('correct path', received[0].url === '/api/hooks/claude', received[0].url);
        await assert('correct method', received[0].method === 'POST');
        await assert('bearer token present', received[0].auth === `Bearer ${token}`, received[0].auth);
        await assert('payload preserved', received[0].body.tool_name === 'Bash');
        await assert('hook_event_name relayed', received[0].body.hook_event_name === 'PreToolUse');
    }

    // --- Test 2: workspace mismatch → hook should drop silently ---
    console.log('\n[TEST 2] cwd does NOT match → no forward expected');
    fs.writeFileSync(discoveryPath, JSON.stringify({
        port, pid: TEST_PID, token, workspace: path.join(os.tmpdir(), 'completely-different-ws'),
    }));
    received = [];
    const r2 = await runForwarder({
        cwd: WORKSPACE,
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
    });
    await sleep(150);
    await assert('forwarder exited cleanly (mismatch)', r2.code === 0);
    await assert('no POST on mismatch', received.length === 0, `got ${received.length}`);

    // --- Test 3: missing cwd → forwarder should exit 0 without trying ---
    console.log('\n[TEST 3] missing cwd in payload → no-op expected');
    received = [];
    const r3 = await runForwarder({ hook_event_name: 'SessionStart' });
    await sleep(100);
    await assert('exit on missing cwd', r3.code === 0);
    await assert('no POST on missing cwd', received.length === 0);

    // --- Test 4: no discovery file → forwarder should no-op ---
    console.log('\n[TEST 4] no matching discovery → no-op expected');
    fs.unlinkSync(discoveryPath);
    received = [];
    const r4 = await runForwarder({
        cwd: WORKSPACE,
        hook_event_name: 'PostToolUse',
    });
    await sleep(100);
    await assert('exit with no discovery', r4.code === 0);
    await assert('no POST without discovery', received.length === 0);

    // --- Test 5: hard exit deadline — run with slow/unreachable server ---
    console.log('\n[TEST 5] unreachable port → forwarder exits within 1.6s');
    writeDiscovery(65500, WORKSPACE); // closed port
    received = [];
    const t0 = Date.now();
    const r5 = await runForwarder({ cwd: WORKSPACE, hook_event_name: 'Stop' });
    const dt = Date.now() - t0;
    await assert('exit within 1.8s even when unreachable', dt < 1800, `actual=${dt}ms`);
    await assert('exit code 0', r5.code === 0);

    // cleanup
    try { fs.unlinkSync(discoveryPath); } catch {}
    server.close();

    const failed = process.exitCode === 1;
    console.log(`\n[smoke] ${failed ? 'FAILED' : 'PASSED'}`);
}

main().catch(e => { console.error('smoke error:', e); process.exit(1); });
