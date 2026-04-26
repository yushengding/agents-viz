# Agents Viz (extension) — v0 scaffold

Early scaffold for the Agents Viz VS Code extension. See `../DESIGN.md` for the full spec.

## What's wired up so far (v0 Spike)

- [x] Extension skeleton (TypeScript + esbuild)
- [x] Hook forwarder script (`src/hook-forwarder.js`) — silent, 0-token
- [x] HTTP hook server in extension host (auth via Bearer token)
- [x] Discovery file in `~/.agents-viz/{hash}-{pid}.json`
- [x] Auto-configure command to patch `~/.claude/settings.json` with 6 hook events
- [x] Minimal webview: plain event list, color-coded by event type
- [x] Event ring buffer (1000 events in-memory, replay last 50 to new panel)

## Not yet (next sessions)

- [ ] JSONL tail fallback (currently hook-only, so panel-closed events are lost)
- [ ] Vertical Timeline view (tree with subagent nesting, tool args/outputs on click)
- [ ] Sidebar roster with mini activity strips
- [ ] Project rooms / pixel characters / tablet metaphor (v2)

## Dev workflow (hot-reload)

**One-time setup:**
```bash
cd extension
npm install
npm run install-link   # junction from ~/.vscode/extensions/ysding.agents-viz-0.0.1 → this dir
```

**Iteration loop:**
```bash
npm run watch          # auto-rebuild on src/*.ts save
```

Then in any VS Code window: edit `src/*.ts` → esbuild rebuilds `dist/extension.js` → `Ctrl+R` (`Developer: Reload Window`) → new code live. No `vsce package` + reinstall cycle.

**Preview the webview without VS Code** (fastest iteration for UI):
```bash
npm run preview:open   # exports preview.html with mock events + opens in Chrome
```

**Smoke-test the hook forwarder:**
```bash
npm run smoke          # 18 assertions covering forwarder + mock HTTP server
```

**First run in VS Code:**
1. `Ctrl+Alt+V` (or command palette → `Agents Viz: Open Panel`) opens the webview
2. Command palette → `Agents Viz: Configure Claude Code Hooks` — patches `~/.claude/settings.json`
3. Restart any running Claude Code session (required for new hooks to apply)
4. Use Claude Code — events appear in the panel

## Files

```
extension/
├── package.json            VS Code extension manifest
├── tsconfig.json
├── esbuild.js              bundler
├── src/
│   ├── extension.ts        activate / webview / HTTP server / auto-configure
│   └── hook-forwarder.js   standalone script Claude Code invokes as hook
└── dist/                   (generated) extension.js + hooks/hook-forwarder.js
```

## Credits

- Hook forwarder adapted from [Agent Flow](https://github.com/patoles/agent-flow) (Apache-2.0) and [Pixel Agents](https://github.com/pablodelucca/pixel-agents) (MIT).
- Full vendor source checked into `../vendor/` for reference.
