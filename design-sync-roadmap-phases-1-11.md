# Design Sync — Extension Roadmap (Phases 1–23)

**Purpose of this document**: This is a build-ready engineering specification for an LLM
developer (or a human engineer) to implement, phase by phase, on top of the *existing*
Design Sync codebase — the "Figma-Github Sync" plugin and its companion `design-tokens`
repository, as documented in the original `README.md`. This is **not** a rewrite. Every
phase below is scoped as an extension: new files where genuinely new capability is
needed, modifications to existing files where behavior changes, and explicit call-outs
of exactly which existing function/tab/module each phase touches.

**How to use this doc**: Each phase is self-contained enough to hand to an LLM as a
single work order, but phases have real dependencies (see §25). Do not build Phase 7
before Phase 1. Do not build Phase 11 before Phase 1 and Phase 10. Do not build Phase 15
before Phase 11. Do not build Phase 21's screenshot step assuming Phase 18 exists — it
doesn't require it. The dependency graph in §25 is authoritative if this doc and phase
ordering ever seem to disagree.

**Status and priority** (updated 2026-08-05, reflecting an explicit product decision —
not a default or a guess): each phase now carries a `**Status**` and `**Priority**` line
directly under its heading. See §1a immediately below for the full table and what each
value means. Priorities are sticky until explicitly revisited — do not re-litigate a
"Lowest" or "Medium — not now" call inside an individual phase's own section.

**Ground rule for every phase**: preserve the existing sandbox/iframe split
(`code.ts` = Figma document access, no network; `ui.ts` = network + GitHub + UI, no
document access; `shared/tokens.ts` = types + message protocol used by both). Any new
capability that needs both document access and network access must be split across
that boundary via `postMessage`, exactly like every existing feature. Do not attempt to
add `fetch()` to `code.ts` or `figma.*` calls to `ui.ts` — both are hard platform
limitations, not stylistic choices (see original README §4).

---

## 0. Current system recap (context for the LLM developer)

Before touching any phase below, load and understand these existing pieces:

- **Two repos**: `Figma-Github Sync` (the plugin, local-only until built) and
  `design-tokens` (GitHub repo containing `design-tokens.json`, `.storybook-sync.json`,
  and a Storybook instance). They communicate *only* through
  `design-tokens.json`/`.storybook-sync.json` via the GitHub REST API. No phase below
  should introduce a direct code dependency between them beyond that file contract,
  unless the phase explicitly says otherwise (Phase 3, Phase 4, Phase 10 all extend the
  file contract, not replace it).
- **`TokenSet` interface** (`shared/tokens.ts`): four categories — `color`,
  `typography`, `shadow`, `dimension` — each a `Record<string, { $type, $value }>`.
  Keys are slash-delimited (`Collection/Mode/Variable` or a raw style name).
- **Sync algorithm** (`ui.ts`, Sync tab): read Figma → read GitHub → diff → resolve
  conflicts → commit to GitHub → apply GitHub-only changes back to Figma (styles only,
  not Variables — this is Phase 2's target).
- **Storybook sync marker**: `scripts/record-sync-marker.mjs`, a postbuild hook that
  writes `.storybook-sync.json` with the git blob SHA of `design-tokens.json` at build
  time. Status tab compares this SHA against the live GitHub SHA.
- **Known constraints already discovered and fixed** (do not reintroduce these bugs):
  GitHub Contents API only inlines `content` under 1MB (must fetch via
  `Accept: application/vnd.github.raw+json` above that); `figma.root.setSharedPluginData`
  caps each entry at 100kB; every GitHub `fetch()` needs `cache: 'no-store'`; `code.js`
  must be esbuild-bundled (no bare ES module imports, Figma loads it as a plain script).

---

## 1. Global conventions for every phase below

- **Language**: TypeScript throughout, matching existing strictness. New modules go
  under `src/` in whichever repo they belong to, mirroring existing folder shape
  (`code.ts`, `ui.ts`, `shared/`, `scripts/`).
- **Bundling**: any new sandbox-side code gets added to the `build-main.mjs` esbuild
  entry; any new UI-side code to `build-ui.mjs`. Never introduce a third bundle unless a
  phase explicitly creates a new execution context (Phase 10's backend service is the
  only phase that does).
- **State**: continue using `figma.clientStorage` for anything plugin-local and
  machine-specific (tokens, per-user settings). Anything that must be shared across a
  team (audit history, multi-repo config, drift allowlists) is a new file committed to
  the `design-tokens` repo, not `clientStorage` — `clientStorage` is explicitly
  single-machine per the original README §9 and must stay that way.
- **GitHub API usage**: every new GitHub call reuses the existing fine-grained PAT flow
  from the Connect tab. Do not introduce a second auth mechanism unless a phase says so
  (Phase 3's PR flow needs `pull_requests: write` added to the PAT's permission scope —
  call this out explicitly to the user in the Connect tab's token-creation instructions).
- **Testing bar for every phase**: unit tests for pure logic (diff algorithms, matching
  algorithms, parsers) using the existing test setup; a manual QA checklist for
  Figma-side behavior, since Figma's plugin sandbox cannot be meaningfully unit-tested
  end-to-end.
- **Backward compatibility**: every phase must leave a user who has *not* adopted the
  new capability with unchanged behavior. New tabs are additive. New fields in
  `design-tokens.json` are optional and ignored by older plugin versions where feasible.

---

## 1a. Status and priority overview

Legend:
- **Status**: `✅ Shipped` (built and released — see the plugin's own `CHANGELOG.md` for
  the version), `🟡 Partial` (some of the phase shipped, some didn't), `❌ Not started`.
- **Priority**: `Now` (actively being worked), `Medium — not now` (real, worth doing,
  deliberately not picked up yet), `Lowest — no current use case` (no known need right
  now; revisit if that changes), `Blocked` (depends on a phase that isn't started),
  or unset for phases proposed but not yet prioritized by the user.

| # | Phase | Status | Priority |
|---|---|---|---|
| 1 | Token model completeness | ✅ Shipped | — (foundation, done) |
| 2 | Bidirectional Variable write-back | ✅ Shipped | — (done) |
| 3 | PR-based governed sync | ✅ Shipped | — (done) |
| 4 | CI/CD automation | ✅ Shipped | — (done) |
| 5 | Versioned audit trail and rollback | ✅ Shipped, defect fixed v1.20.0 | — (done) |
| 6 | Multi-brand / multi-file orchestration | ❌ Not started | **Lowest — no current use case** (see §7's new-evidence note — a consultancy/agency buyer profile makes this look more load-bearing; priority not yet revisited) |
| 7 | Semantic diff and AI-assisted conflict resolution | ❌ Not started | **Medium — not now** |
| 8 | Cross-platform distribution (Style Dictionary) | ❌ Not started | **Lowest — no current use case** |
| 9 | Notifications and live collaboration | 🟡 Partial — notifications shipped (v1.8.0); the static status page shipped (v1.11.0) then was explicitly reverted (v1.11.1, "not wanted") | Notifications: done. Status page: rejected, not planned. |
| 10 | Enterprise backend and platform layer | ❌ Not started | **Medium — not now** |
| 11 | Consumption-side drift detection | ❌ Not started | Blocked — needs Phase 1 (done) and Phase 10 (medium, not now) |
| 12 | PR preview builds | ❌ Not started | Unprioritized (new, proposed 2026-08-05) |
| 13 | Contrast/accessibility linting at sync time | ❌ Not started | Unprioritized (new, proposed 2026-08-05) |
| 14 | Token deprecation lifecycle | ❌ Not started | Unprioritized (new, proposed 2026-08-05) |
| 15 | Pre-sync blast-radius preview | ❌ Not started | Unprioritized (new, proposed 2026-08-05) — Blocked on Phase 11 regardless |
| 16 | Concurrent-sync advisory lock | ❌ Not started | Unprioritized (new, proposed 2026-08-05) |
| 17 | Deep-linking between Storybook/status page and Figma | ❌ Not started | Unprioritized (new, proposed 2026-08-05) |
| 18 | Dedicated Storybook repo (split from `design-tokens`) | ❌ Not started | Unprioritized (new, proposed 2026-08-05) |
| 19 | PR governance agent (policy-based auto-merge) | ❌ Not started | Unprioritized (new, proposed 2026-08-05) |
| 20 | Notification routing — groups + urgency-based mentions | ❌ Not started | Unprioritized (new, proposed 2026-08-05) — extends Phase 9 |
| 21 | SDLC / issue-tracker integration (JIRA, Planner) | ❌ Not started | Unprioritized (new, proposed 2026-08-05) |
| 22 | In-plugin release notifications | ✅ Shipped (v1.19.0) | — (done) |
| 23 | Visual design language revamp (v2) | ✅ Shipped, v1.20.0 — all 5 tabs (see §24) | — (done) |

Separately: the plugin's v1.12.0–v1.16.2 release series (icons, progressive disclosure,
the full tab-by-tab UI redesign) is **not** one of these phases — it's an orthogonal
UX-polish track layered on top of whatever capability already exists, not new capability
itself. See `CHANGELOG.md` for that work.

---

## 1b. Known implementation gaps (not yet phases)

Surfaced from a pros/cons review of the current build (2026-08-05). These are honest
weaknesses in what's already shipped, not new capability requests — listed here so
they're tracked rather than lost, not because each one needs its own phase.

- **No automated test coverage on the plugin's own UI/interaction logic.** Only
  `design-sync-schema` (pure token-model functions) has unit tests today —
  `ui.ts`/`code.ts` (rendering, state, the actual redesigned tabs) have none. A
  regression in interaction logic is caught by manual QA only, not CI. Worth a
  lightweight pass (e.g. testing the pure state-transition functions the way
  `sync-logic.ts` already is) before this grows much further, rather than a full phase.
- **PAT scope keeps growing with no central management.** Four scopes now (Contents,
  Pull requests, Actions, Pages), each per-user, per-machine, with no rotation or
  revocation story. This is exactly what Phase 10's scoped API tokens would replace —
  see that phase's updated Problem section below.
- **Conservative Variable write-back** (Phase 2, already shipped): a GitHub-side
  resolution only re-links a token to a Figma Variable it already has history with — a
  brand-new token from GitHub still becomes a Style, never a newly-created Variable.
  Documented in README's Known Limitations; not re-scoped here since fixing it doesn't
  change user-facing capability, just write fidelity.
- **Storybook bundles the full token JSON directly** (currently ~5MB), producing a
  build-time chunk-size warning. Fine at today's scale; would need addressing (most
  likely fetching at runtime instead of bundling) if the token set grows substantially
  further. Not urgent enough to scope as its own phase yet.
- **Figma-only.** Every phase above is built against Figma's plugin API and Variables
  model specifically. Supporting another design tool (Sketch, Adobe XD, Penpot) would be
  a substantial rebuild, not an extension — noted for awareness, explicitly out of scope
  for this roadmap.

---

## 2. Phase 1 — Token model completeness

**Status**: ✅ Shipped. **Priority**: — (foundation; everything else depends on this).

### Goal
Extend the `TokenSet` model to cover STRING and FLOAT-adjacent BOOLEAN variables,
support composite/tiered tokens (primitive → semantic → component reference chains),
and align the on-disk JSON shape with the DTCG (Design Tokens Community Group) format
so `design-tokens.json` interops with external tooling (Style Dictionary, Tokens
Studio) without a bespoke adapter.

### Problem addressed
Original README §5: "Only COLOR and FLOAT variable types are read... out of scope for
this MVP." This blocks any file using STRING variables (font family tokens, icon
names) or BOOLEAN variables (feature flags baked into the design file, e.g.
`isDarkModeDefault`). It also blocks reference chains — today every token stores a
*resolved* value, with alias resolution happening once at read time and the alias
relationship itself discarded (README §5: "resolved recursively to its concrete value
before being stored"). That's lossy: semantic tokens lose their link to primitives,
so renaming a primitive doesn't propagate.

### Dependencies
None — this is a foundation phase. Should be built first.

### Files touched
- `shared/tokens.ts` — extend `TokenSet` and add new types.
- `code.ts` — extend `readFigmaTokens()` to read STRING/BOOLEAN variables and preserve
  alias chains instead of eagerly resolving them.
- `ui.ts` — extend the diff engine to handle the two new categories and reference
  tokens; extend Custom Tokens tab UI for the new types.
- `scripts/` — add a migration script (`migrate-tokens-v2.mjs`) to upgrade an existing
  `design-tokens.json` from the current shape to the new DTCG-aligned shape once, and a
  validator script (`validate-tokens.mjs`) that runs in CI (used later by Phase 4).

### Data model changes

```ts
// shared/tokens.ts

export type TokenType = 'color' | 'typography' | 'shadow' | 'dimension' | 'string' | 'boolean';

// A token value is now EITHER a concrete value OR a reference to another token.
// This is the key structural change: aliasing is now first-class, not resolved-away.
export type TokenValue<T> =
  | { kind: 'value'; value: T }
  | { kind: 'reference'; refKey: string }; // refKey = full path to another token, e.g. "color/primitive/blue-500"

export interface DesignToken<T = unknown> {
  $type: TokenType;
  $value: TokenValue<T>;
  $description?: string;      // new: optional, carried over from Figma variable/style description if present
  $extensions?: {
    'design-sync.figmaSourceType'?: 'style' | 'variable'; // preserves provenance for round-tripping
    'design-sync.variableId'?: string;                     // Figma variable id, for stable re-linking on write-back (needed by Phase 2)
  };
}

export interface TokenSet {
  color:      Record<string, DesignToken<string>>;   // hex, or reference
  typography: Record<string, DesignToken<TypographyValue>>;
  shadow:     Record<string, DesignToken<ShadowLayer[]>>;
  dimension:  Record<string, DesignToken<string>>;    // "8px", or reference
  string:     Record<string, DesignToken<string>>;    // NEW — font family names, icon keys, etc.
  boolean:    Record<string, DesignToken<boolean>>;   // NEW — feature-flag-shaped variables
}

// Resolution helper — used wherever a concrete value is needed (e.g. diffing, Storybook rendering)
// Must detect and reject circular references rather than infinite-looping.
export function resolveToken<T>(key: string, set: TokenSet, category: TokenType, visited?: Set<string>): T;
```

### Algorithm changes in `code.ts`

`readFigmaTokens()` currently resolves `VARIABLE_ALIAS` recursively to a concrete value
at read time (README §5). Change this to:

1. When a variable's value is a `VARIABLE_ALIAS`, look up the aliased variable's stable
   key (same `CollectionName/[ModeName/]VariableName` scheme already used).
2. Store `{ kind: 'reference', refKey: <that key> }` instead of resolving immediately.
3. Add a **post-pass** `assertNoCycles(tokenSet)` that walks every reference chain and
   throws a descriptive error (surfaced in the Sync tab as a blocking validation error,
   not a silent failure) if a cycle is detected — this can happen if a designer creates
   A→B→A in Figma Variables, which Figma itself permits at the raw variable level.
4. Add STRING and BOOLEAN to the existing `figma.variables.getLocalVariablesAsync()`
   loop (currently filtered to COLOR/FLOAT only — this is a one-line filter change,
   the hard part is step 1–3 above and the new UI for editing these types).

### UI changes
- Custom Tokens tab: add two new sections, "Custom string tokens" and "Custom boolean
  tokens", following the existing key/value editor pattern used for dimension tokens.
- Sync tab diff table: add `string` and `boolean` as diffable categories, same
  added-figma / added-github / modified / unchanged logic as the existing four.
- New: a "reference" badge next to any token whose value is `{ kind: 'reference' }` in
  the diff table, with the resolved value shown in parentheses so reviewers aren't
  looking at an opaque key.

### Migration
`migrate-tokens-v2.mjs`: reads the current flat-value `design-tokens.json`, wraps every
value in `{ kind: 'value', value: <existing value> }`, adds empty `string`/`boolean`
sections, writes the file back, and commits it as `chore: migrate tokens to v2 schema
(design-sync)`. Must be run once, manually, by the repo owner — do not auto-run this
from the plugin, since it's a one-time repo-wide schema change that deserves a human
looking at the diff before pushing.

### Acceptance criteria
- A Figma file with STRING and BOOLEAN variables produces correct entries in the diff
  table and round-trips through a full sync without data loss.
- A semantic token (`color/semantic/brand-primary`) that references a primitive
  (`color/primitive/blue-600`) survives a sync as a reference, not a resolved hex.
- Renaming the primitive's *value* (not its key) in Figma correctly shows the semantic
  token's resolved value changing in the diff table, without the semantic token itself
  appearing as "modified" (since its reference target didn't change, only what that
  target resolves to).
- Circular references are caught and reported, never silently resolved to `undefined`
  or causing an infinite loop.

### Rejected alternatives
- **Keep resolving aliases eagerly, just also store the alias name as metadata.**
  Rejected: this still loses the live link — renaming a primitive's value wouldn't
  propagate to anything without a full re-sync, defeating the purpose of semantic
  tokens in the first place.
- **Full DTCG spec compliance including composite types (border, transition) in this
  phase.** Rejected as over-scoped for Phase 1 — color/dimension/typography/shadow
  composites can follow in a later iteration once the reference model above is proven;
  shipping STRING/BOOLEAN + references first de-risks the harder schema change.

---

## 3. Phase 2 — Bidirectional Variable write-back

**Status**: ✅ Shipped. **Priority**: — (done).

### Goal
When a GitHub-only token is applied back into Figma, create or update a Figma
**Variable** (with correct collection/mode structure) when the token's
`$extensions['design-sync.figmaSourceType']` says `variable`, instead of always
creating a Style as happens today.

### Problem addressed
Original README §11: "Writing real Figma Variables back... is a real gap; writing them
is a separate, larger piece of work." This is the single largest asymmetry in the
current sync: reads support Variables, writes don't. Any team fully migrated to
Variables (like this project's own EPAM UUI test case) can pull tokens *out* of Figma
but never push a GitHub-authored token *into* Figma as a proper Variable.

### Dependencies
Requires Phase 1 (`$extensions['design-sync.figmaSourceType']` and
`$extensions['design-sync.variableId']` must exist to know what to recreate and to
re-link to the same variable on subsequent syncs rather than creating duplicates).

### Files touched
- `code.ts` — new function `applyTokensAsVariables()`, called from the existing
  apply-to-Figma step (§7 step 5c in the original README) alongside the existing
  style-writing path.
- `shared/tokens.ts` — no new types needed beyond what Phase 1 added.

### Algorithm

```ts
// code.ts — new function, called instead of the style-writing path
// when $extensions['design-sync.figmaSourceType'] === 'variable'

async function applyTokensAsVariables(tokens: DesignToken[], tokenSet: TokenSet) {
  // Group incoming tokens by collection name (first path segment) so we create/reuse
  // one VariableCollection per group, not one per token.
  const byCollection = groupByCollectionPath(tokens);

  for (const [collectionName, group] of byCollection) {
    // 1. Find existing collection by name, or create it.
    let collection = (await figma.variables.getLocalVariableCollectionsAsync())
      .find(c => c.name === collectionName);
    if (!collection) {
      collection = figma.variables.createVariableCollection(collectionName);
    }

    // 2. Ensure every mode referenced by these tokens exists on the collection.
    //    Figma collections start with exactly one default mode — rename it for the
    //    first mode encountered, addMode() for subsequent ones.
    for (const modeName of group.modeNames) {
      ensureMode(collection, modeName);
    }

    // 3. For each token: find existing variable by stored variableId (re-link, don't
    //    duplicate) — fall back to name match if no id (first-time write from a token
    //    that originated on GitHub, never existed in Figma). Create if neither matches.
    for (const token of group.tokens) {
      let variable = token.$extensions?.variableId
        ? await figma.variables.getVariableByIdAsync(token.$extensions.variableId)
        : findByName(collection, token.variableName);

      if (!variable) {
        variable = figma.variables.createVariable(
          token.variableName,
          collection,
          mapTokenTypeToFigmaResolvedType(token.$type) // COLOR | FLOAT | STRING | BOOLEAN
        );
      }

      // 4. Set the value for each mode this token has a value in.
      for (const [modeName, value] of token.valuesByMode) {
        const modeId = collection.modes.find(m => m.name === modeName)!.modeId;
        variable.setValueForMode(modeId, mapTokenValueToFigmaValue(token.$type, value));
      }
    }
  }
}
```

### Constraints and edge cases to handle explicitly
- **Alias write-back**: if the incoming token is `{ kind: 'reference', refKey }`, the
  value set via `setValueForMode` must be a `VARIABLE_ALIAS` object pointing at the
  *already-created-or-found* target variable, not its resolved value — otherwise
  Phase 1's reference model is destroyed on the very first write-back. This means
  collections/variables must be created in dependency order: resolve and create
  referenced tokens before the tokens that reference them (topological sort over the
  reference graph from Phase 1).
- **Mode mismatch**: if GitHub has a mode (e.g. `Promo`) that doesn't exist in the
  Figma collection yet, create it via `collection.addMode()` — but Figma caps
  collections at a plan-dependent mode limit; catch the thrown error and surface it in
  the Sync tab as a specific, actionable message ("Couldn't create mode 'Promo' — this
  file's plan may not support additional modes") rather than a generic sync failure.
- **STRING/BOOLEAN variables** (from Phase 1) use the same `setValueForMode` path with
  `mapTokenValueToFigmaValue` branching on type.

### UI changes
- Sync tab: the existing "Use GitHub" resolution option, when applied to a token whose
  source type is `variable`, now shows a small note: "Will be written as a Figma
  Variable in `<collection>`" so the user knows which write path will run — this
  matters because the two paths (style vs. variable) have different visibility/behavior
  in Figma and the user should not be surprised.
- Status tab / Connect tab: add a one-line capability note ("Variable write-back
  requires an Enterprise-tier file, same as reading Variables") since this inherits the
  same entitlement gating described in the original README §5.

### Acceptance criteria
- A brand-new token committed directly to `design-tokens.json` on GitHub (never
  existed in Figma) creates a correctly-typed Variable in the right collection and mode
  on next sync.
- Re-syncing after that does not create a duplicate variable — it updates the existing
  one, matched by `variableId`.
- A semantic token that references a primitive writes back as a live
  `VARIABLE_ALIAS`, not a flattened value — confirmed by editing the primitive
  in Figma after write-back and seeing the semantic variable's resolved value change.
- Style-sourced tokens continue writing back as Styles exactly as before — this phase
  adds a path, it does not remove the existing one.

### Rejected alternatives
- **Always convert everything to Variables going forward, deprecating style
  write-back.** Rejected: many teams intentionally use Styles (simpler files, no
  Enterprise tier needed) and Phase 2 should not force a migration path on them.
  Source-type-driven branching preserves both.
- **Match variables by name only, ignore stored variableId.** Rejected: name collisions
  across collections are common (e.g. `primary` inside both a `Light` and `Dark`
  top-level collection structure some teams use instead of modes) and would silently
  merge unrelated variables.

---

## 4. Phase 3 — PR-based governed sync

**Status**: ✅ Shipped. **Priority**: — (done).

### Goal
Replace the current "commit directly to the configured branch" sync with an
opt-in mode where Sync opens a new branch + pull request instead, gated by required
reviewers and branch protection on the `design-tokens` repo side.

### Problem addressed
Original README §11: "PR-based review flow... Syncing commits directly to the
configured branch — no draft PR, no review step" is explicitly out of scope today.
Direct commits from a plugin do not survive real change-management policy once more
than one designer/engineer touches the same tokens repo.

### Dependencies
None beyond the base system. Independent of Phase 1/2 but commonly built alongside
Phase 4 (CI) since PRs are where CI checks (including Phase 1's validator and Phase 4's
Storybook build) actually get surfaced to a human before merge.

### Files touched
- `ui.ts` — modify the commit step (README §7 step 5a) to branch based on a new
  Connect-tab setting.
- Connect tab UI — new setting: "Sync mode: Direct commit / Pull request".
- `manifest.json` — no change (network access is already scoped to `api.github.com`).
- Documentation: Connect tab's inline PAT-creation instructions must be updated to
  request `pull_requests: write` in addition to the existing `contents: write` when
  PR mode is selected.

### Algorithm

```ts
// ui.ts — replaces the single commitToGitHub() call

async function syncToGitHub(mergedTokens: TokenSet, mode: 'direct' | 'pull-request') {
  if (mode === 'direct') {
    return commitToGitHub(mergedTokens); // existing behavior, unchanged
  }

  // PR mode:
  const branchName = `design-sync/${Date.now()}-${slugify(getConnectSettings().userLabel ?? 'sync')}`;
  const baseSha = await getRefSha(configuredBranch);          // GET /repos/{owner}/{repo}/git/ref/heads/{base}
  await createRef(branchName, baseSha);                        // POST /repos/{owner}/{repo}/git/refs
  const commitResult = await commitToGitHub(mergedTokens, { branch: branchName }); // PUT contents, targeting new branch
  const pr = await createPullRequest({
    title: `Design Sync: ${summarizeChanges(mergedTokens)}`,   // e.g. "3 added, 1 modified, 0 removed"
    head: branchName,
    base: configuredBranch,
    body: renderPrBody(diffSummary),                            // markdown table of changed tokens, generated from the same diff data already shown in the Sync tab
  });
  return { ...commitResult, prUrl: pr.html_url };
}
```

- `renderPrBody()` reuses the exact diff data structure already computed for the Sync
  tab's table (no new diffing logic — this is a rendering-only addition, formatting the
  same `added-figma` / `added-github` / `modified` rows as a markdown table).
- On success, the Sync tab's confirmation state changes from "Synced" to "Pull request
  opened" with a link — critically, **local Figma state (styles/variables) is NOT
  updated yet** in PR mode, since the GitHub-only changes haven't been merged. This is
  a meaningful behavior change from direct mode and must be visually distinct in the UI
  (different confirmation color/icon) so users don't think Figma-apply already happened.
- A new "Pending PRs" section in the Status tab lists open design-sync PRs (via
  `GET /repos/{owner}/{repo}/pulls?head={owner}:design-sync/*`) so a user returning to
  the plugin can see sync attempts awaiting review instead of losing track of them.

### Acceptance criteria
- With PR mode selected, Sync creates a branch and PR instead of committing to the
  configured branch directly; the configured branch is untouched until the PR is
  merged by a human on GitHub.
- The PR body accurately summarizes every token change from the same diff the user
  reviewed in the Sync tab — no discrepancy between what was shown pre-commit and what
  the reviewer sees in the PR.
- Direct mode continues to work exactly as before when selected — this is additive,
  not a replacement.
- If PAT permissions are insufficient for PR creation (missing `pull_requests: write`),
  the failure is caught and surfaced with the specific missing-permission message, not
  a generic 403.

### Rejected alternatives
- **Always use PR mode, remove direct-commit entirely.** Rejected: small teams / solo
  maintainers of a design system have no need for review overhead, and the original
  MVP's whole value proposition was reducing friction — forcing PRs on everyone
  contradicts that for the segment that doesn't need governance yet.
- **Build PR review UI inside the plugin itself (approve/reject from Figma).**
  Rejected as major scope creep — GitHub's own PR UI already does this well; the plugin's
  job is to *create* a well-formed PR, not to reimplement GitHub's review surface.

---

## 5. Phase 4 — CI/CD automation

**Status**: ✅ Shipped — `design-tokens` repo's `ci.yml` runs `validate-tokens.mjs` +
`build-storybook` on every push/PR; `deploy-storybook.yml` handles the plugin-triggered
rebuild. **Priority**: — (done).

### Goal
A GitHub Actions workflow in the `design-tokens` repo that automatically rebuilds and
deploys Storybook whenever `design-tokens.json` changes on the configured branch,
replacing the manual `npm run build-storybook && git push` step, and runs Phase 1's
validator on every PR (dovetailing with Phase 3).

### Problem addressed
Original README §11 and §13: "Automatic Storybook rebuilds. No GitHub Actions workflow
is wired up... `npm run build-storybook && git push` is manual." This is a pure
reliability gap — a human has to remember a two-command sequence after every sync, and
the Status tab can only ever tell you sync *drifted*, never prevent it.

### Dependencies
Builds cleanly on the existing `.storybook-sync.json` marker mechanism (README §8) — no
change to that mechanism is needed, only automation of when it runs. Pairs naturally
with Phase 3 (PRs are the natural CI trigger point for the validator) but can be built
independently — the Storybook auto-rebuild half only needs a push trigger, not PRs.

### Files added (in the `design-tokens` repo, not the plugin repo)
```
.github/workflows/
  build-storybook.yml     # triggers on push to configured branch, path-filtered to design-tokens.json
  validate-tokens.yml     # triggers on pull_request, runs scripts/validate-tokens.mjs from Phase 1
```

### `build-storybook.yml` (concrete, ready to commit)

```yaml
name: Rebuild Storybook on token change
on:
  push:
    branches: [main]            # match the branch configured in the plugin's Connect tab
    paths: ['design-tokens.json']
jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pages: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm run build-storybook   # runs the existing postbuild hook, refreshes .storybook-sync.json
      - run: |
          git config user.name "design-sync-bot"
          git config user.email "design-sync-bot@users.noreply.github.com"
          git add .storybook-sync.json
          git diff --staged --quiet || git commit -m "chore: refresh storybook sync marker [skip ci]"
          git push
      - uses: actions/upload-pages-artifact@v3
        with: { path: storybook-static }
      - uses: actions/deploy-pages@v4
```

Note the `[skip ci]` on the marker-refresh commit — this prevents an infinite trigger
loop, since that commit itself touches the repo (though not `design-tokens.json`, so
the path filter alone would already prevent re-trigger; `[skip ci]` is defense in
depth and should stay).

### `validate-tokens.yml`

```yaml
name: Validate design tokens
on: [pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: node scripts/validate-tokens.mjs design-tokens.json
        # exits non-zero on: schema violations, circular references (Phase 1),
        # duplicate variable ids, malformed shadow layers — surfaces as a failed
        # check on the PR, blocking merge if branch protection requires it.
```

### Plugin-side change
- Status tab: once CI is detected as configured (a lightweight check — does
  `.github/workflows/build-storybook.yml` exist in the repo via a single Contents API
  HEAD-style lookup), replace the manual "run these two commands" guide with "Storybook
  rebuilds automatically after merge — no action needed," and hide the manual
  instructions. If not detected, keep showing the existing manual guide plus a new
  "Set up automatic rebuilds" link that surfaces the two workflow files above with
  repo-specific values filled in (branch name, etc.), matching the existing pattern
  used for the first-time Storybook setup guide (README §12c).

### Acceptance criteria
- Pushing a token change (direct-commit mode) or merging a design-sync PR (PR mode,
  Phase 3) triggers a Storybook rebuild with no manual step.
- `.storybook-sync.json`'s SHA matches the live `design-tokens.json` SHA within one CI
  run's duration after any token change — Status tab shows "in sync" without a human
  running any command.
- A PR introducing a circular reference (Phase 1) or malformed token fails the
  `validate-tokens` check and is blocked from merging if branch protection requires
  passing checks.

### Rejected alternatives
- **Have the plugin itself trigger the Storybook build via the GitHub Actions
  `workflow_dispatch` API instead of a path-filtered push trigger.** Rejected: push
  triggers are simpler, require no additional PAT scope (`actions: write` is a broader
  and riskier permission than what's already granted), and work identically whether the
  change came from the plugin, a manual GitHub edit, or a merged PR — the push trigger
  doesn't care about the source, which is the correct behavior.

---

## 6. Phase 5 — Versioned audit trail and rollback

**Status**: ✅ Shipped (v1.6.0; UI redesigned v1.16.0–v1.16.2; Revert UX defect fixed
v1.20.0 — see below). **Priority**: — (done).

> **✅ Fixed, v1.20.0** (flagged 2026-08-05, user's own words: "the revert sync
> feature, its not UX friendly... a complete miss right now"). `revertBtn` is now a
> two-step arm/confirm button: first click adds a new `button.danger` class (reuses
> the existing `--danger`/`--danger-hover` tokens, previously unused on any button)
> and surfaces what's about to happen as visible text — "Opens a new pull request
> restoring N token(s) to its previous value" — instead of hover-only `data-tip`;
> second click while armed is what actually calls `runRevert`. Disarms on blur or a
> 5s timeout so it can't sit silently armed. No modal was introduced (this app has
> never had one) — the arm/confirm pattern reuses the same "a button mutates its own
> state on click" language `connectBtn`'s success-pulse already established.

### Goal
A structured, queryable history of every sync event (who, what tokens, from where, when),
plus a rollback capability in the plugin UI — going beyond "read `git log` yourself."

### Problem addressed
Every sync today is just a git commit with a generic message. There is no structured
answer to "who changed `color/brand/primary` and when" without manually reading commit
diffs, and no rollback path shorter than `git revert` in a terminal, which is not
something most designers using this plugin will do.

### Dependencies
Builds on Phase 3's PR summaries (reuses `renderPrBody`'s diff-summarization logic) if
Phase 3 is built first, but can be built standalone against direct commits too — the
audit log records diffs regardless of sync mode.

### Files added
```
design-tokens repo:
  .design-sync/
    audit-log.jsonl        # append-only, one JSON object per line, one line per sync event
```

Chosen as an append-only JSONL file **committed to the same repo**, not an external
database — consistent with the project's "no separate backend service" MVP philosophy
(README §1) until Phase 10 introduces one. This keeps the audit trail versioned
alongside the tokens themselves and requires no new infrastructure.

### Data model

```ts
// shared/audit.ts (new file)

interface AuditEntry {
  timestamp: string;               // ISO 8601
  actor: string;                   // GitHub username, resolved via GET /user with the configured PAT at sync time
  syncMode: 'direct' | 'pull-request';
  commitSha: string;
  prNumber?: number;                // present if syncMode === 'pull-request'
  changes: {
    key: string;
    category: TokenType;
    changeType: 'added' | 'modified' | 'removed';
    previousValue?: unknown;        // omitted for 'added'
    newValue?: unknown;             // omitted for 'removed'
    resolution: 'use-figma' | 'use-github' | 'skip'; // which side won, from the Sync tab's conflict resolution
  }[];
}
```

### Algorithm
- After every successful commit (direct or merged PR — for PR mode, this should be
  recorded at merge time via a small addition to Phase 4's `build-storybook.yml`
  workflow, since that's the reliable "this is now live" signal, not at PR-creation
  time), append one `AuditEntry` line to `.design-sync/audit-log.jsonl`.
- For direct mode: append as part of the same commit (single PUT, log entry included in
  the same tree update) to avoid a second API round-trip and avoid the log falling out
  of sync with the commit it describes.
- For PR mode: append in the CI workflow after merge, as a separate small commit
  (`chore: record audit entry for #<pr-number> [skip ci]`), since the plugin has no
  reliable way to know a PR was merged (that happens later, possibly after the Figma
  session ended).
- **Rollback**: new "History" tab (or a section within Status) lists recent
  `AuditEntry` rows. Selecting one and clicking "Revert this sync" computes the inverse
  diff (swap `previousValue`/`newValue` for every change in that entry) and feeds it
  through the *existing* sync pipeline as if it were a new set of resolved changes —
  reusing `commitToGitHub`/`syncToGitHub` rather than building a separate revert code
  path. This means a rollback is itself a new, auditable sync event, which is the
  correct behavior (rollbacks should be visible in history too, not a special
  git-level operation that bypasses the log).

### UI changes
- New **History** tab (fifth tab, alongside Connect / Custom Tokens / Sync / Status):
  reverse-chronological list of `AuditEntry` rows, each showing actor, timestamp, a
  short change summary ("3 modified, 1 added"), and an expandable per-token detail
  view reusing the existing diff-table row component from the Sync tab.
- "Revert this sync" button per entry, with a confirmation step showing exactly what
  will change (the inverse diff) before committing — same conflict-resolution-free
  confirmation pattern as a normal sync's final commit step.

### Acceptance criteria
- Every sync (direct or merged PR) produces exactly one audit entry, with accurate
  before/after values matching what was actually committed.
- Reverting an entry produces a new sync that restores the exact previous values for
  every affected token, and that revert itself appears as a new entry in History.
- History tab performs acceptably with hundreds of entries (paginate or lazy-load past
  the first 20, consistent with the existing "recent sync history (last 5 commits)"
  pattern already in the Connect tab — extend rather than reinvent that pattern).

### Rejected alternatives
- **Store audit history in `figma.clientStorage` instead of the repo.** Rejected:
  clientStorage is explicitly single-machine (README §9); audit history is inherently a
  team-shared artifact and must live where the team already collaborates — the repo.
- **Use raw `git log` parsing instead of a structured log file.** Rejected: git commit
  messages are free text and would require fragile parsing to reconstruct structured
  per-token change data; an explicit JSONL log is a small amount of extra write work for
  a large reliability win on the read side (History tab, rollback).

---

## 7. Phase 6 — Multi-brand / multi-file orchestration

**Status**: ❌ Not started. **Priority**: **Lowest — no current use case.** Explicit
product decision (2026-08-05): not needed right now. Revisit if a genuine multi-brand /
multi-repo requirement shows up. **New evidence, priority unchanged** (2026-08-05,
market-fit discussion): the strongest realistic buyer for this whole project is a
digital consultancy/agency maintaining design systems for multiple *client*
engagements at once (a team like EPAM, whose own UUI system is this project's real test
data) — each client too small individually to justify a Google/Microsoft-style
in-house platform team, but collectively hitting this exact drift problem constantly.
That buyer profile makes multi-brand/multi-repo routing look more load-bearing than
"nice to have," not less — flagged here for whoever revisits prioritization, not acted
on unilaterally.

### Goal
Support N Figma files syncing into M token destinations (e.g. multiple brands, each
with its own token file or its own path within one repo), instead of today's fixed
one-file-per-plugin-instance configuration.

### Problem addressed
Original README §11: "Multi-file / multi-brand support... all part of the original
'Design Sync' platform vision, none of it built here." Today's Connect tab holds exactly
one owner/repo/branch/path configuration. Enterprise design systems commonly run
multiple brand themes (the EPAM UUI test case's own `Loveship`/`Promo`/`Electric` modes
hint at this need already, even within one file) across genuinely separate Figma files —
and a consultancy managing several *separate client repos* hits the same gap from the
other direction: one Connect-tab configuration per plugin instance means switching
clients today means manually reconfiguring the connection each time, with no way to
keep several live at once.

### Dependencies
None technically required, but much more valuable after Phase 5 (multi-brand audit
history needs to be filterable by brand) and Phase 1 (multi-brand token sets benefit
from the reference model so brand-specific semantic tokens can share primitives).

### Files touched
- Connect tab — becomes a list-based configuration instead of a single form.
- New shape stored in `figma.clientStorage`: `connections: ConnectionConfig[]` instead
  of today's single config object. Existing single-config users are migrated on first
  load of the updated plugin (read old shape if `connections` key absent, wrap it as a
  one-item array, write back in new shape — silent, one-time, no user action needed).

### Data model

```ts
// shared/tokens.ts — extended

interface ConnectionConfig {
  id: string;                 // stable local id, generated once
  label: string;              // user-facing name, e.g. "Brand A — Light/Dark"
  owner: string;
  repo: string;
  branch: string;
  tokenFilePath: string;      // supports multiple files in one repo, e.g. "tokens/brand-a.json"
  figmaFileKey?: string;      // optional: figma.fileKey of the file this connection is meant for,
                               // used to auto-select the right connection when the plugin opens (see below)
}
```

### Algorithm
- On plugin launch, `code.ts` reads `figma.fileKey` (available without any new
  permission) and sends it to `ui.ts` alongside the existing token read.
- `ui.ts` looks up `connections` for a matching `figmaFileKey` and auto-selects that
  connection if found; otherwise shows a connection picker (a new small UI element
  above the existing tabs) letting the user choose which configured destination this
  session's sync should target — necessary for the case where one physical Figma file
  intentionally feeds multiple destinations (e.g. a shared primitives file syncing into
  every brand's token file).
- Sync, Status, and History tabs all become scoped to "the currently selected
  connection" — no change to their internal logic, only to which `ConnectionConfig`
  they read from at the top of each flow.
- **Cross-connection primitive sharing** (a common real need — one primitives file, N
  brand files each with their own semantic layer referencing it): out of scope for this
  phase's first cut. Flag it explicitly as a follow-up once Phase 1's reference model
  supports cross-file references, which is a nontrivial addition (a reference `refKey`
  would need to be able to point outside the current `TokenSet`, which changes
  `resolveToken`'s signature to take a set *of* TokenSets). Note this limitation
  visibly in the Connect tab's help text so users don't assume it's supported.

### UI changes
- Connect tab redesigned as a list: each `ConnectionConfig` shown as a card with
  label, owner/repo/branch/path, edit/delete actions, and an "Add connection" button
  reusing the existing single-connection form as the add/edit modal.
- New connection-picker dropdown, shown above the tab bar, always visible once more
  than one connection exists (hidden entirely for single-connection users — no added
  UI surface for the common case).

### Acceptance criteria
- A user with two connections configured can switch between them without losing
  unsynced state in the inactive one (each connection's Sync tab state is isolated).
- Opening the plugin in a Figma file whose `fileKey` matches a stored connection
  auto-selects it with no manual step.
- Existing single-connection users see zero behavior change beyond the (now-hidden,
  since only one connection exists) connection picker.

### Rejected alternatives
- **Support multi-brand via multiple *branches* of a fixed one-repo-one-file config
  instead of a full connection list.** Rejected: this doesn't address the common case
  of genuinely separate repos per brand (e.g. an agency managing token repos for
  multiple clients), which several real users of this class of tool need.
- **Auto-detect brand from Figma page/frame naming conventions instead of explicit
  file-key mapping.** Rejected: too fragile and implicit — explicit configuration in
  the Connect tab is one extra click and removes an entire category of "why did it sync
  to the wrong brand" bug reports.

---

## 8. Phase 7 — Semantic diff and AI-assisted conflict resolution

**Status**: ❌ Not started. **Priority**: **Medium — not now.** Real, worth doing once
token sets are large enough (post multi-brand, per §26's build order) to justify it —
deliberately not picked up yet (2026-08-05).

### Goal
Layer an LLM-assisted pass on top of the existing raw diff (README §7 step 3) that
detects likely renames (vs. genuine add+delete pairs), flags near-duplicate values worth
consolidating, and supports natural-language search over large token sets (the
project's own EPAM UUI case already hits ~11,600 entries per README §10 bug #7).

### Problem addressed
Today's diff is purely mechanical: same key + different value = modified; key only in
one side = added/deleted. A designer renaming `color/brand/primary` to
`color/brand/main` while keeping the same hex shows up as one delete + one add, with no
signal that it's actually the same token — a human has to notice by eye, which does not
scale past a few dozen changed tokens, let alone thousands.

### Dependencies
Requires Phase 1's reference model (rename detection is meaningfully different for
tokens with references vs. plain values — a rename should preserve reference
relationships) but does not require Phases 2–6.

### Files touched
- `ui.ts` — new module `semantic-diff.ts`, invoked as an optional enrichment step
  after the existing raw diff, before rendering the Sync tab's table.
- Connect tab — new setting: an API key field for the LLM provider (Anthropic API),
  stored via `figma.clientStorage` like the GitHub PAT, used only for this feature and
  clearly labeled as optional.

### Algorithm — rename/rewrite detection

```ts
// ui.ts — semantic-diff.ts

interface RawDiffResult {
  addedFigma: DiffRow[];
  addedGithub: DiffRow[];
  modified: DiffRow[];
}

interface SemanticEnrichment {
  likelyRenames: { from: DiffRow; to: DiffRow; confidence: number; reasoning: string }[];
  consolidationSuggestions: { keys: string[]; sharedValue: unknown; reasoning: string }[];
}

async function enrichDiff(raw: RawDiffResult, apiKey: string): Promise<SemanticEnrichment> {
  // Step 1 — cheap, local, deterministic pre-filter before any LLM call:
  // pair every addedFigma entry with every addedGithub entry in the SAME category
  // whose $value is IDENTICAL (or, for colors, within a small perceptual-distance
  // threshold — see below). This is almost certainly a rename, no LLM needed for
  // the "same value, different key" case — flag it directly with confidence 1.0.
  const exactValueRenames = pairByIdenticalValue(raw.addedFigma, raw.addedGithub);

  // Step 2 — for anything NOT resolved by step 1 (different value, different key —
  // ambiguous whether it's a rename+edit or a genuine unrelated add+delete), send a
  // single batched prompt to the LLM with structured JSON output, listing all
  // remaining addedFigma/addedGithub pairs by category. Ask for a JSON array of
  // {fromKey, toKey, confidence, reasoning} guesses, nothing else — see structured
  // output pattern in the existing Anthropic API artifact guidance.
  const llmSuggestions = await callAnthropicForRenameSuggestions(remainingPairs, apiKey);

  // Step 3 — consolidation: within the CURRENT token set (not just the diff), group
  // by identical value within each category and flag groups of 2+ keys sharing a
  // value that ISN'T already a reference relationship (Phase 1) — these are
  // candidates for "these should probably be one primitive token referenced twice."
  const consolidation = findUnlinkedDuplicateValues(currentFullTokenSet);

  return { likelyRenames: [...exactValueRenames, ...llmSuggestions], consolidationSuggestions: consolidation };
}
```

- **Perceptual color distance** for near-but-not-identical hex matches (e.g.
  `#4382DF` vs `#4382DE`): use a simple CIEDE2000 or even Euclidean RGB distance under a
  small threshold — flag as "near-duplicate, possibly a rounding difference" rather than
  auto-treating as identical, since a 1-bit difference is sometimes intentional.
- The LLM call must be structured-output-only (JSON), batched into one call for the
  whole remaining diff rather than one call per token pair, to keep this affordable and
  fast on large token sets — this directly follows the project's own scale problem
  (11,600+ entries, README §10 bug #7).
- **Never let the LLM's suggestion auto-resolve a conflict.** Every rename/consolidation
  suggestion is presented as a suggestion in the Sync tab UI with an accept/dismiss
  action — the existing rule that "modified conflicts have no default... must be picked
  explicitly per row" (README §7 step 4) is preserved; this phase adds *better
  information* to that human decision, it does not remove the human decision.

### UI changes
- Sync tab diff table: rows the enrichment step identifies as a likely rename are
  visually merged into a single "renamed" row (old key → new key, with confidence
  shown), collapsing what would otherwise be a confusing delete+add pair, with an
  "these are unrelated, show separately" escape hatch per row.
- New "Consolidation suggestions" panel (collapsed by default) below the main diff
  table, listing detected duplicate-value groups with a one-click "link these via
  reference" action that converts the suggestion into Phase 1 reference tokens.
- Search box (natural-language, `sendPrompt`-style single input) available whenever the
  token set exceeds a size threshold (e.g. 500+ entries) — "show me every blue used in
  dark mode" translates to a structured filter over the existing token data, not a
  fuzzy free-text match; the LLM's job here is query parsing (natural language →
  structured filter), not answering from a giant token dump.

### Acceptance criteria
- A pure rename (identical value, different key) is detected with confidence 1.0 with
  zero LLM calls (step 1 alone handles it) — this is the common case and should be
  instant and free.
- A rename-with-edit (different key AND different value) is correctly suggested by the
  LLM step with a plausible confidence score and reasoning string, and is never
  auto-applied without explicit user confirmation.
- Consolidation suggestions never fire on token pairs that are already linked via a
  Phase 1 reference (that's already-correct structure, not something to flag).
- Natural-language search returns results consistent with a manual filter over the
  same criteria — verified by spot-checking a handful of queries against manual
  filtering on the same token set.

### Rejected alternatives
- **Send the entire token set to the LLM on every diff for holistic analysis.**
  Rejected on cost and latency grounds at the project's own demonstrated scale
  (11,600+ entries) — the two-step local-prefilter-then-batched-LLM-call approach above
  handles the overwhelming majority of cases (exact-value renames) for free and only
  spends LLM budget on genuinely ambiguous cases.
- **Auto-apply high-confidence (>0.9) rename suggestions without confirmation.**
  Rejected: this directly contradicts the existing, deliberate "no default resolution
  for conflicts" design principle (README §7) — a wrong auto-apply on a rename is
  strictly worse than an extra click, since it can silently drop a token's original
  history.

---

## 9. Phase 8 — Cross-platform distribution via Style Dictionary

**Status**: ❌ Not started. **Priority**: **Lowest — no current use case.** Explicit
product decision (2026-08-05): no iOS/Android consumer waiting on this today. Revisit
if native-platform demand shows up.

### Goal
Pipe `design-tokens.json` through Style Dictionary to emit native platform token
formats — iOS (Swift), Android (Kotlin/Compose), in addition to the web formats
(CSS/SCSS/TS) already implied by the project's setup tooling (referenced in prior
project history, the Design System Sync Platform `setup.sh` scaffolding).

### Problem addressed
Everything built so far, including the earlier `setup.sh` CLI, outputs web-format
tokens only. Any org building native mobile apps on top of this design system has no
distribution path from `design-tokens.json` to their actual build.

### Dependencies
Strongly benefits from Phase 1 (Style Dictionary's transform pipeline handles
DTCG-shaped reference tokens natively — building this against the pre-Phase-1 flattened
schema would mean redoing the transform config after Phase 1 ships anyway).

### Files added (in the `design-tokens` repo)
```
style-dictionary.config.mjs
platforms/
  ios/          # generated Swift output lands here (gitignored, or committed — see note below)
  android/      # generated Kotlin/Compose output
  web/          # existing CSS/SCSS/TS output, now generated via Style Dictionary too
    instead of the bespoke generator implied by earlier project tooling
```

### Config (concrete starting point)

```js
// style-dictionary.config.mjs
import StyleDictionary from 'style-dictionary';

export default {
  source: ['design-tokens.json'],
  platforms: {
    ios: {
      transformGroup: 'ios-swift',
      buildPath: 'platforms/ios/',
      files: [{ destination: 'DesignTokens.swift', format: 'ios-swift/class.swift', className: 'DesignTokens' }],
    },
    android: {
      transformGroup: 'android',
      buildPath: 'platforms/android/',
      files: [
        { destination: 'colors.xml', format: 'android/colors', filter: (t) => t.$type === 'color' },
        { destination: 'font_dimens.xml', format: 'android/fontDimens', filter: (t) => t.$type === 'dimension' },
      ],
    },
    web: {
      transformGroup: 'web',
      buildPath: 'platforms/web/',
      files: [
        { destination: 'tokens.css', format: 'css/variables' },
        { destination: 'tokens.scss', format: 'scss/variables' },
        { destination: 'tokens.ts', format: 'typescript/es6-declarations' },
      ],
    },
  },
};
```

- Style Dictionary's DTCG-mode input format expects `$type`/`$value` — this is exactly
  why Phase 1's schema alignment matters here; without it, a custom parser step would be
  needed before Style Dictionary can consume the file at all.
- Reference tokens (`{ kind: 'reference', refKey }` from Phase 1) need a thin transform
  registered with Style Dictionary to convert that shape into Style Dictionary's own
  `{value}` alias syntax (`"{color.primitive.blue-600}"`) — a small, well-contained
  adapter function, not a fork of Style Dictionary itself.

### CI integration
Add a step to Phase 4's `build-storybook.yml` (or a new sibling workflow,
`build-platform-tokens.yml`, triggered on the same path filter) running
`npx style-dictionary build` and committing the generated platform files — same
bot-commit pattern already established for the Storybook sync marker.

### Plugin-side change
Status tab: extend the three-way health check (Figma / GitHub / Storybook) with an
optional fourth row, "Platform outputs," showing last-built timestamps for iOS/Android
if `platforms/*/` exist in the repo — read-only status, no plugin-side generation logic,
since all generation happens in CI, consistent with the "no separate backend service"
philosophy carried forward from the MVP.

### Acceptance criteria
- Running `npx style-dictionary build` against a Phase-1-shaped `design-tokens.json`
  produces valid Swift and Kotlin output with reference tokens correctly resolved to
  Style Dictionary's own alias syntax.
- CI automatically regenerates all platform outputs on every token change, matching
  the Storybook auto-rebuild pattern from Phase 4.
- Web output (CSS/SCSS/TS) generated via this pipeline is a drop-in replacement for
  whatever the project's earlier bespoke token-output generator produced, so downstream
  consumers of those files require no changes.

### Rejected alternatives
- **Write custom output generators per platform instead of adopting Style
  Dictionary.** Rejected: Style Dictionary is the de facto standard for this exact
  problem, actively maintained, and handles transform edge cases (unit conversion,
  naming convention per platform) that would otherwise need to be reinvented and
  maintained indefinitely.
- **Generate platform outputs from inside the Figma plugin instead of CI.** Rejected:
  this would require bundling Style Dictionary (a Node-oriented tool) into the plugin's
  iframe UI context, which has no filesystem access to write real output files — CI is
  the only sensible place this can run.

---

## 10. Phase 9 — Notifications and live collaboration

**Status**: 🟡 Partial. Notifications (Teams + Slack, via `notify-on-sync.yml`) shipped
in v1.8.0 and are live. The static status page (this section's "Live status view")
shipped in v1.11.0 and was **explicitly reverted** in v1.11.1 — "not wanted." Treat the
status-page half as rejected, not merely undone; do not rebuild it without a fresh,
explicit ask. **Priority**: notifications — done, no further action. Status page — not
planned.

### Goal
Push-based notifications (Slack/Teams) on sync events, and a live status view that
replaces the current "open the plugin to check the static blob-SHA marker" pattern
with something a team can glance at without launching Figma.

### Problem addressed
Original README §11 lists "Slack notifications" as explicitly out of scope. Today,
"is Storybook stale" (README §8) is pull-based — someone has to open the plugin's
Status tab to find out. Team awareness of sync events is entirely manual.

### Dependencies
Needs Phase 5's audit log as the event source (a notification is essentially "an audit
entry just got appended, tell someone") — build after Phase 5.

### Files added (in the `design-tokens` repo)
```
.github/workflows/
  notify-on-sync.yml     # triggered on the same push-to-audit-log event as Phase 5
```

### Notification workflow (concrete)

```yaml
name: Notify on token sync
on:
  push:
    branches: [main]
    paths: ['.design-sync/audit-log.jsonl']
jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 2 }   # need previous commit to diff the log's new lines
      - name: Extract new audit entries
        id: extract
        run: node scripts/extract-new-audit-entries.mjs   # diffs audit-log.jsonl against HEAD~1, outputs JSON to $GITHUB_OUTPUT
      - name: Post to Slack
        if: steps.extract.outputs.hasEntries == 'true'
        run: |
          curl -X POST "${{ secrets.SLACK_WEBHOOK_URL }}" \
            -H 'Content-Type: application/json' \
            -d "${{ steps.extract.outputs.slackPayload }}"
```

- `extract-new-audit-entries.mjs` reuses Phase 5's `AuditEntry` type directly — no new
  data model needed, just a formatter that turns one or more entries into a Slack
  Block Kit payload (actor, change summary, link to the commit/PR).
- Repo owner supplies `SLACK_WEBHOOK_URL` as a GitHub Actions secret — documented in a
  new section of the Connect tab's setup guide, following the same
  "here's exactly what to paste where" pattern already used for PAT creation.

### Live status view
- A minimal static HTML page (`status.html`), generated as part of the same CI run,
  reading `.storybook-sync.json` and the tail of `audit-log.jsonl`, deployed alongside
  Storybook (same GitHub Pages deploy step from Phase 4) at a fixed sub-path
  (`/status`). This gives anyone a bookmarkable, no-login URL for "is everything in
  sync right now," without needing Figma or the plugin open — genuinely replacing the
  pull-based Status tab check for the common "just tell me if it's fine" case, while the
  plugin's Status tab remains the tool for actually *acting* on a problem (starting a
  sync, viewing the full diff).

### Acceptance criteria
- A sync event (from either sync mode) triggers a Slack notification within one CI
  run's duration, containing accurate actor and change-summary information matching the
  corresponding audit entry.
- The static status page accurately reflects current Figma↔GitHub↔Storybook state
  without requiring the plugin to be open, and updates automatically on every relevant
  CI run.
- No notification fires for CI runs that don't correspond to an actual new audit entry
  (e.g. unrelated commits to the repo) — the path filter plus the diff-based extraction
  script must not false-positive.

### Rejected alternatives
- **Have the plugin itself call the Slack webhook directly from `ui.ts` at sync
  time.** Rejected: this would require storing the Slack webhook URL (a sensitive,
  team-shared secret) in per-machine `clientStorage`, duplicated across every
  contributor's install, with no central rotation story — a GitHub Actions secret,
  triggered by the same commit that already represents the source of truth for "a sync
  happened," is the correct place for this credential to live.
- **Build a full real-time WebSocket-based live dashboard instead of a static
  CI-generated page.** Rejected as premature for this phase — a static page refreshed
  on every sync-triggering CI run is accurate within the same latency window as the
  existing Storybook rebuild already tolerates, and needs no new hosting
  infrastructure. Real-time push belongs in Phase 10, once a real backend exists.

---

## 11. Phase 10 — Enterprise backend and platform layer

**Status**: ❌ Not started. **Priority**: **Medium — not now.** Real, and framed by this
doc itself as an optional capstone many teams may never need — deliberately not picked
up yet (2026-08-05). Revisit once file/CI-based state genuinely stops scaling.

### Goal
Introduce the first real backend service for the system: a database-backed API that
replaces the file-based audit log and multi-connection config with a proper
multi-tenant store, adds org/team RBAC, exposes a public API for third-party
integration, and adds drift/adoption analytics. This is the point where the project
grows the backend the original brief called for (README §1: "a standalone backend,
audit database... multi-brand support, rollback UI") but does so *on top of* a sync
core that's already proven, rather than building it upfront.

### Problem addressed
Original README §11's full list — "Multi-file / multi-brand support, rollback UI,
audit database, Slack notifications — all part of the original 'Design System
Orchestration Platform' vision, none of it built here." Phases 3–9 above have already
delivered most of these as file-based, CI-driven, or plugin-local implementations. This
phase is about *consolidating* them behind a real service once the org has outgrown
what git commits and GitHub Actions can reasonably carry — many small teams may never
need this phase at all, which is fine; it's an optional capstone, not a requirement.

**Concrete pain this would also fix, beyond the original brief** (§1b): the PAT
permission model has grown to four scopes per user with no central rotation or
revocation — every new feature this project ships adds another scope users must
individually manage. Phase 10's own API surface already calls for "scoped API tokens
(separate from the user's own GitHub PAT)" — that's the direct fix for this, not a new
requirement.

### Dependencies
Requires Phases 5 (audit log — becomes a migration source), 6 (multi-connection
config — becomes multi-tenant config), and benefits from all others being stable, since
this phase's job is largely to migrate existing file-based state into a service, not to
invent new sync logic.

### High-level architecture

```
Figma plugin (ui.ts)  →  Design Sync API (new service)  →  Postgres
                                    │
                                    ├── still talks to GitHub API directly for the
                                    │   actual commit/PR mechanics (Phases 3/4/8/9's
                                    │   CI workflows are UNCHANGED by this phase —
                                    │   the backend orchestrates and records, it does
                                    │   not replace the git-based sync mechanism)
                                    │
                                    └── exposes REST endpoints for third-party
                                        integration (e.g. an internal design-system
                                        homepage, Storybook add-ons, Slack app)
```

Critically: **this phase does not replace GitHub as the source of truth for tokens.**
`design-tokens.json` in the repo remains authoritative. The backend is a system of
record for *metadata about syncs* (who, when, which org/team, drift stats) — not a
second copy of the tokens themselves. This avoids a dual-source-of-truth problem that
would otherwise undermine everything Phases 1–9 established.

### Data model (Postgres, via Prisma or equivalent)

```prisma
model Organization {
  id            String   @id @default(cuid())
  name          String
  teams         Team[]
}

model Team {
  id             String        @id @default(cuid())
  organizationId String
  organization   Organization  @relation(fields: [organizationId], references: [id])
  name           String
  members        TeamMember[]
  connections    Connection[]  // replaces plugin-local ConnectionConfig[] from Phase 6
}

model TeamMember {
  id       String @id @default(cuid())
  teamId   String
  team     Team   @relation(fields: [teamId], references: [id])
  githubUsername String
  role     Role   // ADMIN | EDITOR | VIEWER
}

model Connection {
  id             String @id @default(cuid())
  teamId         String
  team           Team   @relation(fields: [teamId], references: [id])
  owner          String
  repo           String
  branch         String
  tokenFilePath  String
  figmaFileKey   String?
  syncEvents     SyncEvent[]
}

model SyncEvent {
  id           String   @id @default(cuid())
  connectionId String
  connection   Connection @relation(fields: [connectionId], references: [id])
  actor        String
  timestamp    DateTime
  syncMode     String
  commitSha    String
  prNumber     Int?
  changes      Json     // same shape as Phase 5's AuditEntry.changes
}

model DriftSnapshot {   // populated once Phase 11 exists — see next section
  id           String   @id @default(cuid())
  connectionId String
  timestamp    DateTime
  compliancePct Float
  violationCount Int
}
```

### API surface (initial set)

```
POST   /api/v1/sync-events              # called by the plugin (or CI, for PR-merge events) instead of writing directly to audit-log.jsonl
GET    /api/v1/connections/:teamId
GET    /api/v1/sync-events?connectionId=&since=
GET    /api/v1/drift/:connectionId       # populated by Phase 11
POST   /api/v1/webhooks/github           # receives repo push events directly, as an alternative/addition to the plugin calling in — enables the "manual GitHub edit" case (README §13 point 4) to be recorded even when no one opened the plugin
```

- Auth: GitHub OAuth for human users of any future dashboard; scoped API tokens
  (separate from the user's own GitHub PAT used for repo access) for the plugin and CI
  workflows to authenticate to this new service.
- The plugin's Connect/History/Status tabs are updated to read from this API instead of
  local `clientStorage`/`audit-log.jsonl` **only when a team has opted into backend
  mode** — a new Connect-tab toggle, "Team mode (requires backend URL + API token)."
  Solo/small-team users who never configure this continue exactly as before, entirely
  file/CI-based. This optionality is the load-bearing design decision of this phase.

### Acceptance criteria
- A team that opts into backend mode sees sync events recorded centrally, visible to
  every team member regardless of which machine performed the sync (solving Phase 5's
  file-log's implicit single-repo-visibility limitation for orgs running many
  connections across many repos).
- RBAC correctly restricts who can trigger a sync vs. only view history, enforced at
  the API layer, not just hidden in the UI.
- A team that does NOT opt in sees zero behavior change — no forced migration, no
  backend dependency introduced for existing users.
- The GitHub webhook endpoint correctly records a `SyncEvent` for a manual GitHub-side
  edit to `design-tokens.json` (not originating from the plugin at all), closing the
  gap noted in README §13 point 4 where such edits were previously invisible to any
  history mechanism.

### Rejected alternatives
- **Make the backend authoritative for tokens themselves (store TokenSet in
  Postgres, sync GitHub from it) instead of GitHub remaining the source of truth.**
  Rejected: this inverts the entire architecture the project is built on, discards
  git's own versioning/diffing/PR tooling that Phases 3–4 deliberately leaned on, and
  introduces exactly the dual-source-of-truth problem the "two repos talk only through
  a JSON file" design (README §3) was built to avoid.
- **Require backend mode for all users starting with this phase.** Rejected: breaks
  the project's consistent design principle of every phase being additive and optional
  for teams that don't need it — forcing infrastructure on a solo designer with one
  Figma file would be a regression in the tool's core value proposition.

---

## 12. Phase 11 — Consumption-side drift detection

**Status**: ❌ Not started. **Priority**: Blocked — needs Phase 1 (done) and Phase 10
(medium, not now). Not independently prioritized while Phase 10 is on hold.

### Goal
Detect hardcoded design values (colors, spacing, etc.) in application source code that
bypass the token system entirely, across N application repositories, and surface this
as a compliance metric with CI enforcement — a fundamentally different problem from
Phases 1–10, which are all about keeping *definition-side* artifacts (Figma, the tokens
repo, Storybook) in agreement with each other.

### Problem addressed
Nothing built in Phases 1–10 looks inside application code. A team can have perfect
Figma↔GitHub↔Storybook sync (and even perfect cross-platform distribution via Phase 8)
while individual engineers hardcode `#4382DF` directly into components, entirely
bypassing the token system. This is, in practice, the largest real-world source of
design-system drift in most organizations — larger than any definition-side sync gap.

### Dependencies
Requires Phase 1 (the reverse-index registry described below is built from Phase 1's
`TokenSet`, and needs the DTCG-aligned value shapes to build a reliable value→token
lookup) and Phase 10 (a multi-repo registry and a place to store cross-repo compliance
data — `DriftSnapshot` above is specifically shaped for this phase's output). Do not
attempt to build this before both are in place; a single-repo, file-based version of
this phase is possible but would need to be substantially rebuilt once Phase 10 lands,
so it's sequenced last deliberately.

### New service component: the drift scanner
This is a new, standalone Node service/CLI (`design-sync-scanner`), **not** part of the
Figma plugin (the plugin has no reason to know about application codebases — see the
architecture diagram already reviewed with the user). It runs in CI on each
application repo, and reports into the Phase 10 backend.

### Repository layout (new repo: `design-sync-scanner`)
```
design-sync-scanner/
  src/
    registry/
      build-reverse-index.ts     # TokenSet (from design-tokens.json) → Map<normalizedValue, TokenMatch[]>
    parsers/
      css-scss.ts                # PostCSS-based, extracts literal color/dimension values
      js-ts-styled.ts            # ts-morph/AST-based, handles styled-components, emotion, CSS-in-JS objects
      jsx-inline-style.ts        # AST-based, extracts style={{...}} literal values
      swift.ts                   # SwiftSyntax-based (or regex fallback if a full parser is unavailable), extracts UIColor/hex literals
      kotlin-compose.ts          # Kotlin AST-based, extracts Color(...) literals
    matcher/
      match-engine.ts            # normalized-value lookup against the reverse index; near-miss/fuzzy suggestion logic
    diff/
      pr-diff-scanner.ts         # scans ONLY the lines changed in a PR diff, not the whole repo — see rationale below
      full-repo-scanner.ts       # scans the whole repo, for the slower-moving compliance-percentage metric
    suppression/
      allowlist.ts               # reads .design-sync-ignore config, honors inline suppression comments
    report/
      ci-annotator.ts            # emits GitHub Actions PR review comments / check annotations
      backend-reporter.ts        # POSTs results to Phase 10's /api/v1/drift/:connectionId
  .design-sync-ignore             # example/template suppression config, documented below
```

### Value normalization and the reverse index

```ts
// registry/build-reverse-index.ts

interface TokenMatch {
  tokenKey: string;       // e.g. "color/semantic/brand-primary"
  category: TokenType;
}

// Build once per scan run, from the CURRENT design-tokens.json (fetched fresh from
// GitHub at scan start, never cached across runs — staleness here directly causes
// false positives/negatives).
function buildReverseIndex(tokenSet: TokenSet): Map<string, TokenMatch[]> {
  const index = new Map<string, TokenMatch[]>();
  for (const category of ['color', 'dimension'] as const) {   // v1 scope: color + dimension only, see rejected alternatives
    for (const [key, token] of Object.entries(tokenSet[category])) {
      const resolved = resolveToken(key, tokenSet, category);  // uses Phase 1's resolver — references resolve to concrete values for matching
      const normalized = normalizeValue(category, resolved);   // e.g. hex → lowercase 6-digit; "8px" → "8px" (already normalized unit)
      const bucket = index.get(normalized) ?? [];
      bucket.push({ tokenKey: key, category });
      index.set(normalized, bucket);
    }
  }
  return index;
}

function normalizeValue(category: TokenType, value: unknown): string {
  if (category === 'color') return normalizeHex(value as string);   // expand shorthand (#fff → #ffffff), lowercase, strip alpha for base match (report alpha mismatches separately)
  if (category === 'dimension') return normalizeDimension(value as string); // px/rem normalization to a common unit for comparison
  throw new Error(`unsupported category for drift matching: ${category}`);
}
```

### Matching and near-miss suggestions

```ts
// matcher/match-engine.ts

interface Finding {
  file: string;
  line: number;
  column: number;
  rawValue: string;
  category: 'color' | 'dimension';
  matchedToken?: string;      // exact match found — this literal SHOULD have been a token reference; still a violation, but a fixable one with a clear suggestion
  nearMissToken?: { key: string; distance: number };  // e.g. within perceptual color distance threshold, or off-by-1px — likely a rounding drift from the real token
  severity: 'exact-match-hardcoded' | 'near-miss' | 'unmatched-literal';
}

function matchFinding(rawValue: string, category: 'color' | 'dimension', index: ReverseIndex): Finding['matchedToken' | 'nearMissToken'] {
  const normalized = normalizeValue(category, rawValue);
  const exact = index.get(normalized);
  if (exact?.length) return { matchedToken: exact[0].tokenKey }; // exact value exists as a token — this SHOULD reference it
  const near = findNearestToken(normalized, category, index);     // perceptual distance for color, numeric delta for dimension
  if (near && near.distance < THRESHOLD[category]) return { nearMissToken: near };
  return undefined; // genuinely unmatched literal — not necessarily wrong (could be a legitimate one-off), but worth surfacing at low severity
}
```

- **Severity tiers matter for signal quality**: `exact-match-hardcoded` (a literal that
  is IDENTICAL to an existing token's value — unambiguous, should always be flagged) is
  the highest-confidence, highest-priority finding. `near-miss` (close but not
  identical — likely drift or a rounding error) is worth surfacing but should be
  visually distinct so it doesn't get conflated with the unambiguous case. `unmatched-literal`
  (no token is close at all) is the lowest priority and, honestly, often a legitimate
  exception — this tier should default to informational/non-blocking.

### Suppression mechanism

```
# .design-sync-ignore — committed to each application repo's root
# One glob pattern per line; also supports inline suppression.
src/legacy/**
src/email-templates/**        # can't use CSS variables in email HTML
src/vendor/**
```

```tsx
// inline suppression, honored by every parser above
const bg = '#4382DF'; // design-sync-ignore: third-party embed requires exact brand match
```

Without this mechanism, the tool produces enough noise on any real codebase's existing
debt to be ignored within a week — this is not an optional nice-to-have, it is load
bearing for adoption.

### CI integration — PR-diff scanning vs. full-repo scanning

Two distinct scan modes, run by two distinct workflows, because they answer different
questions and have very different cost/noise profiles:

```yaml
# .github/workflows/design-sync-drift-pr.yml — in EACH application repo
name: Design token drift check
on: [pull_request]
jobs:
  scan-diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - run: npx design-sync-scanner scan-diff --base=${{ github.event.pull_request.base.sha }} --head=${{ github.sha }}
        # Only scans lines CHANGED in this PR, not the whole repo — this is the
        # enforcement gate, and it must only ever flag NEW hardcoded values, never
        # pre-existing repo debt, or every team's very first PR after adopting this
        # tool fails on unrelated legacy code and the check gets disabled within a day.
      - run: npx design-sync-scanner annotate-pr   # posts inline PR review comments at the exact file:line of each finding, with the suggested token substitution
```

```yaml
# .github/workflows/design-sync-drift-full.yml — same repo, scheduled
on:
  schedule: [{ cron: '0 6 * * 1' }]   # weekly
jobs:
  scan-full:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx design-sync-scanner scan-full
      - run: npx design-sync-scanner report-to-backend --connection-id=${{ vars.DESIGN_SYNC_CONNECTION_ID }}
        # POSTs a DriftSnapshot (Phase 10's model) — compliancePct, violationCount —
        # this is the slow-moving trend metric, NOT a blocking check.
```

### Backend/dashboard integration (Phase 10)
- `DriftSnapshot` rows populate a per-connection compliance trend, visible wherever
  Phase 10's future dashboard surfaces `GET /api/v1/drift/:connectionId`.
- Phase 9's Slack notification workflow gets a natural extension here (not built in
  this phase, but the hook point is exactly the same webhook pattern): a weekly digest
  of compliance trend per repo, using the same Block Kit payload approach already
  established.

### Acceptance criteria
- A PR introducing a brand-new hardcoded color that exactly matches an existing token's
  value is flagged with an inline comment suggesting the specific token to use instead,
  and (if branch protection requires it) blocks merge.
- A PR that only touches pre-existing hardcoded values (not newly introduced) produces
  no findings — the diff-scoped scan must not resurface legacy debt as a blocking issue.
- Suppressed paths and inline-suppressed lines produce zero findings, verified against
  a test fixture repo containing both allowlisted and non-allowlisted violations.
- The weekly full-repo scan produces a `DriftSnapshot` with a compliance percentage
  that a human can sanity-check against a manual count on a small fixture repo.
- Near-miss findings are visually and semantically distinct from exact-match findings
  in both the PR annotation and any dashboard view — never merged into one undifferentiated
  "violation" bucket.

### Rejected alternatives
- **Regex-based scanning instead of per-language AST parsing.** Rejected: regex reliably
  misses computed values, template literals, and CSS-in-JS object properties, and
  produces both false positives (matching a hex-looking string inside a comment or an
  unrelated string literal) and false negatives (missing values built from
  concatenation or interpolation) at a rate that undermines trust in the tool. AST
  parsing per language is more work upfront but is the only approach that produces
  signal clean enough to be worth enforcing in CI.
- **Full-repo blocking scan on every PR instead of diff-scoped scanning.** Rejected,
  explicitly and strongly: this is the single most common reason tools in this category
  get disabled within days of adoption — flagging a team's entire pre-existing debt on
  their very first PR after rollout is punishing behavior they didn't cause in that PR,
  and it trains people to ignore or disable the check rather than fix it. Diff-scoped
  scanning for enforcement + full-repo scanning for a separate, non-blocking trend
  metric is the only version of this that survives real adoption.
- **Extend STRING/BOOLEAN or typography/shadow categories to drift matching in this
  first cut.** Rejected as v1 scope creep — color and dimension are the two categories
  with the clearest "this literal should obviously be a token" signal and the lowest
  false-positive risk (a hardcoded font-family string or boolean is much harder to
  confidently match against a token without more context). Extend to other categories
  once color/dimension matching is proven in production.

---

## 13. Phase 12 — PR preview builds

**Status**: ❌ Not started (new, proposed 2026-08-05). **Priority**: Unprioritized.

### Goal
Deploy a temporary, per-PR Storybook build reflecting a sync PR's token changes, so a
reviewer can visually inspect the effect before merging, not just read the diff table.

### Problem addressed
Today's PR review (Phase 3) surfaces only a textual diff (Sync tab table / PR body). A
reviewer has to mentally simulate what "`brand/primary`: `#3678E2` → `#2a5ec4`" actually
looks like across dozens of components. This is the same "trust the diff, don't see the
thing" gap that made visual regression testing valuable everywhere else in frontend
engineering.

### Dependencies
Requires Phase 3 (PR-based sync — this phase hooks into the PR's lifecycle) and Phase 4
(CI/CD automation — reuses the existing `build-storybook` step, just parameterized
per-PR instead of per-push-to-main).

### Files touched (`design-tokens` repo)
- `.github/workflows/preview-storybook.yml` (new) — triggered on `pull_request` events
  where the diff touches `design-tokens.json` or `.design-sync/audit-log.jsonl` (the
  same path every Phase 3 sync PR always touches).
- `scripts/deploy-preview.mjs` (new) — builds Storybook against the PR's head branch,
  deploys to a PR-scoped path. Reuses the existing `build-storybook` step and config —
  no new build tooling.

### Algorithm
1. On `pull_request` (`opened`/`synchronize`) where the diff touches
   `design-tokens.json`: check out the PR's head branch, run the existing
   `npm run build-storybook`.
2. Deploy the build output to a path unique to that PR number (see Rejected
   alternatives for the GitHub Pages vs. external host trade-off).
3. Comment on the PR (via `GITHUB_TOKEN`, `github-script` action) with the preview URL —
   a `synchronize` event edits the existing comment for that PR rather than posting a
   new one every push.
4. On PR close (merged or not), a cleanup job removes that PR's preview path — outputs
   must not accumulate indefinitely.

### UI changes
Minimal, plugin-side: the Sync tab's pending-PR banner (already shows `prLink`) can
optionally gain a second "Preview" link once the workflow's PR comment includes a
discoverable marker, fetched via the PR's comments API. Not required for v1 — this is a
code-review-time feature, not a sync-time one, and the PR comment alone is sufficient;
the plugin's job already ends once the PR exists.

### Acceptance criteria
- Opening a sync PR triggers a preview build within one CI run.
- The PR gets a comment with a working, unique preview URL.
- A second push to the same PR (e.g. after resolving another conflict) updates the
  existing comment rather than adding a new one.
- Closing the PR (merged or not) removes the preview deployment within a reasonable
  time.

### Rejected alternatives
- **Re-deploy the "real" Storybook (the one at the repo's primary Pages URL) on every
  open PR.** Rejected: this would let an unmerged, potentially-wrong token set overwrite
  what the team's shared Storybook shows, contradicting the entire point of Phase 3's
  review gate.
- **Host previews on a paid third-party service (Vercel/Netlify) instead of GitHub
  Pages subdirectories.** Not a hard rejection — flagged as an implementation-time
  decision if GitHub Pages' single-deploy-target model proves too awkward for
  concurrent PR previews in practice; depends on how many concurrent PRs a team
  typically has open.

---

## 14. Phase 13 — Contrast/accessibility linting at sync time

**Status**: ❌ Not started (new, proposed 2026-08-05). **Priority**: Unprioritized.

### Goal
Catch WCAG contrast failures introduced by a token change before the sync PR is even
opened, not after a designer or engineer notices in production.

### Problem addressed
Nothing in `validate-tokens.mjs` (Phase 4) or the Sync tab's diff logic checks whether a
new/changed color token, paired with whatever background token it's meant to sit on,
still meets a minimum contrast ratio. A color rename or a "just nudge the brand blue
slightly" edit can silently break accessibility with zero signal until a manual audit
catches it.

### Dependencies
Requires Phase 1 (the reference model — pairing rules need to know which tokens are
"foreground on background" pairs) and pairs naturally with Phase 4 (this is a
`validate-tokens.mjs` extension, run in the same CI step).

### Data model
New optional per-token metadata, additive to the existing `DesignToken` shape:
```ts
// design-tokens.json, per color token — entirely optional, absence = "not checked"
$extensions?: {
  'design-sync.contrastPairs'?: string[]; // refKeys of background tokens this color is expected to sit on
  'design-sync.contrastMinimum'?: number; // override the default 4.5:1, e.g. 3:1 for large text/UI components
}
```
Populated manually at first (a designer annotates known text/background pairs — e.g.
`color/text/default` gets `contrastPairs: ["color/surface/default"]`); auto-inference is
a plausible future enhancement, not required for v1.

### Algorithm
1. `scripts/check-contrast.mjs` (new), invoked from `ci.yml` after `validate-tokens.mjs`:
   for every color token carrying `contrastPairs`, resolve both sides (Phase 1's
   `resolveToken`), compute WCAG relative-luminance contrast ratio.
2. Compare against the configurable minimum (default 4.5:1, WCAG AA normal text).
3. A failing pair does not hard-fail CI by default (genuine, intentional low-contrast
   decorative tokens exist) — it posts a warning annotation on the PR via GitHub's
   checks API. A repo can opt into hard-fail via a workflow input flag.

### UI changes
Sync tab: a conflict/added row for a color token with `contrastPairs` that would fail
shows an inline `WarningCircle` badge next to the value (e.g. "2.1:1 — below AA")
*before* the PR is even opened, using the same client-side contrast math already
available to `ui.ts` — no new dependency.

### Acceptance criteria
- A token change that drops a documented pair below its configured minimum surfaces a
  warning both in the Sync tab (pre-PR) and as a PR annotation (post-PR), with the
  actual computed ratio.
- A pair that already failed before the change (pre-existing debt) does not falsely
  read as "caused by this sync" — compare against the previous commit's ratio to
  distinguish newly-introduced/newly-worsened failures from an existing baseline.

### Rejected alternatives
- **Auto-block sync entirely on any contrast failure.** Rejected: too strict as a
  default — real, intentional low-contrast UI exists (disabled states, decorative
  elements); a hard block would train teams to route around the tool. Opt-in strict
  mode covers teams that want enforcement.
- **Auto-fix by adjusting the failing color's lightness until it passes.** Rejected:
  silently mutating a designer's chosen value without their input is worse than a
  flagged warning — the same "no default resolution" principle Phase 7 also respects.

---

## 15. Phase 14 — Token deprecation lifecycle

**Status**: ❌ Not started (new, proposed 2026-08-05). **Priority**: Unprioritized.

### Goal
Let a token be marked deprecated with a sunset date and a migration hint, instead of the
only two states being "exists" and "silently deleted," so downstream consumers get a
warning window rather than a breaking change.

### Problem addressed
Removing a token today just makes it disappear from the next diff as a GitHub-only or
Figma-only removal. Anything still hardcoding or referencing that token's value in
application code has no signal at all until something visually breaks — there's no
concept of "this is going away soon, please migrate."

### Dependencies
Requires Phase 1 (deprecation metadata lives in `$extensions`, same mechanism as Phase
2's `variableId`/`modeId`). Strongly complements Phase 11 (drift detection) — a
deprecated token is exactly what a drift scanner should flag with elevated urgency once
both exist — but this phase stands alone without Phase 11.

### Data model
```ts
// Additive to DesignToken<T>['$extensions']
'design-sync.deprecated'?: {
  since: string;        // ISO date, set automatically when first marked
  sunset?: string;       // ISO date, optional — "should be gone by"
  replacement?: string;  // refKey of the token to migrate to, if a direct 1:1 replacement exists
  reason?: string;       // free text, e.g. "superseded by color/brand/primary-v2"
};
```

### Algorithm
1. Sync tab gains a per-token "Mark as deprecated" action (a small overflow affordance
   next to the existing resolution controls, available on any unchanged or resolved
   token) — sets the metadata above, written through the existing GitHub-write path (no
   new API surface, just a new field in the same JSON write Sync already does).
2. `validate-tokens.mjs` (Phase 4) gains a check: any non-deprecated token still
   referencing (via Phase 1's reference model) a token that IS deprecated surfaces as a
   lint warning ("X still references deprecated Y") — catches internal drift within the
   token set itself, independent of application code.
3. Status tab gains a "Deprecated tokens" summary (collapsed by default, matching every
   other progressive-disclosure pattern already shipped) — count deprecated, count past
   sunset date.

### UI changes
Sync tab's diff rows, Status tab's new deprecated-tokens summary, and a muted
"Deprecated" `.tag` (reusing the existing tag component) anywhere a deprecated token's
key is shown.

### Acceptance criteria
- Marking a token deprecated round-trips correctly through a sync (metadata survives
  Figma write-back and the next GitHub read).
- A token referencing a deprecated token is flagged by `validate-tokens.mjs`.
- The Status tab's deprecated count accurately reflects both total-deprecated and
  past-sunset-date subsets.

### Rejected alternatives
- **Hard-delete-with-grace-period (token still resolves but throws a build-time error
  after the sunset date).** Rejected as too aggressive for v1 — a soft warning-only
  lifecycle establishes the pattern and metadata first; enforcement can layer on once
  teams trust the mechanism.
- **Storing deprecation state outside the token file (e.g. a separate
  `deprecations.json`).** Rejected: keeping it inline via `$extensions` means it
  round-trips through the exact same read/write/diff path every other piece of token
  metadata already uses — no new file, no new sync logic.

---

## 16. Phase 15 — Pre-sync blast-radius preview

**Status**: ❌ Not started (new, proposed 2026-08-05). **Priority**: Unprioritized —
and blocked on Phase 11 regardless of independent prioritization.

### Goal
Before opening a sync PR, show how many components/files across which application
repositories actually consume the token(s) being changed — turning "I hope this doesn't
break anything" into a concrete, visible number.

### Problem addressed
Even with a clean Figma↔GitHub diff and a passing contrast check (Phase 13), a token
change's real-world impact is invisible until Phase 11's drift scanner runs *after* the
fact (or someone changes it and finds out in production). There's no pre-sync signal
analogous to "this PR touches 340 files" that a git-based blast-radius tool would show
for code.

### Dependencies
Requires Phase 11 (drift detection) — this phase is explicitly a consumer of Phase 11's
reverse index (value/token → source-file usage across app repos), not a new scanning
mechanism of its own. **Do not build this before Phase 11 exists** — it would mean
building and discarding a duplicate indexing mechanism. Also benefits from Phase 10
(backend), since the reverse index is most naturally served from the same store Phase
11 populates, though a read-only file-based fallback (a committed `usage-index.json`
regenerated by the same CI job Phase 11 already runs) is possible without a full backend.

### Files touched
`ui.ts` (Sync tab) only, on the plugin side — zero new scanning infrastructure, purely a
UI consumer of Phase 11's existing output.

### Algorithm
1. When rendering a conflict/modified row, look up the token's key against Phase 11's
   usage index (via the backend API if Phase 10 exists, or the committed
   `usage-index.json` otherwise).
2. If matches exist, show a compact badge: "Used in 12 files across 3 repos" —
   expandable (same `persistentDetails` pattern as every other disclosure in this app)
   to a file-path/repo-name list.
3. No new decision is introduced — informational only, the same "better information,
   not a different decision" principle Phase 7 already establishes for its own
   suggestions.

### UI changes
A new badge/expandable list on `renderDiffRow`, visually similar to the existing REF
badge (`diffValueLine`) — reuses the existing `.tag`/`persistentDetails` components, no
new visual language.

### Acceptance criteria
- A token with known application-code usage shows an accurate count and file list in
  the Sync tab before the PR is opened.
- A token with zero detected usage shows no badge at all (silence is the correct signal
  for "nothing found," consistent with every other empty-state decision this app makes
  — not a "0 usages" badge).
- The index lookup adds no noticeable latency to the existing compare flow (a
  stale/cached index is acceptable — this is advisory, not a live scan).

### Rejected alternatives
- **Running a live, on-demand scan of every consuming repo at compare time instead of
  reading a precomputed index.** Rejected: far too slow at this project's own
  demonstrated scale (11,600+ token entries, per README §10) and duplicates Phase 11's
  own scanning infrastructure for no benefit.

---

## 17. Phase 16 — Concurrent-sync advisory lock

**Status**: ❌ Not started (new, proposed 2026-08-05). **Priority**: Unprioritized.

### Goal
Warn a user, before they open a new sync PR, if another sync PR against the same branch
is already open — closing the documented "no conflict detection between two open sync
PRs" gap without requiring Phase 10's backend.

### Problem addressed
The README's own known-limitations list states this plainly: "If two people sync around
the same time, each gets their own branch/PR; the second one to merge hits GitHub's
normal merge-conflict handling... nothing here coordinates or warns ahead of time." This
phase adds the warning, not the coordination — a lightweight advisory, not a lock in the
database sense (there's no backend to hold a real lock yet).

### Dependencies
Requires Phase 3 (PR-based sync) only — a read-only check against GitHub's own PR-list
API, no new infrastructure, no dependency on Phase 5, 9, or 10.

### Algorithm
1. Before rendering the Sync tab's "Sync" button as enabled, `ui.ts` calls
   `GET /repos/{owner}/{repo}/pulls?state=open`, filtered client-side for the
   `design-sync/sync-` branch-name prefix Phase 3 already uses, to check for any other
   currently-open sync PR against the same target branch.
2. If found: a non-blocking `statusBanner('info', …)` above the Sync button — "Another
   sync PR (#N, opened by X) is already open against this branch — merge or close it
   first to avoid a conflict," with a `prLink` to the existing PR. The Sync button stays
   enabled — advisory, not a hard block, since a user might have a legitimate reason to
   proceed (e.g. two genuinely independent, non-overlapping brand token subsets).
3. Runs as part of the existing `runCompare()` flow — one extra GitHub call, same PAT,
   no new permission beyond the `pull_requests: read` scope Phase 3 already requires.

### UI changes
One new conditional `statusBanner` on the Sync tab, reusing the exact existing
component — no new UI primitive.

### Acceptance criteria
- Opening the Sync tab while another sync PR is genuinely open against the same branch
  shows the advisory banner with an accurate PR link.
- The banner does not appear when the only open PR is the current session's own
  just-opened one (compare by branch name, not just "any open PR exists").
- The Sync button remains clickable throughout — this phase only adds information,
  consistent with the project's standing principle that automation informs, it doesn't
  override, human decisions.

### Rejected alternatives
- **A real distributed lock (blocking a second sync outright until the first
  resolves).** Rejected: requires a backend to hold lock state reliably (Phase 10), and
  blocking outright removes a legitimate use case (independent non-overlapping changes)
  for a problem GitHub's normal merge-conflict handling already resolves safely, per the
  README's own framing — just not proactively.

---

## 18. Phase 17 — Deep-linking between Storybook/status page and Figma

**Status**: ❌ Not started (new, proposed 2026-08-05). **Priority**: Unprioritized.

### Goal
From a token's rendering in Storybook (or a future status page), jump directly to the
Figma node/style/variable that defines it — closing the design↔code loop in the
direction that currently has no path at all.

### Problem addressed
Going from Figma → code is well-supported today (that's the entire sync mechanism).
Going the other way — "this token looks wrong in Storybook, where does it actually live
in Figma?" — requires manually searching Figma's styles/variables panel by name. For a
large file (this project's own 11,600+ token case), that's a real, current pain point
with zero tooling support.

### Dependencies
Requires Phase 1 (the `$extensions['design-sync.variableId']`/`modeId` fields, already
populated for variable-backed tokens by Phase 2 — this phase only adds a *link*, no new
data capture) and Phase 4 (Storybook build — the link needs to render somewhere in the
built output).

### Algorithm
1. Figma's own node/variable deep-link scheme
   (`https://figma.com/design/{fileKey}/{fileName}?node-id={nodeId}` for styles; a
   comparable scheme exists for variables via the variables panel) is already public —
   no new Figma API access needed beyond what's already read.
2. `code.ts`'s existing token-read path already captures `figma.fileKey` alongside each
   token's `$extensions['design-sync.variableId']` — sufficient to construct a
   variable-scoped deep link at read time, stored as a new optional
   `$extensions['design-sync.figmaLink']` field, written on every sync (a derived,
   always-regenerated field, not something a user edits directly).
3. Storybook's existing token-documentation view renders this link as a small "Open in
   Figma" affordance next to each token, opening in a new tab.

### UI changes
Storybook only (the `design-tokens` repo's Storybook config, not the plugin) — a new
column/icon-link in whatever token-documentation view Storybook already renders from
`design-tokens.json`.

### Acceptance criteria
- A variable-backed token's Storybook entry links to a Figma URL that, when opened by
  someone with file access, lands on (or very near) the correct variable.
- A Style-backed token (no `variableId`) either omits the link or falls back to a
  file-level (not node-level) link, since Figma's deep-link scheme for Styles is less
  precise than for Variables — document this precision gap plainly rather than showing
  a misleading link.

### Rejected alternatives
- **Building this as a plugin-side feature (a "copy Figma link" button in the plugin)
  instead of surfacing it in Storybook.** Rejected: the whole point is closing the loop
  for someone who is *already looking at Storybook* and has never opened the plugin —
  putting the link only in the plugin doesn't solve that person's actual problem.

---

## 19. Phase 18 — Dedicated Storybook repo

**Status**: ❌ Not started (new, proposed 2026-08-05). **Priority**: Unprioritized.

### Goal
Split Storybook out of the `design-tokens` repo into its own repository, so the tokens
repo stays a lean, single-purpose source of truth (just `design-tokens.json` +
validation) and Storybook's own dependency tree (React, Vite, Storybook + addons)
doesn't bloat or complicate it.

### Problem addressed
User's own framing: keep it scalable, without adding complexity. Today `design-tokens`
conflates two different concerns in one repo/one `package.json`: the data source of
truth, and a documentation site with its own framework, build tooling, and addon
dependencies. As the token set or Storybook's own tooling grows, every consumer who
only wants the JSON pays for the documentation site's dependency weight too, and PR
review noise mixes token changes with any docs-site-only change.

### Dependencies
Needs Phase 4 (CI/CD, shipped) — this splits its existing `ci.yml`/`deploy-
storybook.yml` across two repos instead of one. No dependency on any unshipped phase.

### Repo layout

```
design-tokens/                 (existing, trimmed)
  design-tokens.json
  .design-sync/audit-log.jsonl
  .storybook-sync.json
  scripts/validate-tokens.mjs
  .github/workflows/ci.yml     (validate only, no Storybook build)

design-tokens-storybook/       (NEW)
  .storybook/
  src/stories/*.stories.tsx
  src/tokens.ts                 (fetches design-tokens.json from the OTHER repo
                                  at build time — a raw-content fetch, not a copy)
  package.json                  (Storybook + React + addon deps, fully isolated)
  .github/workflows/
    build-and-deploy.yml        (see trigger, below)
```

### Algorithm — cross-repo trigger
Token changes still land in `design-tokens` via the existing sync PR flow, unchanged.
To rebuild the now-separate Storybook: on merge to `design-tokens`'s main branch, its
CI fires a `repository_dispatch` event at `design-tokens-storybook`, which runs its own
build + deploy — same effect as today's single-repo `deploy-storybook.yml`, just
crossing a repo boundary. The plugin's "Rebuild Storybook" button targets the new
repo's workflow via `workflow_dispatch` instead of (or in addition to) the old one.

### Plugin-side change
`GithubSettings` gains an optional `storybookRepo` field — **absent means "same repo as
design-tokens.json,"** which is today's exact behavior, so every existing single-repo
setup keeps working with zero migration. Only a team that explicitly wants the split
sets it. Connect tab: a new optional field, collapsed behind the same "Enter repository
manually" disclosure pattern already used for owner/repo/branch/path.

### Acceptance criteria
- A token sync PR merging in `design-tokens` triggers a Storybook rebuild in
  `design-tokens-storybook` with no manual step.
- The Status tab's three-way health check reads the marker + Pages deployment status
  from the correct repo (the separate one, if configured).
- An existing single-repo setup (`storybookRepo` unset) behaves identically to today,
  with no user action required.

### Rejected alternatives
- **npm-publish `design-tokens.json` as a package Storybook installs.** Rejected: adds
  a publish/versioning step for what's fundamentally a raw data fetch; a direct GitHub
  raw-content fetch at build time needs no registry.
- **Git submodule.** Rejected: a well-known source of contributor confusion (stale
  pointers, easy to forget `--recurse-submodules`) — not worth it for one JSON file.

---

## 20. Phase 19 — PR governance agent (policy-based auto-merge)

**Status**: ❌ Not started (new, proposed 2026-08-05). **Priority**: Unprioritized.

### Goal
An automated agent that reviews open sync PRs against a declared, committed policy and
merges the ones that clearly qualify — reducing the manual-merge bottleneck for
low-risk syncs while keeping genuinely risky changes gated on a human.

### Problem addressed
User's own framing: "find and merge the open PR, kind of governance skill, based on
data, we can put some kind of authentication for it." Today every sync PR sits for
manual review regardless of risk — a single color nudged by a trusted designer, with no
conflicts and only cascade-only downstream effects, waits exactly as long as a 200-token
conflict-heavy change. For the consultancy/agency profile identified in Phase 6's
new-evidence note (many simultaneous client repos), this manual bottleneck is the actual
reason "governance" has to mean more than "sync," not less.

### Dependencies
Requires Phase 3 (PR-based sync, shipped) and Phase 5 (audit log, shipped — the policy
engine reads the audit entry's `changes` array to classify risk). Related to Phase 13
(contrast linting) and Phase 7 (AI-assisted diff) as future additional signals; neither
is required for a v1.

### Data model — policy file, committed to the tokens repo (reviewable via PR, same as
everything else in this system)

```yaml
# .design-sync/merge-policy.yml
autoMergeWhen:
  - allChangesCascadeOnly: true
  - authorIn: ["known-designer-1", "known-designer-2"]
  - ciChecksPass: true
  - noValidationErrors: true
neverAutoMergeWhen:
  - touchesCategory: ["color"]     # example: always human-reviewed; spacing might not be
  - changeCount: ">50"             # large blast-radius syncs always reviewed
```

### Algorithm
1. New workflow (`governance-agent.yml`), triggered on `pull_request` for
   `design-sync/sync-*` branches only — never runs against a human-authored PR.
2. Reads `merge-policy.yml` + the matching audit-log entry for this PR.
3. Any `neverAutoMergeWhen` match short-circuits to "leave for human review," with a PR
   comment explaining which rule fired. Otherwise, if every `autoMergeWhen` condition
   holds, the workflow approves and merges via a **separate, narrowly-scoped bot
   credential** — not a human's PAT.
4. Every decision (merged or deferred) is posted as a PR comment naming the rule that
   fired — inspectable after the fact, never a silent black box.

### Authentication (the user's own callout)
This must run as a distinct identity from any human's PAT. A **GitHub App installation
token** is the right mechanism — scoped, short-lived, independently revocable, and shows
up in PR history as "merged by [App Name]," never impersonating a person. This is a
meaningfully different auth model from everything else in this project (all PAT-based
today) — flagged explicitly as new surface area, not an incremental extension.

### UI changes
A small "Governance" section (Status tab, or its own) listing recent auto-merge
decisions — reuses History's existing audit-entry-row component, tagged with an
"auto-merged by policy" badge distinct from human-merged entries.

### Acceptance criteria
- A cascade-only, no-conflict PR from a trusted actor merges within one CI run, zero
  human action, attributed to the bot identity.
- A PR touching `color` (per the example policy) is never auto-merged regardless of
  other conditions, with a clear comment explaining why it's waiting.
- Changing merge rules is itself a reviewable PR against `merge-policy.yml` — no
  separate admin UI for policy.

### Rejected alternatives
- **Auto-merge based on an LLM confidence score alone.** Rejected as the sole gate —
  too opaque, and contradicts this project's standing "no silent auto-resolution"
  principle. A declarative, human-authored policy (that an LLM could *assist* writing,
  future Phase 7 tie-in) is safer than an LLM directly deciding merge-worthiness.
- **Auto-merge using the requesting user's own PAT.** Rejected: conflates "this person
  can sync" with "this bot can auto-approve," and makes the audit trail lie about who
  actually approved the merge.

---

## 21. Phase 20 — Notification routing: groups + urgency-based mentions

**Status**: ❌ Not started (new, proposed 2026-08-05). **Priority**: Unprioritized —
extends Phase 9 (shipped), not a new mechanism.

### Goal
Post sync notifications to a team/group channel and @-mention the right point of
contact directly, scaled by urgency — a routine cascade-only sync posts quietly; a
conflict-heavy or color-category change pings the design lead directly.

### Problem addressed
User's own framing: "sending notification on channel in teams, can we do it for a group
and can tag the right PoC directly based on urgency?" Today's `notify-on-sync.mjs`
posts one flat message to one webhook, no routing logic, no distinction between "FYI"
and "someone should look at this now."

### Dependencies
Requires Phase 9 (notifications, shipped) — a direct extension. Reuses the exact policy-
file pattern introduced in Phase 19 above rather than inventing a second config format.

### Data model

```yaml
# .design-sync/notify-routing.yml
default:
  channel: "#design-tokens"
escalate:
  - when: { touchesCategory: ["color"], hasConflicts: true }
    mention: ["@design-lead"]
    channel: "#design-tokens-urgent"
  - when: { changeCount: ">50" }
    mention: ["@design-lead", "@eng-lead"]
```

### Algorithm
`notify-on-sync.mjs` (already reads the audit entry) gains a routing step: evaluate
`notify-routing.yml` top-to-bottom, use the first match's channel + mentions, fall back
to `default`. Teams/Slack mentions need resolving a human-readable handle to the
platform's real mention syntax (`<at>Name</at>` for Teams Adaptive Cards, `<@USERID>`
for Slack) — a plain "@design-lead" string notifies nobody on either platform, so a
small handle → platform-ID mapping table is required, not optional.

### UI changes
Connect tab's existing Notifications guide gains a collapsed "Routing rules (optional)"
sub-section, linking to editing `notify-routing.yml` directly on GitHub — consistent
with this project's pattern of team-shared config living in a reviewable file, not a
plugin-side form.

### Acceptance criteria
- A routine sync posts to the default channel with no mention.
- A color-category sync with unresolved conflicts posts to the escalation channel and
  correctly @-mentions the configured PoC in each platform's real mention format.
- A malformed or missing routing file falls back to today's flat single-channel
  behavior rather than failing the notification outright.

### Rejected alternatives
- **Build routing/mention config into the plugin's own UI instead of a committed YAML
  file.** Rejected: breaks from this project's "team-shared config lives in a
  reviewable file" pattern, and would require the plugin to somehow maintain a
  Teams/Slack user directory — not this plugin's problem to own.

---

## 22. Phase 21 — SDLC / issue-tracker integration (JIRA, Teams Planner)

**Status**: ❌ Not started (new, proposed 2026-08-05). **Priority**: Unprioritized.

### Goal
Every sync creates or updates a tracked work item (JIRA ticket or Planner task)
automatically — comments, status transitions, and a screenshot of the actual visual
change attached — so a token change carries the same change-tracking discipline as any
other SDLC change.

### Problem addressed
User's own framing: "if we look for SDLC, nobody make changes in colors randomly,
there is always a track for it." Phase 5's audit trail is real but self-contained —
invisible to whatever ticketing system the rest of the org already runs sprints on. No
way to see "which ticket is this token change part of," and no way for a sync to
participate in an existing status workflow (In Review → Done).

### Dependencies
Requires Phase 5 (audit log — the event source, same as notifications). Pairs naturally
with Phase 19's governance agent — screenshot capture + comment-posting is the same
class of "agent acting on the repo's behalf," likely the same GitHub App identity.

### Data model

```yaml
# .design-sync/issue-tracker.yml
provider: jira   # or "planner"
projectKey: DS
linkField: "design-sync.ticketRef"   # read from a token's $extensions, if set manually
```

### Algorithm
1. On sync PR open (same trigger as notifications): if the PR's changed tokens carry a
   `design-sync.ticketRef` extension (same mechanism as Phase 14's deprecation
   metadata), comment on that **existing** ticket instead of creating a new one.
2. Otherwise, create a new ticket via JIRA's REST API (`POST /rest/api/3/issue`) or
   Planner's Graph API (`POST /planner/tasks`), titled from the audit-entry summary,
   linked back to the PR.
3. Attach a screenshot: the Storybook build (Phase 18's dedicated repo, or today's) can
   render the changed token(s) headlessly (Storybook's own test-runner/Playwright
   integration — already common, not new infrastructure) and upload the result as a
   ticket attachment.
4. On PR merge, transition the ticket (→ "Done"/"Deployed"); on close-without-merge,
   transition to a "Rejected" equivalent.

### Credentials
A JIRA API token or a Planner (Microsoft Graph) app registration — a **third** distinct
credential type in this system, alongside the GitHub PAT and Phase 19's GitHub App.
Stored the same way Teams/Slack webhook URLs already are: a repo secret, never touching
the plugin/Figma side — consistent with Phase 9's existing decision that a team-shared
credential doesn't belong in per-machine `clientStorage`.

### UI changes
Connect tab's setup guide gains a third optional collapsed section ("Issue tracking
(optional)"), documenting the secrets needed and the `issue-tracker.yml` file, same
"paste this here" pattern as Notifications. History tab: an entry with a linked ticket
shows a small ticket-ID chip + link next to the existing PR link.

### Acceptance criteria
- A sync PR with no existing ticket reference creates one, with a rendered screenshot
  attached and a link back to the PR.
- A sync referencing an existing ticket comments on it instead of duplicating.
- Merging the PR transitions the ticket status automatically.
- The plugin itself never sees or stores the JIRA/Planner credential — same trust
  boundary already established for notification webhooks.

### Rejected alternatives
- **Have the plugin call JIRA/Planner directly from `ui.ts`.** Rejected for the same
  reason Phase 9 rejected the plugin calling Slack directly — a team-shared credential
  doesn't belong in per-machine `clientStorage`; CI is the correct place.
- **Require every sync to have a ticket before it can merge.** Rejected as a hard gate
  — some teams' SDLC won't want every token nudge blocked on ticket creation.
  Auto-creation is opt-in via the config file's presence, not a blocking check.

---

## 23. Phase 22 — In-plugin release notifications

**Status**: ✅ Shipped (v1.19.0, 2026-08-06). **Priority**: — (done). Deviated from
this section's original GitHub-Releases-based spec — see `CHANGELOG.md`'s 1.19.0 entry:
reads `package.json` directly via the Contents API instead, since this project has
never published a GitHub Release. Requires `design-sync-plugin` to be a public repo
(confirmed public as of this release) — degrades silently (no banner, nothing else
breaks) if that ever changes.

### Goal
When a new plugin version ships, users see a clear in-app notice — what changed, and a
prompt to update — instead of silently running a stale version indefinitely.

### Problem addressed
User's own framing: "whenever we are making changes, in plugin we want to give
notification for the new release, on whats changed, etc." Today a user must manually
close and relaunch the plugin to pick up any update at all (Figma only reads `code.js`/
`ui.html` at launch), with zero in-app visibility into whether they're stale or what
changed if they do relaunch — they'd have to read `CHANGELOG.md` on GitHub themselves.

### Dependencies
None technical — fully independent, buildable anytime.

### Two real scenarios, genuinely different handling
1. **Published to Figma Community** (if this project ever gets there): Figma itself
   auto-updates on next launch; this phase narrows to "show a changelog on first launch
   after an update," using `figma.clientStorage` to remember the last-seen version and
   diff against the current build — no network call needed.
2. **Manifest-loaded / internal distribution** (this project's actual mode, per every
   setup doc today): no platform auto-update exists at all. The plugin checks a known
   location for the latest version — `GET /repos/{owner}/{plugin-repo}/releases/latest`,
   reusing the existing `githubRequest` plumbing — surfaced as a dismissible banner
   linking to release notes, **explicit that the user still has to pull + rebuild +
   relaunch manually** (no shell access, same honest-constraint pattern as every other
   "can't automate this" moment already in this project).

### UI changes
A new banner (reuses `statusBanner`) on whichever tab is active, shown once per
newer-version-seen (dismissible, tracked in `clientStorage` so it doesn't repeat), with
a "What's new" `persistentDetails` expansion pulling the relevant `CHANGELOG.md`
section.

### Acceptance criteria
- A user on an old version sees a dismissible "update available" banner with a real
  changelog summary, not a bare version number.
- Dismissing it doesn't resurface it for that same version.
- The banner is honest about what the user still has to do manually — never implies a
  one-click update that doesn't exist in this distribution mode.

### Rejected alternatives
- **Auto-reload the plugin UI on detecting a new version.** Rejected: no such API
  exists, and even if it did, silently swapping code under an active session
  contradicts this project's pattern everywhere else of user-initiated, not surprising,
  state changes.

---

## 24. Phase 23 — Visual design language revamp (v2)

**Status**: ✅ Shipped, v1.20.0 — all 5 tabs (Connect, Sync, Status, History, Custom
Tokens) reviewed and updated; released with a CHANGELOG entry via the `release` skill.
**Priority**: — (done).

### Direction chosen: "Ledger"
Near-black ink on warm paper, one confident indigo accent (`#3f4dff` light /
`#7b84ff` dark), a real type scale (22px bold headers down to 10.5px labels, only
headings/section-summary text ever bold — everything else normal weight), 2px sharp
corners (was 5px), separation via surface-color + spacing instead of borders-on-every-
container. Validated via a before/after comparison artifact against the plugin's real
CSS before any implementation began, then approved.

### What's shipped so far (chronological, all on `main`, unpushed version bump)
- **Token foundation** — full color palette, type scale (`--fs-*`/`--fw-*`), `--radius`
  replaced app-wide (every tab inherits this since it's one stylesheet).
- **Connect tab — full redesign**, done in several passes as issues surfaced in review:
  - Structural Ledger pass (compact connected-card treatment, buttons, banners,
    accordions, tags).
  - A "Cred-style" interaction pass: a hero mark + value line, progressive disclosure
    (repo search stays hidden until the token validates, auto-triggered on blur), the
    manual-entry escape hatch demoted to a plain text link, a trust badge, a brief
    success-pulse before jumping to Sync.
  - Three rounds of consistency fixes: typography (one bold heading, nothing else
    competing with it), a background for the "What permissions does this need?"
    accordion (was invisible against the new panel tone), and finally rebuilding the
    whole tab as one real `persistentDetails` accordion — "GitHub Repo" heading +
    Connected/Disconnected tag, always visible collapsed or expanded, matching
    Notifications/Recent activity's own convention exactly instead of a bespoke layout.
  - Along the way, fixed a genuine browser bug in the shared `persistentDetails()`
    helper itself (a phantom `toggle` event some browsers fire when a `<details open>`
    is first inserted, with no user interaction, which was silently overriding computed
    open/closed defaults) — benefits every accordion in the app, not just Connect's.
- **App-wide content/IA pass**: every tab now has a real page-level `<h2>` (previously
  only Custom Tokens did); a styled `[data-tip]` tooltip (CSS-only, matches Ledger)
  replaced ~11 native `title=` attributes that were invisible until hover; verbose
  inline explanation paragraphs (Connect's permission scopes, the Storybook setup
  guide) trimmed into scannable `.tag` chips + short sentences.
- **Status tab**: the Figma↔GitHub diff table (a 4-column `<table>`, unreadable/
  scroll-inducing in a ~320px panel) replaced with the same stacked diff-row layout the
  Sync tab already used for identical data — no horizontal scroll at any panel width.
- **Sync tab — diff rows**: `.diff-row` still had a full ring border + a distinct
  `--warn-bg` fill just for conflicts (the "box every container" pattern already
  replaced everywhere else). Moved to the same `.status-banner` treatment — neutral
  `--bg-subtle` fill, a colored left edge as the only status signal — which improved
  History's plain diff-rows and Status tab's diff-rows for free (shared class). The
  `.diff-badge` ("Conflict"/"New in Figma"/"New in GitHub") also went from uniform gray
  to a status-matched soft tint (`color-mix` against `--surface`, no new tokens), so the
  badge, the row's left edge, and the Figma/GitHub value labels now all agree on one
  color per row instead of the badge being the one element with no signal. Removed the
  now-dead `--warn-bg` token. `.resolution-toggle`'s border and `.diff-value-label`'s
  solid-fill style were deliberately left alone — functional controls / a high-
  scannability label, not the boxed-container problem this pass targets.

- **Custom Tokens tab**: Title Case heading (was "Custom tokens"), category headings
  (Dimension/String/Boolean) paired with a count `.tag` matching Sync's identical
  pattern, row remove buttons given an accessible name, "+ Add token" given an icon —
  same discoverability/consistency fixes already applied elsewhere. `table.token-table`
  itself needed no structural change (already on current tokens from the app-wide pass).
- **History tab**: diff-rows picked up the Sync-tab fix above for free (shared CSS
  class); the Revert button's own defect is tracked and now fixed under Phase 5 (§6),
  not here.

### Released
v1.20.0 (2026-08-12) — see `CHANGELOG.md` for the full entry. Committed locally;
push to `origin/main` is a separate, explicit step (not done by the `release` skill
automatically).

---

## 25. Cross-phase dependency graph

```
Phase 1 (token model) ───────┬──────────────────────────────────────────┐
   [SHIPPED]                 │                                          │
                              │    Phase 6 (multi-brand) ──┐             │
Phase 2 (Variable write-back)│       [LOWEST PRIORITY]      │             │
   (needs Phase 1)           │                             │             │
   [SHIPPED]                 │                             ▼             ▼
                              │                     Phase 10 (backend) ──► Phase 11 (drift detection)
Phase 3 (PR-based sync) ─────┤                        (needs 5, 6)         (needs 1, 10)
   [SHIPPED]                 │                     [MEDIUM — NOT NOW]      [BLOCKED on 10]
                              │                             ▲
Phase 4 (CI/CD) ─────────────┤                             │                    │
   (pairs with 3)            │    Phase 5 (audit/rollback) ┘                    ▼
   [SHIPPED]                 │       (pairs with 3)                   Phase 15 (blast-radius preview)
                              │       [SHIPPED]                          (needs 11)
Phase 7 (AI diff) ────────────┘            │                             [UNPRIORITIZED, blocked]
   (needs Phase 1)                          ▼
   [MEDIUM — NOT NOW]               Phase 9 (notifications)
                                       (needs Phase 5)
                                       [PARTIAL — notifications shipped,
                                        status page shipped then reverted]
                                            │
                                            ▼ (same audit-log event source)
                                   Phase 16 (concurrent-sync lock)
                                      (needs Phase 3 only)
                                      [UNPRIORITIZED]

Phase 8 (cross-platform) — needs Phase 1, otherwise independent. [LOWEST PRIORITY]

Phase 12 (PR previews) — needs Phase 3 + Phase 4. [UNPRIORITIZED]
Phase 13 (contrast lint) — needs Phase 1, pairs with Phase 4. [UNPRIORITIZED]
Phase 14 (deprecation lifecycle) — needs Phase 1, complements Phase 11. [UNPRIORITIZED]
Phase 17 (Figma deep-links) — needs Phase 1 + Phase 4. [UNPRIORITIZED]

Phase 18 (dedicated Storybook repo) — needs Phase 4. [UNPRIORITIZED]
   └─► Phase 21 (SDLC/issue-tracker) — screenshot step benefits from 18, not required.

Phase 19 (governance agent) — needs Phase 3 + Phase 5. [UNPRIORITIZED]
   ├─► Phase 21 (SDLC/issue-tracker) — same "agent acting on the repo" identity.
   └─► Phase 7 (AI diff) — a mature policy engine could consume Phase 7's signals later.

Phase 20 (notification routing) — needs Phase 9 (notifications half). [UNPRIORITIZED]
   reuses Phase 19's policy-file pattern, but does NOT require Phase 19 itself.

Phase 21 (SDLC/issue-tracker) — needs Phase 5. [UNPRIORITIZED]
Phase 22 (in-plugin release notices) — no dependencies, fully independent. [UNPRIORITIZED]
Phase 23 (visual design v2) — no technical dependencies. [IN PROGRESS — Connect tab
   + app-wide token/heading/tooltip pass shipped to main; Sync/History/Custom Tokens
   still pending, not yet released as a version bump]
```

## 26. Suggested build order

Reflects the 2026-08-05 priority decisions above — phases marked Lowest/Medium/Blocked
are listed for completeness, not as a recommendation to pick them up now.

**Shipped** (for reference, not re-sequencing): Phase 1 → Phase 4 → Phase 3 → Phase 5 →
Phase 2 → Phase 9 (notifications half only) → Phase 22 (v1.19.0).

**Do first, ahead of any new phase** — this is a defect on already-shipped work, not
new capability, and it's small:

0. **Phase 5's Revert UX fix** (see the flagged note in §6) — a `button.danger` variant
   plus a confirmation step before `runRevert` fires. No dependencies, touches one
   existing screen, and it's the one item on this whole list a user explicitly called
   "a complete miss."

**If/when work resumes on new phases**, in dependency-respecting order:

1. **Phase 16 (concurrent-sync advisory lock)** — needs only Phase 3 (shipped), cheapest
   remaining phase relative to payoff: closes a real, documented known-limitation with
   one read-only API call and one banner, no new infrastructure.
2. **Phase 12 (PR preview builds)** — needs Phase 3 + 4 (both shipped), pure CI addition,
   no plugin code changes required for a v1 (the PR comment alone suffices).
3. **Phase 13 (contrast/accessibility linting)** — needs Phase 1 (shipped), pairs
   directly with the existing `validate-tokens.mjs` CI step.
4. **Phase 14 (token deprecation lifecycle)** — needs Phase 1 (shipped), stands alone
   without Phase 11 but is most valuable once Phase 11 exists.
5. **Phase 17 (Figma deep-linking)** — needs Phase 1 + 4 (both shipped), Storybook-only
   change, zero plugin-side risk.
6. **Phase 18 (dedicated Storybook repo)** — needs Phase 4 (shipped). Worth doing before
   Phase 21, since Phase 21's screenshot step is cleaner once Storybook already lives in
   its own build context — but not a hard blocker either way.
7. **Phase 20 (notification routing)** — needs Phase 9's notifications half (shipped).
   Self-contained extension; doesn't require Phase 19 despite sharing its policy-file
   *pattern*.
8. **Phase 19 (governance agent)** — needs Phase 3 + 5 (both shipped). Bigger than #1–7
   above — new auth surface (a GitHub App, not a PAT) — sequence after the smaller wins
   so the team has full context on the repo before adding a new credential type.
9. **Phase 21 (SDLC/issue-tracker integration)** — needs Phase 5 (shipped), pairs
    naturally with Phase 19's agent identity once that exists.
10. **Phase 6 (multi-brand)** — **lowest priority, but re-flagged** (§7's new-evidence
    note): revisit if a consultancy/agency-style multi-client need shows up, which this
    project's own test data suggests isn't hypothetical.
11. **Phase 8 (cross-platform/Style Dictionary)** — currently **lowest priority, no known
    use case**. Only pick this up if native-platform (iOS/Android) demand shows up.
12. **Phase 7 (AI-assisted diff)** — currently **medium, not now**. Highest payoff once
    token sets are large (post multi-brand) — revisit once Phase 6 is either done or
    confirmed permanently out of scope.
13. **Phase 10 (backend/platform layer)** — currently **medium, not now**. The capstone;
    revisit once file/CI-based state genuinely stops scaling, or once Phase 19's PAT-scope
    growth pain (§1b) makes scoped API tokens worth building sooner.
14. **Phase 11 (drift detection)** — blocked on Phase 10. Not actionable until Phase 10
    is picked back up.
15. **Phase 15 (blast-radius preview)** — blocked on Phase 11 (and therefore transitively
    on Phase 10). Last in the chain by construction.

**Phase 23 (visual design v2)** is intentionally absent from the numbered list above —
it isn't blocked on anything technical and is currently the phase actually being worked
(see §24): direction chosen, Connect tab + app-wide token/heading/tooltip pass shipped
to `main`, Sync/History/Custom Tokens still pending. Running in parallel with the
"do first" Revert UX fix above, not sequenced against the other unstarted phases.

---

*End of specification. Each phase section above is intended to be handed to an LLM
developer independently, with §0–§1 (system recap and conventions) included as shared
context regardless of which phase is being implemented.*
