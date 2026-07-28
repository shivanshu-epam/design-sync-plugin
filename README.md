# Design Sync — Figma plugin

Bidirectional sync between Figma **Styles** (color, text, effect) plus a
custom "dimension" token set, and a JSON design-tokens file in a GitHub
repository. This folder is the Figma plugin only — the rest of the platform
described in the product doc (a standalone orchestration backend, Storybook
CI, audit database, etc.) is out of scope here and would live in separate
services/repos.

## Token sources: Styles + Variables

| Token category | Figma source |
|---|---|
| `color` | Paint styles (single solid fill only, in this MVP) **+** COLOR variables from every local variable collection |
| `typography` | Text styles |
| `shadow` | Effect styles (drop/inner shadow layers) |
| `dimension` | Manually-entered custom tokens (stored as a JSON blob in the file's shared plugin data, edited from the **Custom Tokens** tab) **+** FLOAT variables from every local variable collection |

Style names/variable names become the token key directly (e.g.
`primary/blue` for a style, `Semantic/Light/surface/primary` for a
multi-mode variable — collection name, then mode name if the collection has
more than one mode, then the variable's own name). Whatever naming/folder
convention you use in Figma is what ends up in the repo.

Reading **local** variables via the plugin API (`figma.variables.getLocalVariableCollectionsAsync`/
`getLocalVariablesAsync`) works regardless of the *viewer's* own Figma
plan — it's gated by the file/team's plan, not yours, and it degrades
gracefully (just contributes nothing, not an error) if variables genuinely
aren't available. Only STRING and BOOLEAN variables are skipped in this
MVP; COLOR and FLOAT are read, including resolving `VARIABLE_ALIAS` chains
to their concrete value.

**Current asymmetry**: variables are only read *from* Figma (Figma → GitHub
→ Storybook). Pulling a GitHub-only addition back into Figma (the
"Sync" tab's GitHub→Figma direction) still creates/updates a Paint or
Effect *style*, not an actual variable — writing real Figma Variables back
(with collections/modes) isn't implemented yet.

## What it does today

- **Connect** tab — GitHub owner/repo/branch/file path + a personal access
  token, stored locally via `figma.clientStorage` (never sent anywhere
  except `api.github.com`).
- **Custom Tokens** tab — key/value editor for dimension tokens (spacing,
  radii, etc.), persisted in the Figma file itself.
- **Sync** tab — fetches current Figma tokens and the GitHub JSON file,
  diffs them per key (added in Figma / added in GitHub / conflicting), and
  requires an explicit resolution (Use Figma / Use GitHub / Skip) for every
  conflict before the "Sync" button unlocks. Syncing commits the merged
  token set to GitHub and applies the GitHub-side changes back onto the
  Figma styles in one action, so both ends converge.
- Last few sync commits are listed on the Connect tab as a lightweight
  history/audit trail.

Out of scope for this MVP: multi-file/multi-brand support, PR-based review
flow (it commits directly to the configured branch), rollback UI, and the
Storybook/GitHub Actions leg — that's a normal CI job in the design-system
repo that rebuilds Storybook whenever `design-tokens.json` changes; nothing
for the plugin to do there.

## Setup

```bash
npm install
```

Get the Figma plugin type definitions (already listed in
`devDependencies`, `npm install` handles this):

```bash
npm install --save-dev @figma/plugin-typings
```

Build:

```bash
npm run build
```

This runs two independent build steps:

- `build:main` — type-checks `code.ts`, then bundles it (and `shared/`)
  with esbuild → `code.js`. Figma loads `code.js` as a plain script, not a
  module, so it must be a single self-contained file with no `import`
  statements left in it — plain `tsc` can't do that on its own since it
  compiles each file independently, it doesn't bundle.
- `build:ui` — same idea for `ui.ts`: type-check, bundle with esbuild, then
  inline the bundle into `ui.template.html` → `ui.html` (the plugin UI
  iframe), since Figma also requires the UI to be one self-contained HTML
  file.

Both `code.js` and `ui.html` are generated artifacts, just like a normal
`tsc` output file — don't hand-edit them. Edit `code.ts`, `ui.ts`,
`shared/tokens.ts`, or `ui.template.html` (markup/CSS) instead.

While developing, run both watchers (two terminals is more reliable than
the combined `npm run watch`, which backgrounds one of them):

```bash
npm run watch:main
npm run watch:ui
```

Then in the Figma desktop app: **Plugins → Development → Import plugin
from manifest…** and select `manifest.json` in this folder.

## Architecture

```
ui.ts (UI iframe — has network access)
  ├─ GitHub REST API (contents endpoint: read/commit design-tokens.json)
  ├─ diff engine (per-key add/modify/delete across categories)
  ├─ conflict resolution UI
  └─ postMessage ↔ code.ts

code.ts (Figma sandbox — has document access, no network)
  ├─ reads Paint/Text/Effect styles + local Variables (COLOR/FLOAT) → TokenSet
  ├─ writes TokenSet → creates/updates Paint/Text/Effect styles (not variables yet)
  ├─ dimension tokens ↔ figma.root shared plugin data
  └─ settings/history ↔ figma.clientStorage

shared/tokens.ts — token model + postMessage protocol types, imported by both
```

## GitHub token

Use a fine-grained personal access token scoped to just the design-system
repo, with **Contents: Read and write** permission. It's stored locally on
your machine (Figma's `clientStorage`) and only ever sent to
`api.github.com` (the only domain this plugin is allowed to reach, per
`manifest.json`).
