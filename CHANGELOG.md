# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/); versioning
follows [Semantic Versioning](https://semver.org/).

This project has no Android/iOS build, so there is no `versionCode` /
build-number tracking — `package.json`'s `version` field is the single
source of truth, and it's what the plugin's footer displays (baked in at
build time).

## [1.15.0] - 2026-08-05

### Changed
- **Status tab redesign — third tab in the tab-by-tab IA pass.** Same
  direction as Connect and Sync:
  - **Refresh status**, **View Storybook (local)**, and **Rebuild
    Storybook** buttons gain icons (`ArrowsClockwise`, `ArrowSquareOut`,
    `ArrowsClockwise`) instead of plain text.
  - **Section headers** ("1. Figma ↔ GitHub", "2. GitHub ↔ Storybook")
    drop their numeric prefixes for source-logo icons and gain a trailing
    status `.tag` (`in sync` / `N differ` / the Storybook status), so each
    section's state reads before any prose does — same pattern as Sync's
    category headers.
  - **The Figma↔GitHub diff table** — previously always rendered in full
    the moment anything was out of sync, the single biggest source of
    scroll on this tab — now collapses into a `persistentDetails`
    accordion, open by default the first time there's a mismatch and
    respecting the user's choice afterward.
  - `renderStorybookGuide()`'s summary gains an `Info` icon, the last
    bare-text accordion summary left in the app.

## [1.14.0] - 2026-08-05

### Changed
- **Sync tab redesign — second tab in the tab-by-tab IA pass.** Same
  progressive-disclosure/icon-forward direction as Connect:
  - **Fetch & compare** and **Sync** buttons gain icons (`ArrowsClockwise`,
    `ArrowsLeftRight`) instead of being plain text.
  - **Bulk action rows** ("Select all"/"Deselect all", "Use all Figma"/
    "Use all GitHub") drop their counts from the button text into a `.tag`
    pill next to the buttons, and the explanatory sentence about new-token
    default-include behavior is now an `Info` icon with a tooltip instead
    of a permanent paragraph. Both bulk buttons also gain a `FigmaLogo`/
    `GithubLogo` icon.
  - **Category headers** (`Colors`, `Typography`, …) gain a trailing count
    tag instead of the count only showing up per-row.
  - **Per-row conflict resolution** — the 3 radio+label pairs ("Use
    Figma"/"Use GitHub"/"Skip") are replaced with a compact segmented
    icon-button toggle (`.resolution-toggle`), color-matched to each
    source the same way `diff-value-label.figma`/`.github` already are.
  - **Activity log** — the always-visible `<pre>` trace of sync/compare
    steps is now a `persistentDetails` accordion ("Activity log"), open by
    default the first time there's something to show and respecting
    whatever the user sets afterward; skipped entirely when there's
    nothing logged yet.

## [1.13.1] - 2026-08-05

### Fixed
- **`<details>` accordions across the whole app were silently closing on
  any re-render, not just when the user closed them.** `render()` rebuilds
  a tab's DOM from scratch on every state change, including ones triggered
  by a button *inside* an accordion (e.g. "Send test notification" setting
  a loading state) — and `<details open>` lives only on that DOM node
  instance, so replacing it always reset to closed (or, for the permission
  guides, snapped back open even after the user had closed it, since those
  hardcoded `open: true`). Fixed with a persisted `state.openDetails`
  map plus a `persistentDetails()` helper, applied to all 9 accordion
  sites in the codebase (Connect's permissions/manual-entry, Recent
  activity, Sync's cascade groups, every `renderPermissionErrorGuide` call
  site, Notifications and its two provider sub-sections, Storybook setup).
- **Status banner sat flush against the button row above it.**
  `.status-banner` only had `margin-bottom`; a banner shown right after
  Connect/Test connection/Cancel (e.g. "Connected to owner/repo") had 0px
  gap above it. Changed to `margin: 10px 0`.
- **Repo search dropdown used to vanish while typing or on focus.** It was
  a native `<input list>` + `<datalist>`, which is unreliable inside a
  Figma plugin's sandboxed iframe — the browser-native popup would close
  as the user kept typing instead of updating. Replaced with a
  hand-rendered dropdown (`.repo-search-menu`) that filters
  `state.availableRepos` on input and stays open until a selection or
  blur, so it behaves the same in every browser engine the plugin runs in.

### Changed
- **Notifications section trimmed and given real branding.** Microsoft
  Teams and Slack sub-accordions now show their actual logo icon next to
  the provider name; the intro sentence is one line instead of three; the
  "Requires `<workflow>` and `<script>`..." paragraph is now a compact
  `.tag-row` of two pill-style filename tags instead of prose.

## [1.13.0] - 2026-08-04

### Changed
- **Connect tab redesign — first of a tab-by-tab IA pass, not just
  re-skinning.** The always-expanded form (token, repo search, owner/
  repo/branch/path, Save + Test, an always-visible history list, and a
  gated Notifications section) is replaced with progressive disclosure:
  - **Compact status card** once configured — `owner/repo · branch` with
    icon-only Test/Edit actions — instead of the full form staying
    expanded forever. Editing re-expands it, pre-filled; Cancel returns
    to the card without discarding the saved connection.
  - **Token's 3-sentence permissions paragraph** replaced with a one-line
    security note + a collapsed "What permissions does this need?"
    detail.
  - **Owner/repo/branch/path fields** collapsed behind "Enter repository
    manually," open by default only when nothing's set yet (derived from
    current field values, not new state — same pattern as
    `renderStorybookGuide`'s existing `needsSetup`-computed-open detail).
  - **Recent activity** and **Notifications** both collapsed accordions
    now (Notifications was already one, just previously gated behind an
    always-visible "Notifications (optional)" heading); Recent activity
    renders nothing at all when there's no history, instead of a
    permanently-visible empty list.
  - **Notifications' Teams/Slack setup instructions** split into their
    own nested sub-accordions instead of both dumping in full the moment
    "Notifications" opens — a new `.setup-guide.nested` style variant
    (no border/background of its own, avoids box-in-box).
- **Save + Test connection combined into one "Connect" action** for
  first-time setup. Deliberate behavior change, confirmed with the user
  before implementing: previously, Save jumped to the Sync tab and ran
  Compare as soon as owner/repo/token were merely non-empty — even with
  an invalid token, landing on an unverified, possibly-broken Sync tab.
  Connect now saves, tests, and only jumps to Sync on a **verified**
  successful connection; on failure it stays on Connect showing the same
  error + permission-fix guide Test connection already used. Test
  connection itself is preserved as an independent action — both as a
  secondary button next to Connect in the form, and as an icon action on
  the compact card, for re-verifying without touching other fields (e.g.
  after rotating the token).
- Every icon-only control added here (Test/Edit on the card, the repo
  search's reload button) gets an explicit `aria-label` — the same
  Accessibility rule ("icon buttons without labels" is a High-severity
  anti-pattern) the icon/color revamp leaned on.

## [1.12.0] - 2026-08-04

### Changed
- **Full visual revamp** — colors, typography, and the plugin's first
  iconography, using the `ui-ux-pro-max` skill's own search tool rather
  than freehand design decisions. Its product-type search matched this
  plugin closest to "Developer Tool / IDE" and "Minimalism & Swiss Style"
  (the latter's own description: "Best for: ...dashboards, documentation
  sites, SaaS platforms, professional tools") — both flagged dual-mode
  (light + dark), the hard requirement given Figma itself runs in both.
- **New slate + blue + green palette**, replacing the EPAM UUI-derived
  one, in both light and dark. Every CSS custom-property name and every
  place it's consumed is unchanged — only the assigned hex values moved —
  so nothing needed restructuring, just re-skinning. Contrast-verified
  with an actual WCAG relative-luminance calculation, not eyeballed:
  body text hits 17:1 (light) / 17:1 (dark), muted text 4.6:1 / 7.0:1.
  `--accent` and `--cta` back solid white-text buttons in one role and
  (accent only) inline links in another — roles that pull toward opposite
  shades in dark mode; `--accent` (#3678E2) is tuned to the best
  achievable balance for both (~4.2:1 each) rather than optimizing one at
  the other's expense, documented inline in `ui.template.html`.
- **First icon set** (`icons.ts`) — 20 icons, real Phosphor "regular"
  weight SVG path data (MIT license) extracted from `@phosphor-icons/core`
  and inlined as string constants (no runtime dependency — a Figma
  plugin's UI iframe can't load an icon font or hit a CDN). Applied to:
  the tab bar (previously text-only, "Custom Tokens" wrapped to 2 lines —
  icon-above-label stacking fixed both problems at once), the
  FIGMA/GITHUB source chips (nominative use of `FigmaLogo`/`GithubLogo`),
  every diff-row badge, a new shared `statusBanner()` helper (13+ call
  sites used to hand-build near-identical success/error `<div>`s —
  centralizing them meant "never convey status by color alone," an
  Accessibility rule from the skill, only had to be added once), the
  Revert/Copy/PR-link buttons, loading states (a spun `CircleNotch`
  replaces plain "Checking…"/"Triggering…" text with zero motion
  feedback), and `<details>` disclosure carets (native marker replaced —
  looked out of place once everything else had a real icon).
- Dropped the `'Source Sans Pro', ...` font stack's now-meaningless first
  entry (a Google/Adobe font effectively never installed locally, so the
  stack already fell through to system fonts in practice) in favor of a
  plain system-font stack — the honest equivalent of the skill's
  recommended "Developer Mono" pairing (JetBrains Mono + IBM Plex Sans),
  which can't be loaded here for the same no-external-assets reason the
  icons can't be a font/CDN.

## [1.11.1] - 2026-08-04

### Removed
- **Reverted the static status page feature from 1.11.0** — not wanted.
  Removed the Status tab link/note. The paired `design-tokens` repo
  changes (`scripts/generate-status-page.mjs`, the `deploy-storybook.yml`
  step) were reverted separately in that repo. Notifications (v1.8.0),
  the other half of Phase 9, are unaffected and stay as-is.

## [1.11.0] - 2026-08-04

### Added
- **Static status page (Phase 9, second half — notifications were the
  first, v1.8.0).** `design-tokens` gains `scripts/generate-status-page.mjs`,
  writing `status.html` into `storybook-static/` on every Storybook
  rebuild — a bookmarkable, no-login page showing the last build time
  and the full recent-activity feed from `.design-sync/audit-log.jsonl`
  (actor, PR link, per-token changes), so anyone can check what's been
  happening without opening Figma or the plugin. Status tab now links to
  it (assumes the standard `owner.github.io/repo/` Pages URL — best
  effort, not verified, since there's no API to check for a custom
  domain).

### Deviation from the original roadmap spec
`design-sync-roadmap-phases-1-11.md`'s Phase 9 described this page as
reflecting "current Figma↔GitHub↔Storybook state," refreshed on every
CI run. Neither is what got built, for two concrete reasons:
- **No live Figma state.** A CI-generated static page has no access to
  Figma at all — only the plugin, running inside Figma, can know that.
  The page is upfront about this (a footer note points back to the
  plugin's own Status tab) rather than implying a check it can't do.
- **Can't refresh on every sync.** GitHub Pages' `deploy-pages` action
  replaces the *entire* site on every run — a status page regenerated in
  a separate workflow (e.g. triggered the same way `notify-on-sync.yml`
  is, on every audit-log push) would silently wipe out the real
  Storybook content on its next deploy. So generation is tied to
  Storybook's own existing manual rebuild trigger instead. A "Storybook
  matches current tokens" boolean computed at build time would also
  always be trivially true right after the build that computed it — not
  informative — so the page shows the last-build timestamp next to the
  full activity list instead, letting a visitor judge staleness
  themselves from what's listed after that time.

## [1.10.1] - 2026-08-04

### Changed
- **Sync tab collapses cascade-only rows instead of showing each one at
  full size.** A token with many downstream references (e.g. a primitive
  used by several component tokens) could turn a review with one real
  conflict into a page of identical "Nothing to decide here…" boxes,
  each with its own label chips and explanatory text repeated. Cascade
  rows within a category now collapse into one `<details>` — "N more
  auto-resolve — no action needed" — closed by default, with each row
  reduced to a single compact line (key, then `figma value → github
  value`) when expanded. Real conflicts and new-token rows are
  unaffected, still shown in full immediately. Reuses the existing
  `.setup-guide`/`.audit-change-row` styling rather than adding new CSS.
  Removed the now-dead `cascadeOnly` branch from `renderDiffRow` (it's
  only ever called with actionable rows now) and the `.diff-row.cascade-
  only`/`.cascade-note` CSS that went with it.

## [1.10.0] - 2026-08-04

### Changed
- **Extracted `runSync`'s decision logic into a tested pure function,
  `planSync` (`sync-logic.ts`).** Three real production bugs in a row —
  a 422 opening the PR, a sync invisible to History/notifications, "0
  changes" shown for a real Figma update — all came from mistakes in the
  same handful of inline decisions in `runSync`: whether to open a PR,
  whether to commit the tokens file, what the audit entry should
  contain, what the PR body should say. None of that logic needs
  `figma.*` or `fetch` to compute; it only ever lived inline because
  nothing forced it out. `planSync` now owns all of it — given `final`,
  `figmaTokens`, `githubTokens`, `figmaApply`, resolutions, the diff, and
  the tokens path, it returns a `SyncExecutionPlan`
  (`shouldOpenPr`/`shouldCommitTokens`/`changedCount`/`changes`/`prBody`)
  that `runSync` just executes. 4 new tests reproduce each of the three
  bugs directly by name (33 total), so this exact class of mistake gets
  caught before shipping next time, not after.
- `AUDIT_LOG_PATH` moved into `sync-logic.ts` as the single source of
  truth — it was previously a separate string literal in `ui.ts`, and
  `planSync`'s PR-body text needs it too.

## [1.9.2] - 2026-08-04

### Fixed
- **PR, Teams notification, and History all showed "0 changes" for a
  sync that genuinely changed Figma.** Found immediately after 1.9.1
  fixed the 422 for the same scenario: a token edited directly on
  GitHub, resolved as "Use GitHub." `computeAuditChanges` only ever
  compared `final` against `githubTokens` — the right comparison for a
  Figma→GitHub change (Figma's value gets committed), but blind to the
  reverse direction, since resolving "Use GitHub" makes `final`
  byte-identical to `githubTokens` by construction. Nothing looked
  different to the function, even though Figma's old value had just
  been genuinely overwritten.
  `computeAuditChanges` now takes `figmaTokens` as well and compares
  `final` against BOTH sides: whichever side's old value final *doesn't*
  match is what changed. A key changes when it doesn't match both, and
  "added" now correctly means "had no old value on either side," not
  just "had no old value on GitHub." 2 new tests cover both directions
  explicitly (29 total), including the exact reported scenario.

## [1.9.1] - 2026-08-04

### Fixed
- **1.9.0 itself 422'd: "Opening pull request failed: 422 Validation
  Failed."** Found immediately while the user tested 1.9.0's own fix.
  Root cause: in the "GitHub already matches, only Figma needs updating"
  case, `design-tokens.json` was correctly left uncommitted (nothing to
  change there) — but that meant NO commit existed on the branch at all
  before `createPullRequest` was called, and GitHub rejects opening a PR
  from a branch with zero commits ahead of base ("No commits between
  main and design-sync/..."). The audit-log entry — the thing meant to
  make this sync visible — was only being committed *after* the PR, too
  late to help.
  Fixed by reordering: the audit-log entry now commits FIRST, with
  placeholder `prNumber`/`prUrl` (0 / `''`), which works because that
  entry always has genuinely new content (an appended JSONL line) —
  guaranteeing the branch diverges from base regardless of whether the
  tokens file itself needs a commit. Once the PR exists, a second small
  commit (`patchLastAuditLogEntry`) rewrites just that last line with
  the real PR number/URL. Considered instead just committing
  `design-tokens.json` unconditionally (even with identical content) to
  force a diverging commit, but that relies on an unverified assumption
  about whether GitHub's Contents API creates a real commit object for
  byte-identical content — rejected in favor of a mechanism with no such
  assumption.

## [1.9.0] - 2026-08-04

### Changed
- **Breaking: a sync that only updates Figma (GitHub already had the
  value) now opens a PR too, instead of being skipped entirely.** Found
  via a real case: editing `design-tokens.json` directly on GitHub, then
  running Sync in the plugin — Figma updated correctly, but no
  audit-log entry was written and no Teams/Slack notification fired,
  because both only trigger from inside the PR-opening branch of
  `runSync`, which was gated purely on `githubContentChanged`. A token
  resolved as "Use GitHub" whose value is already on GitHub makes
  `githubContentChanged` false (nothing to commit) even though Figma
  genuinely needs the write — that whole sync was invisible to History
  and notifications as a result. The gate is now `githubChanged ||
  hasAnyEntries(figmaApply)`: GitHub's file is only committed when it
  actually needs to change, but the PR — carrying at minimum the
  audit-log entry — opens whenever *either* side did real work. The true
  no-op case (nothing resolved, nothing to do) still skips the PR
  entirely, unchanged from v1.4.3.
- `sync-logic.ts` gained `hasAnyEntries()`, with 3 new tests (28 total)
  including one that reproduces the exact "Use GitHub resolution, GitHub
  already matches" scenario that exposed this gap.

## [1.8.2] - 2026-08-04

### Fixed
- **History tab showed raw token JSON instead of the resolved value.**
  Found while making Teams/Slack notifications more descriptive (see
  `notify-on-sync.mjs`'s matching fix in the tokens repo): `AuditChange.
  previousValue`/`newValue` store the full `DesignToken` object
  (`{$type, $value: {kind, value|refKey}, $extensions}`), not a bare
  scalar, so `renderAuditChangeRow` was JSON-stringifying the whole
  token — e.g. `{"$type":"color","$value":{"kind":"value","value":
  "#fffff5"}}...` instead of just `#fffff5`. `formatAuditValue()` now
  extracts the resolved value (or `→ refKey` for a reference).

## [1.8.1] - 2026-08-04

### Fixed
- **"Send test notification" 403s didn't show the existing permission-fix
  guide.** Found immediately after shipping 1.8.0 — `renderPermissionErrorGuide`
  already exists and is wired into every other GitHub-call error banner
  (Sync, Status, Storybook rebuild) but was missed on this new button.
  Triggering `workflow_dispatch` needs the same `Actions: Read and write`
  PAT permission the Storybook rebuild button needs, so the fix-it steps
  are identical — just wasn't showing them here.

## [1.8.0] - 2026-08-04

### Added
- **Connect tab — "Notifications (optional)" setup guide** for Teams
  and/or Slack (Phase 9, adapted — see deviation note below), plus a
  "Send test notification" button that triggers the tokens repo's new
  `notify-on-sync.yml` via `workflow_dispatch`, same pattern as the
  existing "Rebuild Storybook" button.
- **`design-tokens` repo**: `scripts/notify-on-sync.mjs` +
  `.github/workflows/notify-on-sync.yml` — posts a plain-text summary
  (actor, PR link, token count) whenever `.design-sync/audit-log.jsonl`
  gets a new entry. `TEAMS_WEBHOOK_URL` and `SLACK_WEBHOOK_URL` are both
  optional repository secrets, independent of each other — set one, the
  other, or both.

### Deviation from the original roadmap spec
`design-sync-roadmap-phases-1-11.md`'s Phase 9 specified Slack only,
with a Block Kit payload. This implementation covers Teams first (per
explicit request — Teams is what's actually used), with Slack as an
equally-supported second provider from the start rather than a later
addition, and both share a plain-text `{"text": "..."}` payload instead
of a platform-specific rich format — Teams' Adaptive Card markdown and
Slack's mrkdwn are mutually incompatible, and this script has no way to
know in advance which provider(s) a given deployment has configured.
- **The webhook URL is not handled by the plugin at all** — considered
  and explicitly rejected doing this via GitHub's Secrets API (would
  need a new PAT scope, `Secrets: write`, plus a client-side encryption
  dependency to satisfy the API's sealed-box requirement). The plugin
  only guides setup and offers a test button; the secret itself is
  pasted into GitHub's own Secrets UI, matching the original spec's own
  reasoning for why a webhook URL shouldn't live in per-machine
  `figma.clientStorage` in the first place.
- **Teams' classic "Connectors" incoming webhooks are retired** — the
  setup guide targets the current replacement, the Workflows app
  (Power Automate), using its built-in "Post to a channel when a webhook
  request is received" template.
- **No static status page** (the other half of the original Phase 9 spec)
  — not built in this pass; still open if wanted later.

## [1.7.0] - 2026-08-04

### Changed
- **Readability overhaul of diff/history rows** — the main source of "I
  can't read this" feedback. Figma/GitHub values previously sat
  side-by-side in two ~180px flex columns at 10px monospace inside the
  420px panel; any reference path or long hex string was nearly
  unreadable at that width. Each value now gets its own full-width line
  with a colored `FIGMA`/`GITHUB` label chip (green/blue, matching the
  existing added-figma/added-github border colors elsewhere), stacked
  vertically instead of squeezed side by side, at 12px instead of 10px.
  Same treatment for History tab entries: key on its own line, `before →
  after` on the next, instead of a cramped two-column row.
- Base body font size 12px → 13px with `line-height: 1.45` (previously
  unset, defaulting to a cramped ~1.2). Several small-text elements
  (status banners, hints, table cells, buttons, the log panel) bumped
  from 9–11px to 11.5–13px — the 9–9.5px sizes are now reserved for
  genuine micro-labels (badges, table headers), not body content.
- Fixed a real layout bug found while visually verifying this in the
  browser preview: the `REF` badge on a reference row had no
  `flex-shrink: 0`, so on a wrapped `.diff-value-line` it got squeezed
  into a single-character-wide column and rendered "R / E / F" stacked
  vertically. `.diff-value-line` now wraps properly (`flex-wrap: wrap`)
  with the badge and label both pinned to their natural width.

## [1.6.1] - 2026-08-04

### Fixed
- **History tab's empty state didn't distinguish "haven't clicked Load
  history yet" from "loaded successfully, found zero entries."** Both
  showed the same "Click 'Load history'…" prompt, which reads as broken
  if you already clicked it. New `auditLogLoaded` flag lets the empty
  state say "No sync history recorded yet on `<branch>`" once a load has
  actually completed with zero results — a legitimate, expected state
  for any branch that hasn't had a sync run since v1.6.0 shipped.

## [1.6.0] - 2026-08-04

### Added
- **History tab (Phase 5 — audit trail + rollback).** Every sync that
  actually changes something on GitHub now appends one line to
  `.design-sync/audit-log.jsonl` in the tokens repo: timestamp, actor
  (`GET /user` with the configured PAT), the PR it was part of, and the
  exact per-token before/after values — reusing `buildSyncPlan`'s own
  merged result rather than recomputing a second diff, so the audit log
  can't disagree with what the Sync tab showed. Committed to the same
  branch as the token change itself, so it's part of the same PR a
  reviewer already sees. The previous "last 5 PRs" list in the Connect
  tab only ever showed a PR link — this shows what actually changed,
  without opening GitHub.
- **"Revert this sync"** on any History entry made entirely of `modified`
  changes: opens a new PR restoring every affected token to its previous
  value, and — like a normal sync — applies immediately to Figma. A
  revert is recorded as its own new audit entry rather than a special
  git-level operation, so rollbacks show up in history too. Scoped
  deliberately to `modified`-only entries: an `added` token has no
  well-defined inverse under the current merge model (there's no "delete
  this key from GitHub" resolution — see `PROJECT.md` §11), so an entry
  containing any addition shows a disabled Revert button with an
  explanation rather than silently reverting only part of a sync.
- `sync-logic.ts` gained `computeAuditChanges`, `canRevertEntry`, and
  `invertAuditChanges` — pure functions, 8 new tests in
  `sync-logic.test.ts` (25 total), following the same test-first pattern
  as 1.5.0.

### Deviation from the original roadmap spec
`design-sync-roadmap-phases-1-11.md`'s Phase 5 assumed Phase 3 still had
an optional direct-commit mode, and specified appending the audit entry
at PR-merge time via CI (since a direct commit has no merge event to hook
into). This plugin's Sync is PR-only (see 1.2.0's "Breaking" note) — so
the audit entry is appended directly to the sync branch as part of the
same flow that opens the PR, no CI hook needed. Simpler than the spec,
not a reduction in scope.

## [1.5.0] - 2026-08-04

### Added
- **Test coverage for the Sync tab's core logic (Phase 5 candidate,
  picked over rollback/audit-trail work — see PROJECT.md §11).** Every
  bug fixed in this project so far was found by manually reading a
  user-pasted log, never by a test catching it first. `diffTokenSets`,
  `buildSyncPlan`, `preferLiveFigmaExtensions`, `resolveForFigmaApply`,
  `diffRowPriority`, and the new `githubContentChanged` (extracted from
  `runSync`'s inline check) are plain functions over `TokenSet` data —
  no `figma.*`, no `fetch`, no DOM — so they're testable without a Figma
  runtime or a browser. Moved out of `ui.ts` into a new `sync-logic.ts`
  specifically so they could be imported directly by a test file; `ui.ts`
  now imports them back. 17 tests in `sync-logic.test.ts`, covering the
  real bugs already found and fixed this session (the reference-cascade
  false-conflict from 1.4.2, the delta-vs-full-set bug from 1.4.1, the
  empty-PR case from 1.4.3) so they can't silently regress.
- `npm test` — compiles `sync-logic.ts`/`sync-logic.test.ts` with a new
  `tsconfig.test.json` (CommonJS output to a gitignored `dist-test/`,
  kept separate from the plugin's own ESM build) and runs them with
  Node's built-in `node --test`, matching the zero-extra-dependency
  approach `design-sync-schema` already uses for its own test suite.

### Fixed
- Adding `@types/node` (needed for `node:test`/`node:assert` types) broke
  the plugin's own build — TypeScript auto-includes every package under
  `typeRoots` by default, so `@types/node`'s `console`/`fetch` globals
  collided with `@figma/plugin-typings`' own versions of the same
  globals. `tsconfig.json` (the `code.ts` config — this runs in Figma's
  sandbox, never Node) now explicitly restricts `types` to
  `plugin-typings` only, rather than relying on the implicit
  include-everything default.

## [1.4.4] - 2026-08-04

### Changed
- **Sync tab now sorts each category's rows by whether they need a
  decision.** Real conflicts (Use Figma/Use GitHub/Skip) sort first,
  new-on-one-side rows (Include in sync checkbox) next, and cascade-only
  rows (see 1.4.2 — nothing to decide, they settle on their own) last —
  previously all three sorted together alphabetically, burying the rows
  that actually need attention among ones that don't. Sort is stable, so
  each tier keeps its original alphabetical order.

## [1.4.3] - 2026-08-04

### Fixed
- **Sync opened an empty pull request when nothing actually needed to
  change on GitHub.** Found immediately after the 1.4.2 fix: with only
  reference-cascade rows resolved (which never had anything to commit —
  see 1.4.2), Sync still created a branch, committed, and opened a PR
  with a 0-line diff. `runSync` now compares the fully-merged result
  against GitHub's currently-stored content, category by category, key
  by key, before touching the branch/commit/PR path at all — if nothing
  differs, it skips straight to applying changes to Figma (if any) and
  logs "No GitHub changes needed" instead of opening a no-op PR.

## [1.4.2] - 2026-08-04

### Changed
- **Sync tab no longer presents reference-cascade rows as equal-weight
  conflicts.** Found via a real case: editing 4 primitive color tokens
  produced 7 "Conflict" rows in the diff — the other 3 were `badge-bg`
  entries that reference one of the edited primitives (marked `REF`),
  whose own stored value never changed, only what it resolves to. The
  diff already compares *resolved* values (by design — a reference
  should read as changed when its target changes), but the actual merge
  (`buildSyncPlan`) compares *raw* stored values first and short-circuits
  to "unchanged" before ever consulting a resolution — so for a row like
  this, clicking Use Figma/Use GitHub/Skip has no effect on what's
  actually written. Showing three active buttons that do nothing is
  misleading. `DiffEntry` now carries a `cascadeOnly` flag (raw values
  identical, only the resolved value differs) computed with the same
  check `buildSyncPlan` uses, so it can't drift out of sync with what the
  merge actually does. A cascade-only row renders as an inert,
  lower-emphasis note ("resolves automatically once you handle its
  underlying primitive") instead of resolution controls, and is excluded
  from conflict counts and the "Use all Figma/GitHub" bulk actions.

## [1.4.1] - 2026-08-04

### Fixed
- **`runSync` overwrote the delta-only `figmaApply` for dimension/string/
  boolean with the *entire* merged token set, on every sync.** Left over
  from before Phase 2 (1.4.0), when those categories only ever wrote one
  plugin-data blob that had to be replaced wholesale — `buildSyncPlan`
  already produces a correct delta-only subset for every category, so
  this was pure leftover code, not something a variable-backed category
  needed. Confirmed directly from a user's Sync log: a sync with 7 actual
  changes produced ~2,700 unrelated `dimension/...`/`string/...`
  diagnostic lines, each a real `setValueForMode` write to a Figma
  Variable that hadn't changed. Removed the override; `figmaApply` now
  stays delta-only for every category, same as color.
- **`hexToRgba` silently mis-parsed malformed hex into a wrong-but-valid-
  looking color instead of erroring.** Found via a real case: a source
  token stored as `"#fffff"` (5 digits, one short) sliced into `ffff0f`
  — `clean.slice(4, 6)` on a 5-char string returns 1 character, so the
  missing digit shifted into the blue channel rather than raising an
  error. A successful-looking write-back with the wrong color is worse
  than a failed one, since nothing in the Sync log distinguished it from
  a correct write. `hexToRgba` now validates the string is exactly 6 or
  8 hex digits and throws otherwise; that throw is caught alongside
  `setValueForMode`'s own failures in `applyVariableValue` (previously
  the conversion happened outside the try/catch, so a bad value would
  have crashed the whole batch instead of producing one diagnostic
  line), and the Style-fallback paths (`applyColorToken`,
  `applyTypographyToken`, `applyShadowToken`) are now individually
  guarded too, so one malformed token fails and logs instead of aborting
  every other token in the sync.

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
