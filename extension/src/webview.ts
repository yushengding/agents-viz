// webview.ts — thin wrapper that reads HTML template from disk each call.
// This enables true hot-reload: edit extension/webview.html → save → panel refreshes.
// The HTML is NOT bundled into extension.js; each panel rebuild re-reads the file.

import * as fs from 'fs';
import * as path from 'path';

export interface BuildOpts {
    spriteUris: string[];
    roomImages?: Record<string, string>;
    extensionPath: string;  // context.extensionPath
    sofaFront?: string;
    sofaSide?: string;
    sessionUsage?: Record<string, {
        input: number; output: number; cacheCreate: number; cacheRead: number;
        cost: number; models: string[]; msgCount: number;
    }>;
    promptCosts?: Array<{
        sessionId: string; promptText: string; promptTs: number;
        cost: number; tokens: number; cwd?: string;
    }>;
}

export function buildWebviewHtml(opts: BuildOpts): string {
    const htmlFile = path.join(opts.extensionPath, 'webview.html');
    let html: string;
    try {
        html = fs.readFileSync(htmlFile, 'utf8');
    } catch (e: any) {
        return `<!DOCTYPE html><body><pre>webview.html missing at ${htmlFile}: ${e.message}</pre></body></html>`;
    }
    const buildStamp = new Date().toTimeString().slice(0, 8);
    // Use regex /g so EVERY occurrence is replaced. (Single-token .replace only swaps
    // the first match — bit me when SESSION_USAGE/PROMPT_COSTS appear twice on the
    // same line: typeof check + actual value branch.)
    return html
        .replace(/__SPRITE_URIS__/g, JSON.stringify(opts.spriteUris))
        .replace(/__ROOM_IMAGES__/g, JSON.stringify(opts.roomImages || {}))
        .replace(/__BUILD_STAMP__/g, buildStamp)
        .replace(/__SOFA_FRONT__/g, opts.sofaFront || '')
        .replace(/__SOFA_SIDE__/g, opts.sofaSide || '')
        .replace(/__SESSION_USAGE__/g, JSON.stringify(opts.sessionUsage || {}))
        .replace(/__PROMPT_COSTS__/g, JSON.stringify(opts.promptCosts || []));
}

/** Return the absolute path of the webview HTML template so it can be watched. */
export function webviewHtmlPath(extensionPath: string): string {
    return path.join(extensionPath, 'webview.html');
}
