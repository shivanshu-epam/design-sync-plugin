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
GitHub repo, lets you resolve any conflicts, and commits the merged result
— while a companion Storybook in that same repo documents whatever's
currently committed, with a lightweight marker file that tells you if
Storybook is behind.

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
possibly in a different collection) is resolved recursively to its
concrete value before being stored.

**Only COLOR and FLOAT variable types are read.** STRING and BOOLEAN are
skipped — out of scope for this MVP, since neither maps cleanly onto the
token categories in use.

---

## 6. The token model

```ts
interface TokenSet {
  color:      Record<string, { $type: 'color';      $value: string }>;              // hex
  typography: Record<string, { $type: 'typography'; $value: {                       // structured
    fontFamily: string; fontStyle: string; fontSize: number;
    lineHeight: { value: number; unit: 'PIXELS'|'PERCENT'|'AUTO' };
    letterSpacing: { value: number; unit: 'PIXELS'|'PERCENT' };
  }}>;
  shadow:     Record<string, { $type: 'shadow';      $value: ShadowLayer[] }>;       // array (multi-layer)
  dimension:  Record<string, { $type: 'dimension';   $value: string }>;              // "8px"
}
```

This is the exact shape written to `design-tokens.json`. Keys are
slash-delimited paths mirroring whatever naming convention exists in
Figma — a style name directly, or the `Collection/Mode/Variable` path
described above.

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
5. **Sync**, in order:
   a. Commit the merged set to GitHub (single PUT to the Contents API).
   b. Update local state to the new GitHub SHA **immediately** — this
      matters (see §10, bug #3).
   c. Apply GitHub-only changes back onto Figma — creates/updates
      Paint/Text/Effect **styles** (not Variables — see limitations).
      Custom dimension tokens are written back to `figma.root`'s shared
      plugin data; variable-derived dimension tokens never are (see §10,
      bug #5).

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

This means the "sync" between GitHub and Storybook is **manual**: after any
plugin sync that changes tokens, someone needs to run
`npm run build-storybook && git push` in the tokens repo. The Status tab
tells you when that's needed; it doesn't do it automatically (no CI is
wired up — see §11).

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
| **Connect** | GitHub owner/repo/branch/token-file-path + a personal access token. Saved via `figma.clientStorage` (this machine only). Also shows recent sync history (last 5 commits). |
| **Custom Tokens** | Key/value editor for dimension tokens that aren't backed by a Figma Variable (e.g. one-off spacing values). Stored in the Figma file's shared plugin data. |
| **Sync** | The diff/conflict-resolution/commit flow described in §7. Auto-runs on plugin launch and right after saving Connect settings, so you land on the diff without an extra click. |
| **Status** | Read-only three-way health check described in §8, plus the in-app Storybook setup/update guide. |

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

---

## 11. What's explicitly out of scope (for now)

- **Writing real Figma Variables back.** Pulling a GitHub-only token into
  Figma creates/updates a *style*, not a Variable with collections/modes.
  Reading Variables works both ways is a real gap; writing them is a
  separate, larger piece of work.
- **STRING and BOOLEAN variables.** Only COLOR and FLOAT are synced.
- **Automatic Storybook rebuilds.** No GitHub Actions workflow is wired
  up — `npm run build-storybook && git push` is manual. The Status tab
  tells you when it's needed.
- **PR-based review flow.** Syncing commits directly to the configured
  branch — no draft PR, no review step.
- **Multi-file / multi-brand support, rollback UI, audit database, Slack
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
3. If tokens changed: `cd <tokens-repo> && npm run build-storybook && git
   push` to bring Storybook back in sync (or check the **Status** tab
   first to confirm it's actually needed).
4. Anyone can also edit `design-tokens.json` directly on GitHub — the
   plugin picks that up as a "New in GitHub" entry (or conflict, if Figma
   also changed the same key) on the next compare.
