const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'warning',
  });

  if (watch) {
    await ctx.watch();
    console.log('[watch] built, watching for changes...');
  } else {
    await ctx.rebuild();
    console.log('[build] extension.js written');

    // Copy hook forwarder + inbox reader to dist/ so they can be installed
    // to ~/.claude/settings.json from a stable absolute path.
    fs.mkdirSync('dist/hooks', { recursive: true });
    fs.copyFileSync('src/hook-forwarder.js', 'dist/hooks/hook-forwarder.js');
    fs.copyFileSync('src/inbox-reader-hook.js', 'dist/hooks/inbox-reader-hook.js');
    console.log('[build] hook forwarder + inbox reader copied');

    // Note: webview.html is NOT bundled — it's read at runtime from extension/webview.html
    // This enables hot-reload without extension host restart. esbuild build doesn't touch it.

    await ctx.dispose();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
