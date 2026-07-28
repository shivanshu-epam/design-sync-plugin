#!/usr/bin/env node
// Bundles code.ts (+ shared/) into a single script -> code.js. Figma loads
// code.js as a plain script (no module system), so any `import`/`export`
// left in the output is a syntax error at load time — this must produce one
// self-contained file, same reasoning as scripts/build-ui.mjs for the UI.
import { build, context } from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: [path.join(root, 'code.ts')],
  bundle: true,
  outfile: path.join(root, 'code.js'),
  format: 'iife',
  target: 'es2020',
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[build-main] watching for changes…');
} else {
  await build(options);
  console.log('[build-main] code.js written.');
}
