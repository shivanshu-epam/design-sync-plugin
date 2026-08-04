# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/); versioning
follows [Semantic Versioning](https://semver.org/).

This project has no Android/iOS build, so there is no `versionCode` /
build-number tracking — `package.json`'s `version` field is the single
source of truth, and it's what the plugin's footer displays (baked in at
build time).

## [1.2.0] - 2026-08-04

### Changed
- **Breaking: Sync no longer commits directly to the configured branch.**
  It now creates a branch, commits the merged token set there, and opens
  a pull request against the configured branch instead (a review gate —
  see PROJECT.md §7/§10 bug #9). Figma is still updated immediately, since
  it's a local design file, not the shared repo the gate protects; GitHub
  only catches up once the PR is merged.
- `SyncHistoryEntry` now records `{ prNumber, prUrl, branch }` instead of
  `{ commitSha, commitUrl }`. Sync history stored in `figma.clientStorage`
  from before this version won't render correctly in the Connect tab's
  history list — it's local/cosmetic only, so no migration was written.
- Personal access token guidance now also requires `Pull requests:
  read/write` (in addition to `Contents: read/write` and `Actions:
  read/write`), since Sync opens a PR rather than committing directly.
- "Sync" button relabeled "Sync (open PR & update Figma)" with a tooltip
  explaining the split (Figma updates immediately, GitHub via PR).

### Added
- **Status tab** — a banner showing the most recent sync's pull request
  if it's still open ("pending review — the diff below won't resolve
  until it's merged, that's expected") or was closed without merging.
  `runCompare()` now also polls that PR's state as part of every refresh.

## [1.1.0] - 2026-08-04

### Added
- **Status tab** — "Rebuild Storybook" button, always visible, disabled
  (with a hover tooltip and inline note explaining why) until a compare
  shows Storybook is stale or was never built. Triggers the tokens repo's
  `deploy-storybook.yml` workflow via GitHub's `workflow_dispatch` API
  directly from the plugin, instead of requiring a manual
  `build-storybook && push` in a terminal. Deliberately not automatic on
  every push — rebuilding is a user-driven action taken after reviewing
  what's out of sync.
- **Status tab** — "View Storybook (local)" button. Checks for a dev
  server at `http://localhost:6006` (`no-cors` probe, since Storybook's
  dev server sends no CORS headers) before opening it via a new
  `open-external` plugin message (`figma.openExternal`). If nothing's
  listening, shows the exact `npm run storybook` command with a one-click
  copy button instead of opening a dead tab — a plugin has no shell
  access in either execution context, so it can only detect the server,
  never start it.

### Changed
- Personal access token guidance now calls out that the token also needs
  `Actions: read/write` (in addition to `Contents: read/write`) for the
  new button to work.
- README/PROJECT.md rewritten to match the current architecture: the DTCG
  reference-aware token model (`design-sync-schema`), all six token
  categories (including `string`/`boolean`), both new Status tab buttons,
  CI, and the tokens repo's now-manual (`workflow_dispatch`-only) deploy
  workflow. Both previously described a pre-Phase-1 flat-value token model
  and were significantly out of date.

### Fixed
- Plugin failed to load at all ("unable to run") after adding
  `http://localhost:6006` directly to `networkAccess.allowedDomains` —
  that key only accepts `https://` domains, so a plain-HTTP entry fails
  manifest validation outright. Moved to the separate `devAllowedDomains`
  key, which exists specifically for local/non-HTTPS development domains.

## [1.0.1] - 2026-07-28

### Added
- Plugin version displayed in the UI footer, read from `package.json` at
  build time.
- This changelog, and the SemVer + changelog policy governing it going
  forward.

## [1.0.0] - 2026-07-28

Initial production release — the full feature set built to this point.

### Added
- **Connect tab** — GitHub owner/repo/branch/token-file-path + a personal
  access token, stored via `figma.clientStorage`.
- **Custom Tokens tab** — manual dimension-token editor, persisted in the
  Figma file's shared plugin data.
- **Sync tab** — reads Figma Paint/Text/Effect styles *and* Variables
  (COLOR/FLOAT, with `VARIABLE_ALIAS` resolution and multi-mode support),
  diffs against `design-tokens.json` on GitHub, requires explicit
  per-token conflict resolution (Use Figma / Use GitHub / Skip), commits
  the merged result to GitHub and applies GitHub-only changes back onto
  Figma styles.
- **Status tab** — three-way Figma/GitHub/Storybook health check, plus an
  in-app Storybook setup/update guide with commands pre-filled from the
  configured repo.
- Companion **design-tokens** GitHub repo with a Storybook site (Colors,
  Typography, Shadows, Dimensions pages), with search and collapsible
  groups to stay usable at the ~11,600-token scale EPAM UUI's Variables
  produce, and a `.storybook-sync.json` marker so the plugin can tell
  whether the last Storybook build reflects what's currently on GitHub.
- Visual design pulled from EPAM UUI's own Loveship theme tokens (the same
  design system this plugin syncs) — palette, typography, and button
  semantics (blue "Primary Action" vs. green "Call to action" for the
  actual Sync/commit button).

### Fixed
- `code.js` bundling — plain `tsc` left `import` statements in the output,
  which Figma can't load as a plain script.
- 409 "sha does not match" conflicts caused by local state not tracking a
  GitHub commit that succeeded despite a later step failing.
- Reading tokens files over GitHub's Contents API 1MB inline-content
  limit.
- Exceeding Figma's 100kB-per-`pluginData`-entry limit when the dimension
  token set grew into the thousands via Variables.
- Stale cached GitHub responses masking real repo changes (missing
  `cache: 'no-store'`).
