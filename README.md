# Design Sync — Figma plugin

Bidirectional sync between Figma **Styles** and **Variables** (color,
typography, shadow, dimension, string, boolean) and a DTCG-aligned JSON
design-tokens file in a GitHub repository, plus a Status tab that also
tracks whether a companion Storybook is up to date. This folder is the
Figma plugin only — the token schema/validation logic lives in a separate
shared package (`design-sync-schema`), and the tokens + Storybook live in
a separate repo (`design-tokens`). See [PROJECT.md](PROJECT.md) for the
full write-up (problem, architecture, every bug hit building this, setup
from scratch).

## Token sources: Styles + Variables

| Token category | Figma source |
|---|---|
| `color` | Paint styles (single solid fill only, in this MVP) **+** COLOR variables from every local variable collection |
| `typography` | Text styles |
| `shadow` | Effect styles (drop/inner shadow layers) |
| `dimension` | Manually-entered custom tokens (stored as a JSON blob in the file's shared plugin data, edited from the **Custom Tokens** tab) **+** FLOAT variables from every local variable collection |
| `string` | STRING variables from every local variable collection |
| `boolean` | BOOLEAN variables from every local variable collection |

Style names/variable names become the token key directly (e.g.
`primary/blue` for a style, `Semantic/Light/surface/primary` for a
multi-mode variable — collection name, then mode name if the collection has
more than one mode, then the variable's own name). Whatever naming/folder
convention you use in Figma is what ends up in the repo.

Reading **local** variables via the plugin API (`figma.variables.getLocalVariableCollectionsAsync`/
`getLocalVariablesAsync`) works regardless of the *viewer's* own Figma
plan — it's gated by the file/team's plan, not yours, and it degrades
gracefully (just contributes nothing, not an error) if variables genuinely
aren't available.

**Aliases are preserved as live references, not flattened.** A variable
whose value is a `VARIABLE_ALIAS` is stored as `{ kind: 'reference', refKey:
'<category>/<key>' }`, resolved on demand by `resolveToken()` rather than
baked into a concrete value at read time — see [Token model](#token-model)
below. If the alias target isn't in Figma's currently-active variable list
(an orphaned reference), it falls back to a resolved concrete snapshot
instead of blocking the read.

**Variable write-back (Phase 2).** A GitHub-side resolution for a token
that was originally read *from* a Figma Variable (carries
`design-sync.variableId` + `design-sync.modeId` in `$extensions`) writes
back to that same variable's mode via `variable.setValueForMode()`,
instead of degrading to a Style. This only re-links a token to a variable
it already has documented history with — a brand-new token that never
existed in Figma at all still becomes a Style, since there's no way to
know which collection/mode a never-before-seen token should belong to.
Write-back also always resolves to a concrete value, even for a Variable —
it doesn't yet write a native `VARIABLE_ALIAS` for a token that's itself a
reference, since the reference's target isn't guaranteed to be a known
Figma variable (e.g. a GitHub-only reference chain).

## Token model

The schema, resolution, and validation logic used to be hand-duplicated
between this repo and `design-tokens`. It now lives in one place —
[`design-sync-schema`](https://github.com/shivanshu-epam/Atlassian-design-system),
a small shared package both repos depend on (`github:` dependency, built
via `prepare` on install) — so a fix only has to happen once.

```ts
type TokenValue<T> =
  | { kind: 'value'; value: T }
  | { kind: 'reference'; refKey: string }; // '<category>/<key>'

interface DesignToken<T> {
  $type: TokenCategory;
  $value: TokenValue<T>;
  $description?: string;
  $extensions?: { 'design-sync.figmaSourceType'?: 'style' | 'variable' };
}
```

`resolveToken()` walks a reference chain to its concrete value on demand;
`validateTokenSet()` detects broken and circular references (direct and
indirect) without blocking the rest of an otherwise-fine token set — they
surface as individual, skippable conflicts in the Sync tab instead. Tokens
still in the pre-DTCG flat-value shape (`$value: <concrete>`, no `kind`)
are auto-normalized on read, in memory — no manual migration step required
even against an out-of-date `design-tokens.json`.

## What it does today

- **Connect** tab — GitHub owner/repo/branch/file path + a personal access
  token, stored locally via `figma.clientStorage` (never sent anywhere
  except `api.github.com`). See [GitHub token](#github-token) for the
  scopes it needs. A "Find repository" search field (native `<datalist>`
  type-ahead) lists every repo the token can see and auto-fills
  owner/name/branch on selection, so owner/repo don't need to be typed
  by hand — manual entry still works too.
- **Custom Tokens** tab — key/value editor for dimension tokens (spacing,
  radii, etc.), persisted in the Figma file itself.
- **Sync** tab — fetches current Figma tokens and the GitHub JSON file,
  diffs them per key (added in Figma / added in GitHub / conflicting), and
  requires an explicit resolution (Use Figma / Use GitHub / Skip) for every
  conflict before the "Sync" button unlocks. Syncing opens a **pull
  request** against the configured branch with the merged token set (a new
  branch + commit + PR, never a direct commit to that branch — see
  [PR-based review gate](#pr-based-review-gate)) and applies the
  GitHub-side resolutions back onto the Figma styles immediately, so
  Figma reflects the resolution right away even while the PR is pending.
- **Status** tab — three-way Figma↔GitHub↔Storybook health check, plus:
  - A banner for the most recent sync's pull request, if it's still open
    ("pending review — the diff below won't resolve until it merges") or
    was closed without merging.
  - **"Rebuild Storybook"** — always visible, disabled (with a tooltip and
    inline note) until a compare finds Storybook stale or never built.
    Triggers the tokens repo's `deploy-storybook.yml` via GitHub's
    `workflow_dispatch` API — rebuild-and-redeploy-to-Pages is scripted,
    but deliberately not automatic on every push; it's a reviewed action
    the user takes from here.
  - **"View Storybook (local)"** — probes `http://localhost:6006` (a
    `no-cors` fetch, since Storybook's dev server sends no CORS headers,
    so a normal fetch can't tell "port closed" apart from "no CORS
    header") and opens it via `figma.openExternal` if something answers.
    If nothing does, shows the exact `npm run storybook` command with a
    one-click copy button instead of opening a dead tab. **A plugin has no
    shell access in either execution context — this can detect the dev
    server, never start it.**
- Last few sync pull requests are listed on the Connect tab as a
  lightweight history/audit trail.

## PR-based review gate

Sync never commits directly to the configured branch. Instead it:

1. Creates a new branch (`design-sync/sync-<timestamp>`) off the current
   tip of that branch.
2. Commits the merged token set there.
3. Opens a pull request: new branch → configured branch.

The configured branch's SHA is untouched by any of this — a Sync that
just happened will usually still show a Figma↔GitHub diff on the next
"Refresh status," because the branch genuinely hasn't caught up until the
PR merges. That's expected, not a bug; the Status tab's pending-PR banner
exists to make that reading obvious. Merging the PR (or requiring review
on it at all) is entirely up to how the branch is configured in
GitHub — this plugin doesn't enforce, request, or auto-merge anything.

Out of scope for this MVP: multi-file/multi-brand support, required-review
enforcement or merge automation (the PR above is a plain, unreviewed PR
the moment it's opened), and writing real Figma Variables back
(GitHub-only tokens land as Styles).

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
from manifest…** and select `manifest.json` in this folder. **Figma only
loads `code.js`/`ui.html` at the moment you launch the plugin** — after any
rebuild, fully close and re-run it (not just click around in an
already-open window) to pick up the change.

`.github/workflows/ci.yml` runs `npm ci && npm run lint && npm run build`
on every push/PR to `main`.

## Architecture

```
┌────────────────────────────── Figma Desktop ──────────────────────────────┐
│                                                                             │
│  ┌─────────────────────────┐   postMessage    ┌────────────────────────┐ │
│  │   code.ts (sandbox)      │◄────────────────►│   ui.ts (iframe)       │ │
│  │                           │                  │                        │ │
│  │  • figma.* document API   │                  │  • fetch() — network   │ │
│  │  • figma.clientStorage    │                  │  • all GitHub API      │ │
│  │  • figma.openExternal()   │                  │    calls (Contents,    │ │
│  │  • NO network access      │                  │    Pull Requests,      │ │
│  │  • reads/writes Styles    │                  │    Actions dispatch)   │ │
│  │    and Variables          │                  │  • diff engine         │ │
│  │                           │                  │  • conflict resolution │ │
│  │                           │                  │  • branch + PR flow    │ │
│  │                           │                  │  • local Storybook     │ │
│  │                           │                  │    reachability check  │ │
│  │                           │                  │  • renders all 4 tabs  │ │
│  └─────────────────────────┘                  └────────────────────────┘ │
│              ▲                                              ▲              │
│              │                                              │              │
│         Figma document                          api.github.com            │
│      (styles, variables,                    (allowedDomains, prod)        │
│       plugin data)                        localhost:6006 (devAllowedDomains,│
│                                                dev-only Storybook check)   │
└─────────────────────────────────────────────────────────────────────────┘
                                       │
                                       │ GitHub REST API
                                       │ (Contents: read/write; Pull Requests:
                                       │  open sync PRs, poll status; Actions:
                                       │  workflow_dispatch)
                                       ▼
                       ┌───────────────────────────────┐
                       │        design-tokens repo       │
                       │  design-tokens.json (source     │
                       │  of truth) + Storybook, both     │
                       │  depending on design-sync-schema │
                       │                                   │
                       │  ci.yml — typecheck/validate/     │
                       │    build on push/PR               │
                       │  deploy-storybook.yml —           │
                       │    workflow_dispatch only,         │
                       │    triggered by the plugin's       │
                       │    "Rebuild Storybook" button      │
                       └───────────────────────────────┘
```

**`code.ts`** — runs in Figma's actual plugin sandbox. Full document access
(styles, variables, plugin data), categorically no network access. Reads
tokens from the Figma document into a common shape, writes tokens from
that shape back into the document, and is the only place that can call
`figma.openExternal()` (the UI iframe can't open external URLs directly).

**`ui.ts`** — runs in the plugin's UI panel, a real (sandboxed) browser
iframe. Has `fetch()` but no document access. Everything involving GitHub
(read, diff, conflict UI, opening the sync PR, triggering the Storybook
workflow), probing the local Storybook dev server, and rendering all four
tabs.

**`shared/tokens.ts`** — re-exports the token model from
`design-sync-schema` and defines the plugin-local types (`GithubSettings`,
`SyncHistoryEntry`, `StorybookSyncMarker`) plus the `postMessage` protocol
between `code.ts` and `ui.ts`.

Because Figma loads `code.js` as a plain script (not an ES module) and
`ui.html` as one self-contained file, both are esbuild-bundled into single
files (`scripts/build-main.mjs`, `scripts/build-ui.mjs`).

## GitHub token

Use a fine-grained personal access token scoped to just the design-tokens
repo, with:

- **Contents: Read and write** — reading `design-tokens.json`/
  `.storybook-sync.json`, and creating the branch + commit a sync PR is
  opened from.
- **Pull requests: Read and write** — Sync opens a PR rather than
  committing directly; the Status tab also polls the most recent PR's
  state.
- **Actions: Read and write** — only needed for the Status tab's "Rebuild
  Storybook" button (`workflow_dispatch`); everything else works without it.

It's stored locally on your machine (Figma's `clientStorage`) and only
ever sent to `api.github.com` (the only production domain this plugin is
allowed to reach, per `manifest.json`'s `networkAccess.allowedDomains`).

## Known limitations / concerns

- **The PR-based review gate has no enforcement behind it.** Sync opens a
  PR instead of committing directly (see
  [PR-based review gate](#pr-based-review-gate)), but that PR is plain and
  unreviewed the moment it's created — whether a review or approval is
  actually *required* before merge is entirely down to how the target
  branch is configured in GitHub (branch protection rules), outside this
  plugin's control or knowledge.
- **No conflict detection between two open sync PRs.** If two people sync
  around the same time, each gets their own branch/PR; the second one to
  merge hits GitHub's normal merge-conflict handling, same as any other
  two branches touching the same file. Nothing here coordinates or warns
  ahead of time.
- **Figma Variable write-back only re-links known variables, never
  creates new ones.** A token with no prior Figma variable history
  (brand-new from GitHub) still becomes a Style — there's no collection/
  mode to put a genuinely new variable in. Write-back also always writes
  a concrete value, never a native `VARIABLE_ALIAS`, even for a token
  that's itself a reference.
- **PAT has no rotation or central management** — sits in per-user
  `figma.clientStorage` indefinitely.
- **`devAllowedDomains` (`http://localhost:6006`) only applies when the
  plugin is loaded via manifest for local development** — the mode this
  repo is actually run in today. If this plugin is ever published (Figma
  Community or an internal org library), the "View Storybook (local)"
  reachability check would silently stop working for installed users,
  since that manifest key is dev-only by Figma's design, not a bug here.
- **"View Storybook (local)" and the GitHub Pages deploy are two separate,
  disconnected destinations.** The button only ever points at
  `localhost:6006`; it does not know about or link to whatever
  `deploy-storybook.yml` publishes to GitHub Pages. If you want a
  one-click link to the *deployed* Storybook too, that's a small addition
  (open `https://<owner>.github.io/<repo>/` instead of/alongside
  localhost) — not done, since it wasn't the ask.
- **No tests** for this plugin's own UI logic (`ui.ts`/`code.ts`) or for
  the `design-tokens` repo's code — only the extracted `design-sync-schema`
  package has unit test coverage so far.
- **No audit trail or rollback** beyond the last-5-pull-requests list on
  the Connect tab and GitHub's own PR/commit history.
