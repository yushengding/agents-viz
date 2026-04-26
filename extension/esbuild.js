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

    // Copy hook forwarder to dist/ so it can be installed to ~/.agents-viz/
    fs.mkdirSync('dist/hooks', { recursive: true });
    fs.copyFileSync('src/hook-forwarder.js', 'dist/hooks/hook-forwarder.js');
    console.log('[build] hook forwarder copied');

    // Note: webview.html is NOT bundled — it's read at runtime from extension/webview.html
    // This enables hot-reload without extension host restart. esbuild build doesn't touch it.

    await ctx.dispose();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
