---
name: release
description: Ship a code change in this Figma plugin repo (design-sync-plugin) — rebuild, verify the change actually landed in the bundle, bump the version, write a CHANGELOG entry, and commit. Use this whenever the user asks to "release", "ship this", "bump and push", "cut a version", or after making any edit to ui.ts, code.ts, or shared/tokens.ts that they want finalized — even if they don't name this skill explicitly. Do not use it for unrelated repos, or for changes that are still in-progress/exploratory and not ready to ship.
---

# Releasing a change in this Figma plugin

This repo has no CI-driven release process and no browser preview — a
Figma plugin's UI only runs inside Figma's desktop app, so the usual
"start dev server, look at it" verification loop doesn't exist here.
Everything in this skill exists to compensate for that gap: a clean
build is necessary but not sufficient proof a change worked, so this
skill's step 2 (verify) is the part most worth not skipping.

## 1. Rebuild and gate on it

```bash
npm run lint && npm run build
```

Both must pass with zero errors before continuing. `npm run build` runs
two independent steps — `build:main` (type-checks and esbuild-bundles
`code.ts` + `shared/` into `code.js`) and `build:ui` (same for `ui.ts` →
`ui.html`) — because Figma loads `code.js` as a plain script and
`ui.html` as one self-contained file; a bare `import` left in by a naive
`tsc`-only build makes Figma refuse to load the plugin entirely ("unable
to run"). If either step fails, fix it and re-run before moving on —
don't bump the version or write a changelog entry for something that
doesn't build.

## 2. Verify the change actually landed — don't just trust the build

A clean compile only proves the TypeScript is valid; it doesn't prove
the specific change is in the bundle a user will actually load. Pick a
string, function name, or identifier unique to the change and confirm
it's present in the built output:

```bash
grep -o "the-new-string-or-identifier" code.js ui.html
```

If it's missing from the file that should contain it, something didn't
wire up right (wrong file edited, dead code path, a typo in what you
thought was the entry point) — go find out why before calling this done.

This repo has no other verification path available. Do not attempt to
open a dev server or browser preview for this plugin — say explicitly
that verification here is grep-the-bundle plus a manual reload, not a
live check, so the user isn't left assuming more was verified than
actually was.

Then tell the user: **reload the plugin in Figma** (Plugins → Development
→ [Design Sync] → Reload, or close/reopen the plugin panel) before they'll
see anything — Figma only reads `code.js`/`ui.html` at the moment the
plugin launches, it does not hot-reload a running instance.

## 3. Decide the version bump

Read `package.json`'s current `version` and decide the bump using this
project's actual policy (stated in `CHANGELOG.md`'s intro, and the
pattern already visible in its version history):

- **Patch** (`1.2.1` → `1.2.2`) — bug fix, no behavior/shape change a
  user would need to know about.
- **Minor** (`1.2.x` → `1.3.0`) — additive feature, OR a breaking change
  to internal behavior/data shape (e.g. Sync switching from direct
  commit to opening a PR, which changed `SyncHistoryEntry`'s fields).
  This project isn't a library with external consumers pinning a
  version range, so a breaking internal change doesn't need a major
  bump — it needs an honest **"Breaking:"** callout in the changelog
  entry instead, so anyone reading the history understands what changed
  and why, without the ceremony of a major version a solo Figma plugin
  doesn't benefit from.
- **Major** — reserved for an actual architectural rewrite, not used so
  far in this project's history. Don't reach for it by default.

If multiple small fixes/features are landing together in one release,
one bump covering all of them is fine — don't bump per-commit.

```bash
node -e "const p=require('./package.json'); p.version='X.Y.Z'; require('fs').writeFileSync('package.json', JSON.stringify(p,null,2)+'\n')"
```

## 4. Write the CHANGELOG entry

Add a new `## [X.Y.Z] - YYYY-MM-DD` section directly above the previous
most recent version in `CHANGELOG.md`, using today's date. Follow the
Keep a Changelog `### Added` / `### Changed` / `### Fixed` structure
already used throughout the file, and match its existing voice: terse,
technical, and focused on **why**, not just what changed — every existing
entry explains the reasoning or the bug being fixed, not just "added X."
Read a couple of existing entries before writing a new one if the tone
isn't fresh in mind; consistency here matters more than any individual
entry being clever.

## 5. Rebuild again

The plugin's UI footer bakes in `package.json`'s version at build time
(see `PROJECT.md` / `CHANGELOG.md`'s 1.0.1 entry) — run `npm run build`
a second time after the version bump, or the shipped footer will show
the *previous* version.

```bash
npm run build
```

## 6. Commit

Match this repo's existing commit style — check `git log --oneline -5`
if it's been a while, but the consistent pattern is: a summary line
ending in `, vX.Y.Z`, a blank line, then 2-4 sentences of body explaining
the change and its reasoning (not a bullet-by-bullet restatement of the
diff). Stage only the files actually part of this release (`package.json`,
`CHANGELOG.md`, the edited source files) — never `git add -A` blindly in
case something unrelated is sitting in the working tree.

## 7. Push — only if asked

Do **not** push to `origin main` as part of this skill by default.
Pushing is a shared-repo action (see the assistant's standing safety
rules on hard-to-reverse/visible-to-others actions) — commit locally,
then either wait for the user to say "push it" in this turn, or rely on
a standing instruction they've already given. If they haven't said
either, stop after the commit and say so plainly rather than pushing and
mentioning it afterward.

## What this skill deliberately does not do

- Doesn't touch git history destructively (no amend, no force-push, no
  reset) — a release is always a new commit.
- Doesn't skip the lint/build gate under time pressure — a broken build
  shipped to Figma fails with "unable to run" and no useful error for
  the end user, which is a worse outcome than a slower release.
- Doesn't assume "it compiled" means "it works" — step 2 exists
  specifically because that assumption has been wrong before in this
  project's history (see `PROJECT.md` §10 for the actual bugs this
  caused).
