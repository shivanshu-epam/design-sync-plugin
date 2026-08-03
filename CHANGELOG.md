# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/); versioning
follows [Semantic Versioning](https://semver.org/).

This project has no Android/iOS build, so there is no `versionCode` /
build-number tracking — `package.json`'s `version` field is the single
source of truth, and it's what the plugin's footer displays (baked in at
build time).

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
