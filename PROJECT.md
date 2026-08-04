# Design Sync — Project Documentation

A working, scoped-down implementation of the "Design Sync" concept: keeping
**Figma**, **GitHub**, and **Storybook** aligned for a design system, built
as a Figma plugin plus a companion tokens repository. This document
explains the problem, what was actually built (vs. the original full
platform vision), how every piece is wired together, and how to set it up
from scratch on a new machine.

---

## 1. The problem

Design systems live across three disconnected tools:

- **Figma** — designers define colors, typography, shadows, spacing as
  Styles and Variables.
- **GitHub** — developers consume those same values as a tokens file (JSON)
  feeding their build.
- **Storybook** — documents/showcases the system for both sides to check
  against.

Nothing keeps these three in sync automatically. Values drift: Figma has a
color GitHub doesn't, GitHub has an edit Figma never saw, Storybook was
built weeks before either changed. The result is the usual: wrong colors in
review, "which one's actually right?" conversations, manual copy-pasting
between tools.

The original brief (see the product doc this project started from)
described a full **Design System Orchestration Platform** — a standalone
backend, audit database, PR-based review workflows, multi-brand support,
rollback UI, Slack notifications, the works. **That is not what this is.**
What follows is a real, working slice of it: one Figma plugin, one GitHub
repo, one Storybook, doing the actual sync — no separate backend service,
no database, no CI required (though it can be added later).

---

## 2. The solution, in one sentence

A Figma plugin reads colors/typography/shadows/spacing directly from the
Figma file (Styles **and** Variables), diffs them against a JSON file in a
GitHub repo, lets you resolve any conflicts, and opens a pull request with
the merged result for review — while a companion Storybook in that same
repo documents whatever's currently merged, with a lightweight marker file
that tells you if Storybook is behind.

```
┌─────────────┐        ┌──────────────────────┐        ┌─────────────┐
│    Figma    │◄──────►│  design-tokens.json  │───────►│  Storybook  │
│ (Styles +   │  Design │   (GitHub repo,       │  build  │ (same repo, │
│  Variables) │  Sync   │    source of truth)   │         │  documents  │
│             │  plugin │                       │         │  the JSON)  │
└─────────────┘        └──────────────────────┘        └─────────────┘
```

---

## 3. Two repositories

This is genuinely two separate projects that talk to each other only
through the tokens file on GitHub — there's no direct connection between
them beyond that.

| Repo | What it is | Where |
|---|---|---|
| **Figma-Github Sync** | The Figma plugin itself (this folder) | Local only, imported into Figma via manifest |
| **design-tokens** | The tokens file + Storybook that documents it | `github.com/<owner>/design-tokens`, cloned locally wherever you run Storybook |

Neither repo depends on the other's source code — the plugin only ever
talks to `design-tokens.json` (and `.storybook-sync.json`) via the GitHub
REST API; the tokens repo has no idea a Figma plugin exists, it just reads
a JSON file that happens to get updated by one.

---

## 4. Architecture — the plugin

Figma plugins have two separate execution contexts with different
capabilities, and that split drives most of the architecture:

```
┌────────────────────────────── Figma Desktop ──────────────────────────────┐
│                                                                             │
│  ┌─────────────────────────┐   postMessage    ┌────────────────────────┐ │
│  │   code.ts (sandbox)      │◄────────────────►│   ui.ts (iframe)       │ │
│  │                           │                  │                        │ │
│  │  • figma.* document API   │                  │  • fetch() — network   │ │
│  │  • figma.clientStorage    │                  │  • all GitHub API      │ │
│  │  • NO network access      │                  │    calls               │ │
│  │  • reads/writes Styles    │                  │  • diff engine         │ │
│  │    and Variables          │                  │  • conflict resolution │ │
│  │                           │                  │  • renders all 4 tabs  │ │
│  └─────────────────────────┘                  └────────────────────────┘ │
│              ▲                                              ▲              │
│              │                                              │              │
│         Figma document                              api.github.com        │
│      (styles, variables,                          (only domain allowed    │
│       plugin data)                                  per manifest.json)    │
└─────────────────────────────────────────────────────────────────────────┘
```

**`code.ts`** — runs in Figma's actual plugin sandbox. Has full access to
the document (styles, variables, plugin data) but categorically no network
access. Its only job: read tokens from the Figma document into a common
shape, and write tokens from that shape back into the document.

**`ui.ts`** — runs in the plugin's UI panel, which is a real (sandboxed)
browser iframe. Has `fetch()` but no document access. Its job: everything
involving GitHub (read, diff, conflict UI, commit), and rendering all four
tabs.

**`shared/tokens.ts`** — the token data model and the `postMessage` message
protocol, imported by both sides so they can't drift out of sync with each
other's expectations.

Because Figma loads `code.js` as a plain script (not an ES module) and
`ui.html` as one self-contained file, both `code.ts`+`shared/` and
`ui.ts`+`shared/` are bundled with **esbuild** into single files
(`scripts/build-main.mjs`, `scripts/build-ui.mjs`) — plain `tsc` compiles
files independently and would leave `import` statements in the output,
which Figma can't load.

---

## 5. How a token gets from Figma into the token model

`code.ts`'s `readFigmaTokens()` builds one `TokenSet` from four sources:

| Category | Source | API |
|---|---|---|
| `color` | Paint styles (single solid fill) | `figma.getLocalPaintStylesAsync()` |
| `color` | COLOR variables, every collection/mode | `figma.variables.getLocalVariablesAsync()` |
| `typography` | Text styles | `figma.getLocalTextStylesAsync()` |
| `shadow` | Effect styles (drop/inner shadow layers) | `figma.getLocalEffectStylesAsync()` |
| `dimension` | Manually-entered custom tokens | `figma.root.getSharedPluginData(...)` |
| `dimension` | FLOAT variables, every collection/mode | `figma.variables.getLocalVariablesAsync()` |
| `string` | STRING variables, every collection/mode | `figma.variables.getLocalVariablesAsync()` |
| `boolean` | BOOLEAN variables, every collection/mode | `figma.variables.getLocalVariablesAsync()` |

**Why both Styles and Variables:** Figma's Variables plugin API needs an
Enterprise-tier *file* (not viewer) to have variables at all — but reading
them via the plugin API works regardless of the *viewer's own* plan, since
it's gated by the file/team's entitlement, not yours. Styles cover simpler
files; Variables cover files like this project's actual test case (EPAM
UUI), where colors/spacing are organized into Variable collections
(`Theme`, with 5 modes: Loveship-Light/Dark, Promo, Electric-Light/Dark).

**Variable keys** are built as `CollectionName/[ModeName/]VariableName` —
mode name only included when a collection has more than one mode. A
variable whose value is a `VARIABLE_ALIAS` (points at another variable,
possibly in a different collection) is stored as a **live reference**
(`{ kind: 'reference', refKey: '<category>/<key>' }`), not flattened to a
concrete value at read time — see §6. If the alias target isn't in Figma's
currently-active variable list (an orphaned reference — the target was
deleted but something still points at it), it falls back to a resolved
concrete snapshot instead of failing the read.

**All four variable types are read**: COLOR, FLOAT, STRING, and BOOLEAN.

---

## 6. The token model

The schema, resolution, and validation logic used to live here **and**
hand-duplicated in the tokens repo — a real drift risk, patched twice in
two places before being extracted. It now lives in one place: a small
shared package, [`design-sync-schema`](https://github.com/shivanshu-epam/Atlassian-design-system),
that both repos depend on as a real `github:` package dependency
(auto-built via `prepare` on install), with 19 unit tests covering exactly
the bug classes below.

```ts
type TokenValue<T> =
  | { kind: 'value'; value: T }
  | { kind: 'reference'; refKey: string };  // '<category>/<key>'

interface DesignToken<T> {
  $type: TokenCategory;   // 'color' | 'typography' | 'shadow' | 'dimension' | 'string' | 'boolean'
  $value: TokenValue<T>;
  $description?: string;
  $extensions?: { 'design-sync.figmaSourceType'?: 'style' | 'variable' };
}

interface TokenSet {
  color:      Record<string, DesignToken<string>>;         // hex
  typography: Record<string, DesignToken<TypographyValue>>;
  shadow:     Record<string, DesignToken<ShadowLayer[]>>;  // multi-layer
  dimension:  Record<string, DesignToken<string>>;         // "8px"
  string:     Record<string, DesignToken<string>>;
  boolean:    Record<string, DesignToken<boolean>>;
}
```

This is a **breaking change from the original flat-value shape**
(`$value: <concrete value>`, aliases eagerly resolved at read time and
never preserved) — the DTCG-aligned `kind: 'value' | 'reference'` wrapper
is what lets a semantic token stay linked to the primitive it points at
instead of losing that relationship the moment it's read out of Figma.
`resolveToken()` walks a reference chain to its concrete value on demand;
`validateTokenSet()` detects broken and circular references (direct and
indirect) so they can be surfaced as individual, skippable conflicts
rather than blocking an entire sync. Tokens still found in the old flat
shape are auto-normalized on read, in memory — no manual migration script
needs to be run against an out-of-date `design-tokens.json`.

Keys are slash-delimited paths mirroring whatever naming convention
exists in Figma — a style name directly, or the `Collection/Mode/Variable`
path described above.

---

## 7. The sync algorithm (Sync tab)

1. **Read Figma** — `code.ts` builds the current `TokenSet` (styles +
   variables) and sends it to `ui.ts`.
2. **Read GitHub** — `ui.ts` fetches `design-tokens.json` from the
   configured repo/branch/path via the GitHub Contents API.
3. **Diff** — for every key across all four categories, in either set:
   - only in Figma → `added-figma`
   - only in GitHub → `added-github`
   - in both, different value → `modified` (conflict)
   - in both, same value → `unchanged` (not shown)
4. **Resolve** — `added-*` entries default to *included*, with an explicit
   per-row "skip" checkbox. `modified` conflicts have **no default** — Use
   Figma / Use GitHub / Skip must be picked explicitly per row (or in bulk)
   before the Sync button unlocks, so nothing gets silently overwritten.
5. **Sync**, in order (Phase 3 — PR-based review gate; see §10, bug #9 for
   the earlier direct-commit version and why it changed):
   a. Create a new branch (`design-sync/sync-<timestamp>`) off the current
      tip of `settings.branch`.
   b. Commit the merged token set to that new branch (PUT to the Contents
      API, targeting the new branch, not `settings.branch`).
   c. Open a pull request: new branch → `settings.branch`. Nothing lands
      on the branch Storybook/downstream builds consume without someone
      merging that PR.
   d. Apply GitHub-side resolutions back onto Figma. As of Phase 2, a
      token that was originally read *from* a Figma Variable (has
      `design-sync.variableId` + `design-sync.modeId` in `$extensions`)
      writes back to that same variable's mode
      (`variable.setValueForMode`) — everything else (brand-new tokens
      with no Figma variable history, plus typography/shadow, which have
      no Figma Variable type at all) still creates/updates a Paint/Text/
      Effect **style**. Custom dimension/string/boolean tokens with no
      variable history are written to `figma.root`'s shared plugin data;
      variable-backed ones are not (they're re-read live from the
      variable itself on the next `readFigmaTokens()` call). This happens
      immediately, **not** gated on the PR merging — Figma is a local
      design file, not the shared repo the review gate protects, so
      there's nothing to review-gate here.

   Because `settings.branch` itself is never written to directly, its SHA
   never changes as a side effect of Sync — the original reason for
   eagerly updating local state right after a commit (§10, bug #3) no
   longer applies. A **side effect worth understanding**: the next
   "Refresh status" after a Sync will usually still show a Figma↔GitHub
   diff, because `settings.branch` genuinely hasn't caught up yet — that's
   expected, not a bug, and the Status tab surfaces the open PR so it
   reads as "pending review," not "broken."

---

## 8. Storybook, and the three-way status check

Storybook is a **static build**, not a live service the plugin can query —
so unlike Figma↔GitHub, there's no per-token comparison possible. Instead:

- `npm run build-storybook` in the tokens repo runs a **postbuild hook**
  (`scripts/record-sync-marker.mjs`) that computes the git blob SHA of
  `design-tokens.json` (`git hash-object`, which produces byte-identical
  SHAs to what GitHub's API reports for the same file) and writes it to
  `.storybook-sync.json` at the repo root, alongside a build timestamp.
- The plugin's **Status** tab fetches both `design-tokens.json`'s current
  SHA and `.storybook-sync.json`'s `tokensBlobSha`. If they match,
  Storybook reflects what's on GitHub right now; if not, it's stale (or
  `.storybook-sync.json` doesn't exist yet — never built).

Bringing Storybook back in sync is **scripted but deliberately not
automatic**: `design-tokens/.github/workflows/deploy-storybook.yml`
rebuilds Storybook, deploys it to GitHub Pages, and commits the refreshed
`.storybook-sync.json` back to the repo — but it only has a
`workflow_dispatch` trigger, no `on: push`. The Status tab's **"Rebuild
Storybook"** button calls that `workflow_dispatch` API directly once it
detects Storybook is behind; running it manually (`gh workflow run
deploy-storybook.yml`, or the button in the repo's Actions tab) works too.
Rebuilding on *every* push was considered and rejected — it turns a
reviewable action into a side effect of every commit, including ones that
don't touch tokens at all.

The Status tab shows this as two explicit sections plus an overall banner:

```
✓ Figma, GitHub, and Storybook are all in sync.     ← overall
1. Figma ↔ GitHub        [table of any differing tokens]
2. GitHub ↔ Storybook    [in-sync / stale / never-built + a setup/update guide]
```

---

## 9. Plugin UI — all four tabs

| Tab | Purpose |
|---|---|
| **Connect** | GitHub owner/repo/branch/token-file-path + a personal access token. Saved via `figma.clientStorage` (this machine only). A "Find repository" search field lists every repo the token can see (`GET /user/repos`) and auto-fills owner/name/branch on selection — manual entry still works too. Also shows recent sync history (last 5 pull requests). |
| **Custom Tokens** | Key/value editor for dimension tokens that aren't backed by a Figma Variable (e.g. one-off spacing values). Stored in the Figma file's shared plugin data. |
| **Sync** | The diff/conflict-resolution/PR flow described in §7. Auto-runs on plugin launch and right after saving Connect settings, so you land on the diff without an extra click. |
| **Status** | Three-way health check described in §8, a banner for the most recent sync's pull request if it's still open or was closed unmerged, the in-app Storybook setup/update guide, a **"Rebuild Storybook"** button (`workflow_dispatch`-triggers the deploy workflow once something's stale), and a **"View Storybook (local)"** button (checks `localhost:6006` is reachable, opens it if so, otherwise shows the exact `npm run storybook` command with a copy button — a plugin can't start that server itself). |

---

## 10. Real bugs hit building this, and why the fixes are what they are

Worth keeping — these are exactly the kind of thing that reappears if this
gets rebuilt or extended later.

1. **`code.js` had a bare `import` statement → Figma refused to load it**
   ("syntax error, expected '('"). Figma loads `code.js` as a plain
   script, not a module; plain `tsc` compiles files independently and
   doesn't bundle. Fix: `code.ts` gets esbuild-bundled with `shared/`
   into one file, exactly like `ui.ts` already was.

2. **Sync required reopening the plugin to see results.** Fixed by
   auto-running the compare on plugin launch (if already connected) and
   immediately after saving Connect settings — no more manual "fetch and
   compare" click needed for the common case.

3. **409 "sha does not match" on retry, after a partial sync failure.**
   `state.githubSha` was only updated *after* the Figma-apply step
   succeeded — but the GitHub commit happens first and independently. If
   applying back to Figma failed (e.g. view-only file access), the commit
   still went through, but local state didn't know, so the next attempt
   sent a now-stale SHA. Fix: update local GitHub-side state immediately
   after the commit succeeds, before attempting the Figma-apply step.

4. **"Unexpected end of JSON input" once the token set passed ~1.5MB.**
   GitHub's Contents API only inlines base64 `content` for files under
   1MB; above that it's empty. Fix: fetch metadata (for the SHA) with the
   default request, then fetch actual content with
   `Accept: application/vnd.github.raw+json`, which has no such limit.

5. **"setSharedPluginData... exceeds 100kB per entry limit."** Once
   Variables were added as a dimension-token source (6,000+ entries), the
   apply-to-Figma step tried to write the *entire* dimension set —
   custom + variable-derived — into one plugin-data blob. Figma caps each
   entry at 100kB. Fix: only the genuinely custom (manually-entered)
   subset gets persisted there; variable-derived dimension tokens are
   always re-read live from Figma's Variables and never needed
   duplicating into plugin data in the first place.

6. **Manual GitHub edits, and even tokens that definitely existed on
   GitHub, weren't showing up in the diff.** `fetch()` calls had no
   explicit cache policy, so the browser could legitimately serve a
   stale cached response for a URL requested repeatedly (exactly what
   every re-compare does). Fix: `cache: 'no-store'` on every GitHub
   request.

7. **Storybook became effectively unbrowsable once the token set hit
   ~11,600 entries** (Figma Variables expansion: 1,084 variables × 5
   theme modes, on top of styles). Fixed with a search box and
   collapsible groups (large groups collapsed by default) on every story
   page, plus finer-grained grouping (collection **and** mode, not just
   collection) so no single group renders thousands of entries at once.
   Also stopped TypeScript from inferring a literal type over the
   1.6MB JSON import — pure overhead, since it's cast away immediately.

8. **Plugin failed to load entirely ("unable to run") after adding a
   `localhost` domain to `networkAccess.allowedDomains`.** That key only
   accepts `https://` domains in production; a plain-HTTP entry fails
   manifest validation outright rather than just being ignored. Fix:
   `http://localhost:6006` moved to the separate `devAllowedDomains` key,
   which is specifically for non-HTTPS/local-only domains and only takes
   effect while the plugin is loaded via manifest for development — see
   the corresponding note in §11.

9. **Direct-commit Sync was a real risk, not a hypothetical one.** Anyone
   with the plugin configured could push straight to `settings.branch` —
   no review, no second pair of eyes, before landing on the branch
   Storybook/downstream consumers actually build from. Fixed by switching
   Sync to the branch+PR flow in §7: `settings.branch` itself is never
   written to directly. One consequence worth calling out because it's
   easy to mistake for a bug — since the base branch doesn't move,
   `state.githubSha`/`state.githubTokens` are correctly left untouched
   after a sync, and the next "Refresh status" will keep showing the
   just-resolved tokens as differing until the PR is actually merged.
   That's the review gate working as intended, not a regression; the
   Status tab's pending-PR banner exists specifically to make that
   reading obvious instead of alarming.

10. **Resolving a conflict in GitHub's favor for a variable-backed
    dimension/string/boolean token silently did nothing** — found while
    building Phase 2's write-back. `applyTokensToFigma` excluded any key
    matching a *currently live* Figma variable from the plugin-data write
    (reasonable — those re-read live, no need to duplicate them), but
    nothing else ever wrote the resolved value anywhere either. The
    exclusion check itself was also fragile: "does a live variable happen
    to have this exact key name right now" is a proxy for "was this
    variable-derived," and breaks the moment a variable is renamed. Fixed
    by reading each token's own `$extensions` (the authoritative answer,
    already computed at read time) instead of re-deriving it from
    current variable names, and by actually writing the value back via
    `variable.setValueForMode` when that's what it points at.

---

## 11. What's explicitly out of scope (for now)

- **Creating brand-new Figma Variables.** Write-back (§7 step 5d) only
  re-links a token to a variable it already has documented history with
  (`design-sync.variableId`/`modeId` in `$extensions`, set at read time).
  A token with no such history — brand-new from GitHub — still becomes a
  Style, since there's no collection/mode to place a genuinely new
  variable in without asking the user to choose one.
- **Native `VARIABLE_ALIAS` write-back.** A token whose value is itself a
  reference always gets resolved to a concrete value before being
  written, even when the destination is a real Variable. Figma Variables
  do support aliasing another variable, but doing that safely requires
  the reference's target to itself be a known Figma variable, which
  isn't guaranteed — e.g. a GitHub-only reference chain has no Figma-side
  variable to point at.
- **No required-review enforcement, no merge automation.** Sync opens a PR
  (§7) instead of committing directly, but that PR is a plain, unreviewed
  pull request the moment it's opened — nothing here enforces branch
  protection, requires an approval, or auto-merges anything. Whether
  reviews are actually required is entirely down to how `settings.branch`
  is configured in GitHub, outside this plugin's control.
- **No conflict detection between two open sync PRs.** If two people sync
  around the same time, each gets their own branch/PR — GitHub's normal
  merge-conflict handling applies to the second one, same as it would for
  any two branches editing the same file; nothing plugin-side coordinates
  or warns about this ahead of time.
- **The "View Storybook (local)" reachability check only works while the
  plugin is loaded via manifest for local development** —
  `devAllowedDomains` in `manifest.json` (needed to permit the
  `localhost:6006` fetch) is a dev-only manifest key by Figma's design. If
  this plugin is ever published, that check silently stops working for
  installed users.
- **No CI on this plugin repo or the tokens repo checks logic beyond
  build/typecheck/validate** — no tests for `ui.ts`/`code.ts`, or for the
  tokens repo's own scripts. Only the extracted `design-sync-schema`
  package has unit test coverage.
- **No audit trail or rollback** beyond the last-5-pull-requests list on
  the Connect tab and GitHub's own PR/commit history.
- **PAT has no rotation or central management** — sits in per-user
  `figma.clientStorage` indefinitely.
- **Multi-file / multi-brand support, audit database, Slack
  notifications** — all part of the original "Design Sync" platform
  vision, none of it built here. This project is the Figma↔GitHub↔
  Storybook loop only.

---

## 12. Setup on a new device

### 12a. The Figma plugin

```bash
# 1. Get the code (copy/clone the "Figma-Github Sync" folder)
cd "Figma-Github Sync"

# 2. Install dependencies (esbuild, typescript, eslint, @figma/plugin-typings)
npm install

# 3. Build — produces code.js and ui.html (both gitignored, generated)
npm run build
```

Then in the **Figma desktop app** (this doesn't work in the browser
version): **Plugins → Development → Import plugin from manifest…**, select
`manifest.json` in this folder.

While developing, run both watchers in separate terminals (more reliable
than the combined `npm run watch`, which backgrounds one of them):

```bash
npm run watch:main   # rebuilds code.js on change
npm run watch:ui     # rebuilds ui.html on change
```

**Figma only loads `code.js`/`ui.html` at the moment you launch the
plugin** — after any rebuild, fully close and re-run the plugin (not just
click around in an already-open window) to pick up the change.

### 12b. GitHub access

Create a **fine-grained personal access token**:
[github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
— repository access limited to the tokens repo, **Contents: Read and
write** permission only. In the plugin's **Connect** tab, fill in:

| Field | Value |
|---|---|
| Repository owner | your GitHub username/org |
| Repository name | e.g. `design-tokens` |
| Branch | e.g. `main` |
| Token file path | e.g. `design-tokens.json` (repo root) |
| Personal access token | the `github_pat_…` value above |

Click **Test connection**, then **Save** — this jumps straight to the Sync
tab and runs the first comparison automatically. The token is stored via
`figma.clientStorage` (this machine only, never sent anywhere except
`api.github.com`).

### 12c. The tokens repo + Storybook

If it doesn't exist yet, create an empty GitHub repo first (the plugin
writes into an existing repo, it doesn't create one). Then, to work with
Storybook locally:

```bash
git clone https://github.com/<owner>/<repo>.git
cd <repo>
npm install

npm run storybook          # dev server at localhost:6006
npm run build-storybook    # static build + refreshes .storybook-sync.json
```

If Storybook isn't set up in the repo yet at all, the plugin's **Status**
tab has a step-by-step guide (with your actual repo URL filled in)
whenever it detects Storybook has never been built.

---

## 13. Day-to-day usage, once everything's connected

1. Design in Figma as normal (edit Paint/Text/Effect styles, or
   Variables if the file has them).
2. Open the plugin → **Sync** tab (or **Status**, to just check without
   committing) → review the diff → resolve any conflicts → **Sync**.
3. If tokens changed: click **"Rebuild Storybook"** on the **Status** tab
   (only enabled once it detects Storybook is actually behind) to trigger
   the deploy workflow directly from the plugin — or run
   `cd <tokens-repo> && npm run build-storybook && git push` manually if
   you'd rather not grant the PAT `Actions: write`.
4. Anyone can also edit `design-tokens.json` directly on GitHub — the
   plugin picks that up as a "New in GitHub" entry (or conflict, if Figma
   also changed the same key) on the next compare.
