// Design Sync — pure diff/merge logic, extracted from ui.ts.
//
// Everything here is a plain function over TokenSet data: no figma.*, no
// fetch, no DOM. That's what makes it unit-testable with node:test without
// a Figma runtime or a browser — see sync-logic.test.ts. ui.ts imports from
// here rather than defining these itself.

import type { DesignToken, TokenCategory, TokenSet } from './shared/tokens';
import { emptyTokenSet, resolveToken, TOKEN_CATEGORIES } from './shared/tokens';

export type Resolution = 'figma' | 'github' | 'skip';

export interface DiffEntry {
  category: TokenCategory;
  key: string;
  figmaValue: unknown;
  githubValue: unknown;
  figmaDisplay: string;
  githubDisplay: string;
  status: 'added-figma' | 'added-github' | 'modified' | 'unchanged';
  // True only when status is 'modified' AND the two sides' raw $value are
  // byte-identical (e.g. a reference token whose refKey didn't change, but
  // what it resolves to did because the thing it points at changed
  // elsewhere in this same diff). buildSyncPlan's merge does the identical
  // raw-value check before ever consulting a resolution, so a cascade-only
  // row's resolution button is inert — it can't affect what actually gets
  // written. Kept separate from 'modified' rather than its own status so
  // every existing `status === 'modified'` check still includes it for
  // "did this key's rendered value change" purposes; only the parts that
  // care about "does a decision here matter" need to branch on this.
  cascadeOnly: boolean;
}

export function isReferenceToken(val: unknown): boolean {
  return !!val && typeof val === 'object' && (val as DesignToken<unknown>).$value?.kind === 'reference';
}

export interface ResolvedForDiff {
  value: unknown;
  error: string | null;
}

// Resolves a token's value against `context` (the same-side full token set —
// a Figma-side reference resolves against Figma's own current data, a
// GitHub-side one against GitHub's), catching (not throwing) any broken or
// circular reference so one bad token can't take down the whole diff.
export function resolveForDiff(category: TokenCategory, key: string, token: unknown, context: TokenSet): ResolvedForDiff {
  if (token === undefined) return { value: undefined, error: null };
  try {
    return { value: resolveToken(key, category, context), error: null };
  } catch (err) {
    return { value: undefined, error: err instanceof Error ? err.message : String(err) };
  }
}

export function formatResolved(token: unknown, resolved: ResolvedForDiff): string {
  if (token === undefined) return '—';
  if (resolved.error) return `⚠ ${resolved.error}`;
  const resolvedStr = typeof resolved.value === 'string' ? resolved.value : JSON.stringify(resolved.value);
  const t = token as DesignToken<unknown>;
  if (t.$value?.kind === 'reference') return `→ ${t.$value.refKey} (${resolvedStr})`;
  return resolvedStr;
}

export function diffTokenSets(figmaTokens: TokenSet, githubTokens: TokenSet): DiffEntry[] {
  const entries: DiffEntry[] = [];
  for (const category of TOKEN_CATEGORIES) {
    const fCat = figmaTokens[category] as Record<string, unknown>;
    const gCat = githubTokens[category] as Record<string, unknown>;
    const keys = Array.from(new Set([...Object.keys(fCat), ...Object.keys(gCat)])).sort();
    for (const key of keys) {
      const fVal = fCat[key];
      const gVal = gCat[key];
      const fResolved = resolveForDiff(category, key, fVal, figmaTokens);
      const gResolved = resolveForDiff(category, key, gVal, githubTokens);

      let status: DiffEntry['status'];
      if (fVal !== undefined && gVal === undefined) status = 'added-figma';
      else if (fVal === undefined && gVal !== undefined) status = 'added-github';
      else {
        // Compare RESOLVED values, not raw $value structure — a token
        // migrating between a flat legacy value and a live Variable
        // reference (or a reference whose target got renamed but not
        // re-valued) shouldn't read as a conflict when what it actually
        // resolves to hasn't changed. A resolution failure on either side
        // always counts as "different" — never silently treated as a match.
        const same = !fResolved.error && !gResolved.error && JSON.stringify(fResolved.value) === JSON.stringify(gResolved.value);
        status = same ? 'unchanged' : 'modified';
      }

      // Mirrors buildSyncPlan's own raw-value equality check exactly — that
      // function decides "unchanged, nothing to apply" before ever looking
      // at a resolution, so a 'modified' row whose raw $value is identical
      // on both sides (a reference token whose target changed elsewhere)
      // can't be affected by any resolution choice made here. Only compute
      // this for 'modified' rows; it's meaningless for added/unchanged.
      const cascadeOnly = status === 'modified' && JSON.stringify(fVal) === JSON.stringify(gVal);

      entries.push({
        category,
        key,
        figmaValue: fVal,
        githubValue: gVal,
        figmaDisplay: formatResolved(fVal, fResolved),
        githubDisplay: formatResolved(gVal, gResolved),
        status,
        cascadeOnly,
      });
    }
  }
  return entries;
}

export function buildSyncPlan(
  figmaTokens: TokenSet,
  githubTokens: TokenSet,
  resolutions: Record<string, Resolution>,
): { final: TokenSet; figmaApply: TokenSet } {
  const final = emptyTokenSet();
  const figmaApply = emptyTokenSet();
  for (const category of TOKEN_CATEGORIES) {
    const fCat = figmaTokens[category] as Record<string, unknown>;
    const gCat = githubTokens[category] as Record<string, unknown>;
    const finalCat = final[category] as Record<string, unknown>;
    const applyCat = figmaApply[category] as Record<string, unknown>;
    const keys = new Set([...Object.keys(fCat), ...Object.keys(gCat)]);
    for (const key of keys) {
      const fVal = fCat[key];
      const gVal = gCat[key];
      const res = resolutions[`${category}:${key}`];
      if (fVal !== undefined && gVal === undefined) {
        if (res !== 'skip') finalCat[key] = fVal;
      } else if (fVal === undefined && gVal !== undefined) {
        finalCat[key] = gVal;
        if (res !== 'skip') applyCat[key] = gVal;
      } else if (fVal !== undefined && gVal !== undefined) {
        if (JSON.stringify(fVal) === JSON.stringify(gVal)) {
          finalCat[key] = fVal;
        } else if (res === 'skip') {
          // Leave GitHub's stored value untouched; Figma keeps diverging
          // until this conflict is resolved in a later sync.
          finalCat[key] = gVal;
        } else {
          const chosen = res === 'github' ? gVal : fVal;
          finalCat[key] = chosen;
          if (res === 'github') applyCat[key] = chosen;
        }
      }
    }
  }
  return { final, figmaApply };
}

// Whether a token was originally read from a Figma Variable — and if so,
// which variable/mode — is a fact about Figma's *current* state. It must
// not depend on which side's value won a conflict: if "Use GitHub" wins,
// figmaApply's token carries GitHub's stored $extensions, which can be
// stale or missing modeId entirely (e.g. every token synced before that
// field existed, or a token someone hand-edited directly on GitHub). If
// Figma currently has this exact key as a variable, code.ts needs to know
// that regardless of whose value is being written — otherwise a
// "Use GitHub" resolution for a variable-backed token silently degrades
// to creating a same-named Style instead of updating the variable, with
// no visible change to whatever's actually bound to that variable in the
// design.
export function preferLiveFigmaExtensions(figmaApply: TokenSet, figmaTokens: TokenSet): void {
  for (const category of ['color', 'dimension', 'string', 'boolean'] as const) {
    const applyBucket = figmaApply[category] as Record<string, DesignToken<unknown>>;
    const figmaBucket = figmaTokens[category] as Record<string, DesignToken<unknown>>;
    for (const [key, token] of Object.entries(applyBucket)) {
      const liveExt = figmaBucket[key]?.$extensions;
      if (liveExt?.['design-sync.figmaSourceType'] === 'variable' && liveExt['design-sync.variableId'] && liveExt['design-sync.modeId']) {
        applyBucket[key] = { ...token, $extensions: liveExt };
      }
    }
  }
}

// Neither Figma Styles nor Figma Variables understand our reference
// structure — a Style write needs a concrete value outright, and while a
// Variable write-back *could* in principle write a native VARIABLE_ALIAS
// for a reference, doing that safely requires the reference's target to
// itself be a known Figma variable, which isn't guaranteed (e.g. a
// GitHub-only chain). Resolving to a concrete value uniformly, for every
// category, keeps applyTokensToFigma's write paths simple and consistent
// (Phase 2 write-back: real Variable-alias write-back is a possible later
// refinement, not required for tokens to sync correctly today).
// `figmaApply` only contains a *subset* of tokens (the delta), so a
// reference inside it might point at a token that isn't in that subset —
// resolve against `context` (the full merged set) instead, which always
// has everything.
export function resolveForFigmaApply(figmaApply: TokenSet, context: TokenSet): TokenSet {
  const resolved = emptyTokenSet();
  for (const category of TOKEN_CATEGORIES) {
    const bucket = figmaApply[category] as Record<string, DesignToken<unknown>>;
    const target = resolved[category] as Record<string, DesignToken<unknown>>;
    for (const [key, token] of Object.entries(bucket)) {
      if (token.$value.kind === 'value') {
        target[key] = token;
        continue;
      }
      try {
        const value = resolveToken(key, category, context);
        target[key] = { ...token, $value: { kind: 'value', value } };
      } catch {
        // Broken/circular reference — validateTokenSet (run before Sync is
        // ever enabled) should have already caught this; skip defensively
        // rather than crash the whole sync over one bad token.
      }
    }
  }
  return resolved;
}

// Rows that need an actual decision (real conflicts, then new-on-one-side
// opt-outs) come first; cascade-only rows — nothing to decide, they settle
// on their own once their underlying reference is handled — sort last.
// Array.prototype.sort is stable, so within a tier the original alphabetical
// key order (set by diffTokenSets) is preserved.
export function diffRowPriority(d: DiffEntry): number {
  if (d.status === 'modified' && !d.cascadeOnly) return 0;
  if (d.status === 'added-figma' || d.status === 'added-github') return 1;
  return 2; // cascadeOnly
}

// Compares the fully-merged result against what's currently stored on
// GitHub, category by category, key by key. If nothing differs, opening a
// branch + PR would just be empty noise — see runSync in ui.ts.
export function githubContentChanged(final: TokenSet, githubTokens: TokenSet): boolean {
  return TOKEN_CATEGORIES.some((category) => {
    const finalCat = final[category] as Record<string, unknown>;
    const gCat = githubTokens[category] as Record<string, unknown>;
    const keys = new Set([...Object.keys(finalCat), ...Object.keys(gCat)]);
    for (const key of keys) {
      if (JSON.stringify(finalCat[key]) !== JSON.stringify(gCat[key])) return true;
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// Audit trail (Phase 5)
// ---------------------------------------------------------------------------

export type AuditChangeType = 'added' | 'modified' | 'removed';

export interface AuditChange {
  key: string;
  category: TokenCategory;
  changeType: AuditChangeType;
  previousValue?: unknown; // omitted for 'added' (nothing existed on GitHub before)
  newValue?: unknown; // omitted for 'removed'
  // null when no explicit resolution was recorded for this key — e.g. a
  // new-on-GitHub row included by its opt-out-default rather than an
  // explicit click (see the "Include in sync" checkbox in ui.ts).
  resolution: Resolution | null;
}

export interface AuditEntry {
  timestamp: string; // ISO
  actor: string; // GitHub username, resolved via GET /user at sync time
  prNumber: number;
  prUrl: string;
  branch: string; // the head branch the PR was opened from
  changes: AuditChange[];
}

// The audit trail's source of truth for "what did this sync actually
// change" — anywhere, not just on GitHub. A key can change in one of two
// directions: Figma's value wins and gets committed to GitHub (final now
// matches Figma, GitHub's old value was overwritten), or GitHub's value
// wins and gets written back to Figma (final now matches GitHub, Figma's
// old value was overwritten). Comparing final only against githubTokens
// (an earlier version of this function did exactly that) catches the first
// direction but is blind to the second: when a resolution pulls GitHub's
// own already-current value into Figma, final ends up byte-identical to
// githubTokens, so nothing looks different — even though Figma's old value
// was genuinely just overwritten. Comparing against BOTH sides and picking
// whichever one final DIDN'T end up matching is what makes this symmetric.
export function computeAuditChanges(
  final: TokenSet,
  figmaTokens: TokenSet,
  githubTokens: TokenSet,
  resolutions: Record<string, Resolution>,
): AuditChange[] {
  const changes: AuditChange[] = [];
  for (const category of TOKEN_CATEGORIES) {
    const finalCat = final[category] as Record<string, unknown>;
    const fCat = figmaTokens[category] as Record<string, unknown>;
    const gCat = githubTokens[category] as Record<string, unknown>;
    const keys = new Set([...Object.keys(finalCat), ...Object.keys(fCat), ...Object.keys(gCat)]);
    for (const key of keys) {
      const finalVal = finalCat[key];
      if (finalVal === undefined) continue; // nothing ended up set for this key
      const fVal = fCat[key];
      const gVal = gCat[key];
      const finalStr = JSON.stringify(finalVal);
      const matchesFigma = fVal !== undefined && JSON.stringify(fVal) === finalStr;
      const matchesGithub = gVal !== undefined && JSON.stringify(gVal) === finalStr;
      if (matchesFigma && matchesGithub) continue; // both sides already agreed — no change

      // final matches one side (that side "won"); the OTHER side's old
      // value — the one that got overwritten — is what changed. If final
      // matches neither exactly (shouldn't happen given how buildSyncPlan
      // assigns final, but stay defensive), fall back to treating GitHub's
      // old value as previous, matching this function's original behavior.
      const previousValue = matchesGithub ? fVal : gVal;
      const changeType: AuditChangeType = previousValue === undefined ? 'added' : 'modified';
      changes.push({
        key,
        category,
        changeType,
        ...(previousValue !== undefined ? { previousValue } : {}),
        newValue: finalVal,
        resolution: resolutions[`${category}:${key}`] ?? null,
      });
    }
  }
  return changes;
}

// Revert is scoped to entries made ENTIRELY of 'modified' changes. An
// 'added' change has no well-defined inverse under the current merge model
// — buildSyncPlan has no "delete this key from GitHub" resolution (see
// PROJECT.md §11) — so reverting an addition isn't attempted here rather
// than silently reverting only part of a sync and leaving the rest.
export function canRevertEntry(entry: AuditEntry): boolean {
  return entry.changes.length > 0 && entry.changes.every((c) => c.changeType === 'modified');
}

// The inverse of an entry's changes — previousValue/newValue swapped — used
// to build the revert commit. Only meaningful for entries canRevertEntry
// already approved; callers are expected to check that first.
export function invertAuditChanges(changes: AuditChange[]): AuditChange[] {
  return changes.map((c) => ({
    key: c.key,
    category: c.category,
    changeType: 'modified',
    previousValue: c.newValue,
    newValue: c.previousValue,
    resolution: null,
  }));
}

// True if figmaApply (or any TokenSet-shaped delta) has at least one entry
// in any category. Used to decide whether a sync actually wrote anything
// back to Figma — a real GitHub-authored edit pulled into Figma (GitHub
// already had the new value, so githubContentChanged is false) still
// counts as a sync worth recording, even though nothing needed to change
// on GitHub's side.
export function hasAnyEntries(tokens: TokenSet): boolean {
  return TOKEN_CATEGORIES.some((category) => Object.keys(tokens[category]).length > 0);
}

// Single source of truth for where the audit log lives in the tokens repo
// — used both to build API paths (ui.ts) and inside a PR body's explanatory
// text (planSync below), which is exactly the kind of thing that drifts out
// of sync when duplicated as separate string literals in two files.
export const AUDIT_LOG_PATH = '.design-sync/audit-log.jsonl';

export interface SyncExecutionPlan {
  // Does design-tokens.json itself need a commit?
  githubChanged: boolean;
  // Does anything need to be written back to Figma?
  figmaChanged: boolean;
  // githubChanged || figmaChanged — the ONLY thing that should gate
  // whether a PR opens at all. Every bug in this area so far (a 422 from
  // an empty branch, a sync invisible to History/notifications, "0
  // changes" shown for a real change) came from some part of runSync
  // checking githubChanged alone instead of this. Centralizing the gate
  // here, tested, is the whole point of this type.
  shouldOpenPr: boolean;
  // Alias for githubChanged, named for what the caller actually does with
  // it (commitGithubTokens is only called when this is true) — kept as a
  // separate field so a future change to what "should commit" means
  // doesn't require renaming every call site that currently reads
  // `githubChanged` to mean two different things.
  shouldCommitTokens: boolean;
  // Count of real, resolved diff rows — used in log/PR-body text, not a
  // decision input.
  changedCount: number;
  // The audit-log entry's content for this sync — see computeAuditChanges
  // for why this needs BOTH figmaTokens and githubTokens, not just one.
  changes: AuditChange[];
  prBody: string;
}

// Everything runSync needs to decide BEFORE touching the network, in one
// place: whether to open a PR at all, whether to commit the tokens file,
// what the audit entry should contain, and what the PR body should say.
// Extracted specifically because every one of the last three production
// bugs (a 422 opening the PR, a sync invisible to History/notifications,
// "0 changes" shown for a real Figma update) was a mistake somewhere in
// this exact decision logic, and none of it needs figma.* or fetch to
// compute — it was only ever inline in runSync because nothing forced it
// out.
export function planSync(
  final: TokenSet,
  figmaTokens: TokenSet,
  githubTokens: TokenSet,
  figmaApply: TokenSet,
  resolutions: Record<string, Resolution>,
  diff: DiffEntry[],
  tokensPath: string,
): SyncExecutionPlan {
  const githubChanged = githubContentChanged(final, githubTokens);
  const figmaChanged = hasAnyEntries(figmaApply);
  const changedCount = diff.filter((d) => d.status !== 'unchanged' && resolutions[`${d.category}:${d.key}`] !== 'skip').length;
  const changes = computeAuditChanges(final, figmaTokens, githubTokens, resolutions);
  const prBody = githubChanged
    ? `Opened by the Design Sync Figma plugin. ${changedCount} token(s) resolved.\n\nMerging this brings \`${tokensPath}\` in line with the current Figma file.`
    : `Opened by the Design Sync Figma plugin. ${changedCount} token(s) resolved, and GitHub already matched every one of them — no change to \`${tokensPath}\` in this PR. It exists to record this sync in ${AUDIT_LOG_PATH} (see the plugin's History tab) and trigger any configured Teams/Slack notification.`;
  return {
    githubChanged,
    figmaChanged,
    shouldOpenPr: githubChanged || figmaChanged,
    shouldCommitTokens: githubChanged,
    changedCount,
    changes,
    prBody,
  };
}
