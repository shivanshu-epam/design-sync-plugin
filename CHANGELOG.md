# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/); versioning
follows [Semantic Versioning](https://semver.org/).

This project has no Android/iOS build, so there is no `versionCode` /
build-number tracking — `package.json`'s `version` field is the single
source of truth, and it's what the plugin's footer displays (baked in at
build time).

## [1.4.0] - 2026-08-04

### Added
- **Figma Variable write-back (Phase 2).** A GitHub-side resolution for a
  token that was originally read *from* a Figma Variable now writes back
  to that same Variable (`variable.setValueForMode`) instead of always
  degrading to a Paint/Effect Style. Needed a new `design-sync.modeId`
  field alongside the existing `design-sync.variableId` in
  `$extensions` (from `design-sync-schema` v1.1.0) — a variable with more
  than one mode has one value per mode, so the id alone doesn't say which
  mode's value to update.
- Applies to `color` (COLOR variables) and, for the first time, real
  writes for `dimension`/`string`/`boolean` (FLOAT/STRING/BOOLEAN
  variables) — previously, resolving a conflict in GitHub's favor for a
  variable-backed dimension/string/boolean token silently did nothing:
  `applyTokensToFigma` excluded any key matching a live variable from the
  custom-tokens plugin-data write, on the assumption "it's variable-derived,
  it'll re-read live" — true for reading, but nothing was actually
  updating the variable's value, so the resolution was lost.

### Changed
- `applyTokensToFigma` no longer decides Style-vs-custom-blob by checking
  "does a live Figma variable currently have this exact key name" — that
  was a fragile proxy for "was this variable-derived," easily wrong after
  a rename. It now reads each token's own `$extensions` instead, which is
  the actual authoritative answer already computed at read time.
- `resolveForFigmaApply` now resolves references uniformly across all six
  token categories (previously only color/typography/shadow) — a
  prerequisite for Variable write-back to have a concrete value to write,
  and the divergent per-category handling wasn't earning its complexity
  since Custom Tokens tab entries are effectively always already concrete.

### Fixed
- **"Use GitHub" resolutions for a variable-backed token silently fell
  back to a Style instead of writing the Variable — found by testing
  before push.** Which side's value wins a conflict is unrelated to
  whether a token is variable-backed, but `figmaApply` was carrying
  whichever side's *whole token object* won, `$extensions` included — so
  a "Use GitHub" resolution used GitHub's copy of `$extensions`, which is
  stale (or missing `modeId` entirely) for any token synced before this
  release. `applyVariableValue` correctly declined to write without both
  ids, so it fell back to a Style — invisible in the actual design, since
  nothing there is bound to that Style, only the Variable. Fixed with
  `preferLiveFigmaExtensions`: Figma's own current `$extensions` for a key
  (freshly read this session, so it does have `modeId`) now always wins
  over whichever side's value was chosen, since variable identity is a
  fact about Figma's current state, not something that should travel
  with the winning value.
- **Variable write-back failures were silent even after the fix above** —
  `applyVariableValue`'s `catch` block swallowed the real reason
  (`variable.setValueForMode` can throw for several distinct causes: the
  mode was removed from the collection, or — the likely real-world one —
  the variable belongs to a published library, and a plugin can only
  write variables local to the current file). Added a `diagnostics: string[]`
  field to the `apply-tokens-result` message: one line per color/dimension/
  string/boolean token processed, stating whether it wrote the Variable or
  fell back, and why, appended to the Sync tab's log. Without this there
  was no way to tell "nothing needed to change" apart from "the write was
  attempted and rejected" purely by looking at the result in Figma.

### Known limitation
- Write-back always resolves to a concrete value, even when writing to a
  real Variable — it does not (yet) write a native `VARIABLE_ALIAS` for a
  token whose value is itself a reference. Figma Variables do support
  aliasing another variable, but doing that safely requires the
  reference's *target* to itself be a known Figma variable, which isn't
  guaranteed (a GitHub-only reference chain has no Figma-side variable to
  point at). A possible later refinement, not required for values to sync
  correctly today.
- Brand-new tokens that never existed in Figma at all still become
  Styles, not Variables — there's no way to know which collection/mode a
  never-before-seen token should belong to. Write-back only re-links to a
  variable a token already has a documented history with.

## [1.3.2] - 2026-08-04

### Added
- Tooltip on the Connect tab's "Load my repos" button — every other
  action button in the plugin explains itself on hover, this one didn't,
  which stood out once the repo picker (v1.3.0/1.3.1) had a few buttons
  sitting next to each other with only one of them self-explanatory.

## [1.3.1] - 2026-08-04

### Changed
- **Connect tab restructured into three numbered, visually separated
  sections** (Token → Find repository (optional) → Repository details),
  with `<hr>` dividers between them — the token, repo-picker, and
  owner/name/branch/path fields had become visually flat and crowded
  once the repo picker (v1.3.0) landed on top of the existing fields.
- Required fields (token, owner, repository name) now show a red `*`
  next to the label. Branch and token file path aren't marked required
  even though they always end up populated — they have real defaults
  (`main`, `design-tokens.json`) shown as placeholders, so leaving them
  blank is a valid, common choice, not an error state.
- Consolidated the token-scope guidance into one hint directly under the
  token field (previously split: a short note near the top, a longer one
  at the bottom of the whole form) — now it's read once, right where it's
  relevant, instead of twice in two different places.

## [1.3.0] - 2026-08-04

### Added
- **Connect tab** — "Find repository" search field. "Load my repos" fetches
  every repo the token can see (`GET /user/repos`, paginated up to 500),
  then the search field's native `<datalist>` gives type-ahead
  filtering — selecting a repo auto-fills Repository owner/name (and
  Branch, if still empty) instead of hand-typing them. Manual entry in
  the fields below still works exactly as before; this is additive.

### Changed
- Reordered the Connect tab: Personal access token now comes first, since
  it's required before "Load my repos" can do anything.
- Refactored `githubRequest()` into a token-only `githubRequestWithToken()`
  underneath it, so repo listing (which happens before there's a full
  `GithubSettings` to work with — owner/repo aren't chosen yet) doesn't
  duplicate the fetch/header logic.

## [1.2.2] - 2026-08-04

### Added
- Any 403/"not accessible" GitHub API error (Sync, Refresh status) now
  shows an inline step-by-step guide for fixing PAT permissions — separate
  instructions for fine-grained vs. classic tokens — instead of leaving
  the user to work out which of Contents/Pull requests/Actions is missing
  from a raw API error message.

## [1.2.1] - 2026-08-04

### Fixed
- If opening the sync PR fails (e.g. "403 Resource not accessible by
  personal access token" — the PAT is missing `Pull requests: read/write`),
  the branch + commit that already succeeded are no longer left behind as
  an orphaned `design-sync/sync-*` branch. It's deleted (best-effort)
  before the original error is re-thrown, so a retry after fixing the
  token starts clean instead of accumulating dead branches.

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
