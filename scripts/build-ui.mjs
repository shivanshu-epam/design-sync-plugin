#!/usr/bin/env node
// Bundles ui.ts (+ shared/) into a single inline <script> and injects it
// into ui.template.html to produce ui.html — Figma requires the plugin UI
// to be one self-contained HTML file, so it can't load ui.ts separately.
import { build, context } from 'esbuild';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const watch = process.argv.includes('--watch');

// package.json's "version" is the single source of truth for the footer —
// no separate version string to keep in sync by hand.
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

function writeHtml(jsCode) {
  const template = readFileSync(path.join(root, 'ui.template.html'), 'utf8');
  const html = template
    .replace('<!--DESIGN_SYNC_SCRIPT-->', `<script>\n${jsCode}\n</script>`)
    .replace('<!--APP_VERSION-->', version);
  writeFileSync(path.join(root, 'ui.html'), html);
}

const options = {
  entryPoints: [path.join(root, 'ui.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  target: 'es2020',
  logLevel: 'info',
};

if (watch) {
  const ctx = await context({
    ...options,
    plugins: [
      {
        name: 'inline-html',
        setup(b) {
          b.onEnd((result) => {
            if (result.errors.length === 0 && result.outputFiles) {
              writeHtml(result.outputFiles[0].text);
              console.log(`[build-ui] ui.html updated at ${new Date().toLocaleTimeString()}`);
            }
          });
        },
      },
    ],
  });
  await ctx.watch();
  console.log('[build-ui] watching for changes…');
} else {
  const result = await build(options);
  writeHtml(result.outputFiles[0].text);
  console.log('[build-ui] ui.html written.');
}
