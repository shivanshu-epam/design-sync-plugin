import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyTokenSet, type DesignToken, type TokenSet } from './shared/tokens';
import {
  buildSyncPlan,
  canRevertEntry,
  computeAuditChanges,
  diffRowPriority,
  diffTokenSets,
  githubContentChanged,
  hasAnyEntries,
  invertAuditChanges,
  preferLiveFigmaExtensions,
  resolveForFigmaApply,
  type AuditEntry,
} from './sync-logic';

function colorToken(value: string, extensions?: DesignToken<string>['$extensions']): DesignToken<string> {
  return { $type: 'color', $value: { kind: 'value', value }, ...(extensions ? { $extensions: extensions } : {}) };
}

function refToken(refKey: string, extensions?: DesignToken<string>['$extensions']): DesignToken<string> {
  return { $type: 'color', $value: { kind: 'reference', refKey }, ...(extensions ? { $extensions: extensions } : {}) };
}

function setWithColors(entries: Record<string, DesignToken<unknown>>): TokenSet {
  const set = emptyTokenSet();
  set.color = entries as TokenSet['color'];
  return set;
}

function valueOf(token: DesignToken<unknown>): unknown {
  assert.equal(token.$value.kind, 'value', 'expected a concrete value, not a reference');
  return (token.$value as { kind: 'value'; value: unknown }).value;
}

// ---------------------------------------------------------------------------
// diffTokenSets
// ---------------------------------------------------------------------------

test('diffTokenSets: identical values on both sides are unchanged', () => {
  const figma = setWithColors({ a: colorToken('#ffffff') });
  const github = setWithColors({ a: colorToken('#ffffff') });
  const diff = diffTokenSets(figma, github);
  const entry = diff.find((d) => d.key === 'a');
  assert.equal(entry?.status, 'unchanged');
});

test('diffTokenSets: differing raw value on both sides is a real conflict, not cascadeOnly', () => {
  const figma = setWithColors({ a: colorToken('#ffffff') });
  const github = setWithColors({ a: colorToken('#ff77ff') });
  const diff = diffTokenSets(figma, github);
  const entry = diff.find((d) => d.key === 'a');
  assert.equal(entry?.status, 'modified');
  assert.equal(entry?.cascadeOnly, false);
});

test('diffTokenSets: a reference whose target changed elsewhere is cascadeOnly', () => {
  // badge-bg references yellow-5 on both sides — its own raw $value is
  // identical — but yellow-5 itself differs, so badge-bg's *resolved*
  // value differs too. This is exactly the case reported against v1.4.1:
  // editing one primitive produced extra "Conflict" rows for every
  // reference that points at it.
  const figma = setWithColors({
    'yellow-5': colorToken('#fffff5'),
    'badge-bg': refToken('color/yellow-5'),
  });
  const github = setWithColors({
    'yellow-5': colorToken('#ff77ff'),
    'badge-bg': refToken('color/yellow-5'),
  });
  const diff = diffTokenSets(figma, github);
  const primitive = diff.find((d) => d.key === 'yellow-5');
  const cascaded = diff.find((d) => d.key === 'badge-bg');
  assert.equal(primitive?.status, 'modified');
  assert.equal(primitive?.cascadeOnly, false);
  assert.equal(cascaded?.status, 'modified');
  assert.equal(cascaded?.cascadeOnly, true);
});

test('diffTokenSets: added-figma / added-github for keys on only one side', () => {
  const figma = setWithColors({ onlyFigma: colorToken('#000000') });
  const github = setWithColors({ onlyGithub: colorToken('#000000') });
  const diff = diffTokenSets(figma, github);
  assert.equal(diff.find((d) => d.key === 'onlyFigma')?.status, 'added-figma');
  assert.equal(diff.find((d) => d.key === 'onlyGithub')?.status, 'added-github');
});

// ---------------------------------------------------------------------------
// buildSyncPlan
// ---------------------------------------------------------------------------

test('buildSyncPlan: cascadeOnly-style unchanged-raw key needs no resolution to merge', () => {
  const figma = setWithColors({ a: refToken('color/x') });
  const github = setWithColors({ a: refToken('color/x') });
  const { final, figmaApply } = buildSyncPlan(figma, github, {});
  assert.deepEqual(final.color.a, refToken('color/x'));
  assert.equal(figmaApply.color.a, undefined, 'no resolution needed, so nothing should be queued to write to Figma');
});

test('buildSyncPlan: "github" resolution wins and queues a Figma write', () => {
  const figma = setWithColors({ a: colorToken('#111111') });
  const github = setWithColors({ a: colorToken('#222222') });
  const { final, figmaApply } = buildSyncPlan(figma, github, { 'color:a': 'github' });
  assert.equal(valueOf(final.color.a), '#222222');
  assert.ok(figmaApply.color.a, 'Use GitHub should queue a Figma write');
});

test('buildSyncPlan: "figma" resolution wins and does NOT queue a Figma write (nothing to write back)', () => {
  const figma = setWithColors({ a: colorToken('#111111') });
  const github = setWithColors({ a: colorToken('#222222') });
  const { final, figmaApply } = buildSyncPlan(figma, github, { 'color:a': 'figma' });
  assert.equal(valueOf(final.color.a), '#111111');
  assert.equal(figmaApply.color.a, undefined);
});

test('buildSyncPlan: "skip" keeps GitHub\'s stored value, unresolved', () => {
  const figma = setWithColors({ a: colorToken('#111111') });
  const github = setWithColors({ a: colorToken('#222222') });
  const { final, figmaApply } = buildSyncPlan(figma, github, { 'color:a': 'skip' });
  assert.equal(valueOf(final.color.a), '#222222');
  assert.equal(figmaApply.color.a, undefined);
});

test('buildSyncPlan: figmaApply only ever contains a delta, never the full merged set', () => {
  // Guards against the v1.4.0 bug where runSync overwrote figmaApply's
  // delta for dimension/string/boolean with the entire merged set.
  const figma = setWithColors({ changed: colorToken('#111111'), untouched: colorToken('#abcabc') });
  const github = setWithColors({ changed: colorToken('#222222'), untouched: colorToken('#abcabc') });
  const { figmaApply } = buildSyncPlan(figma, github, { 'color:changed': 'github' });
  assert.ok(figmaApply.color.changed);
  assert.equal(figmaApply.color.untouched, undefined, 'an unchanged key must never appear in the delta');
});

// ---------------------------------------------------------------------------
// githubContentChanged
// ---------------------------------------------------------------------------

test('githubContentChanged: false when the merged result matches GitHub exactly', () => {
  const github = setWithColors({ a: colorToken('#111111') });
  const final = setWithColors({ a: colorToken('#111111') });
  assert.equal(githubContentChanged(final, github), false);
});

test('githubContentChanged: true when any key differs', () => {
  const github = setWithColors({ a: colorToken('#111111') });
  const final = setWithColors({ a: colorToken('#222222') });
  assert.equal(githubContentChanged(final, github), true);
});

test('githubContentChanged: false for the all-cascade-rows case (the empty-PR bug)', () => {
  // Reproduces the v1.4.2/1.4.3 case: every "conflict" was a reference
  // cascade, buildSyncPlan produces a final set identical to GitHub's, and
  // Sync must not open a PR for it.
  const figma = setWithColors({ 'yellow-5': colorToken('#fffff5'), 'badge-bg': refToken('color/yellow-5') });
  const github = setWithColors({ 'yellow-5': colorToken('#fffff5'), 'badge-bg': refToken('color/yellow-5') });
  const { final } = buildSyncPlan(figma, github, {});
  assert.equal(githubContentChanged(final, github), false);
});

// ---------------------------------------------------------------------------
// preferLiveFigmaExtensions
// ---------------------------------------------------------------------------

test('preferLiveFigmaExtensions: replaces stale/missing $extensions with Figma\'s current ones', () => {
  const figmaApply = setWithColors({
    a: colorToken('#222222', { 'design-sync.figmaSourceType': 'style' }), // GitHub's stale copy, e.g. no modeId
  });
  const figmaTokens = setWithColors({
    a: colorToken('#111111', {
      'design-sync.figmaSourceType': 'variable',
      'design-sync.variableId': 'VariableID:1:1',
      'design-sync.modeId': '1:0',
    }),
  });
  preferLiveFigmaExtensions(figmaApply, figmaTokens);
  assert.deepEqual(figmaApply.color.a.$extensions, {
    'design-sync.figmaSourceType': 'variable',
    'design-sync.variableId': 'VariableID:1:1',
    'design-sync.modeId': '1:0',
  });
  // The value being written (GitHub's #222222) must be untouched — only
  // $extensions (which variable/mode to write to) comes from Figma's side.
  assert.equal(valueOf(figmaApply.color.a), '#222222');
});

test('preferLiveFigmaExtensions: leaves a key alone if Figma has no live variable for it', () => {
  const figmaApply = setWithColors({ a: colorToken('#222222', { 'design-sync.figmaSourceType': 'style' }) });
  const figmaTokens = setWithColors({}); // key doesn't exist in Figma at all
  preferLiveFigmaExtensions(figmaApply, figmaTokens);
  assert.deepEqual(figmaApply.color.a.$extensions, { 'design-sync.figmaSourceType': 'style' });
});

// ---------------------------------------------------------------------------
// resolveForFigmaApply
// ---------------------------------------------------------------------------

test('resolveForFigmaApply: resolves a reference against the full context', () => {
  const figmaApply = setWithColors({ badge: refToken('color/primitive') });
  const context = setWithColors({ primitive: colorToken('#abcdef'), badge: refToken('color/primitive') });
  const resolved = resolveForFigmaApply(figmaApply, context);
  assert.equal(valueOf(resolved.color.badge), '#abcdef');
});

test('resolveForFigmaApply: a broken reference is skipped, not thrown', () => {
  const figmaApply = setWithColors({ badge: refToken('color/does-not-exist') });
  const context = setWithColors({ badge: refToken('color/does-not-exist') });
  const resolved = resolveForFigmaApply(figmaApply, context);
  assert.equal(resolved.color.badge, undefined);
});

// ---------------------------------------------------------------------------
// diffRowPriority
// ---------------------------------------------------------------------------

test('diffRowPriority: real conflicts sort before added rows, which sort before cascades', () => {
  const conflict = { status: 'modified', cascadeOnly: false } as const;
  const added = { status: 'added-figma', cascadeOnly: false } as const;
  const cascade = { status: 'modified', cascadeOnly: true } as const;
  const rows = [cascade, added, conflict];
  const sorted = [...rows].sort((a, b) => diffRowPriority(a as never) - diffRowPriority(b as never));
  assert.deepEqual(sorted, [conflict, added, cascade]);
});

// ---------------------------------------------------------------------------
// computeAuditChanges / canRevertEntry / invertAuditChanges
// ---------------------------------------------------------------------------

test('computeAuditChanges: records a modified key with before/after values and its resolution', () => {
  const github = setWithColors({ a: colorToken('#111111') });
  const final = setWithColors({ a: colorToken('#222222') });
  const changes = computeAuditChanges(final, github, { 'color:a': 'github' });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, 'modified');
  assert.equal(changes[0].previousValue && valueOf(changes[0].previousValue as DesignToken<unknown>), '#111111');
  assert.equal(changes[0].newValue && valueOf(changes[0].newValue as DesignToken<unknown>), '#222222');
  assert.equal(changes[0].resolution, 'github');
});

test('computeAuditChanges: a key with no actual difference produces no entry (mirrors githubContentChanged)', () => {
  const github = setWithColors({ a: colorToken('#111111') });
  const final = setWithColors({ a: colorToken('#111111') });
  assert.deepEqual(computeAuditChanges(final, github, {}), []);
});

test('computeAuditChanges: a key added on GitHub-only side is classified "added" with no previousValue', () => {
  const github = setWithColors({});
  const final = setWithColors({ a: colorToken('#111111') });
  const changes = computeAuditChanges(final, github, {});
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, 'added');
  assert.equal(changes[0].previousValue, undefined);
});

test('computeAuditChanges: cascade-only cases (see 1.4.2) never appear — buildSyncPlan never changes them', () => {
  // A reference whose target changed elsewhere never differs from GitHub's
  // raw stored value at the key itself, so buildSyncPlan's final matches
  // GitHub exactly for that key — computeAuditChanges must agree, or the
  // audit trail would record phantom changes for rows the Sync tab already
  // shows as "nothing to decide."
  const figma = setWithColors({ 'yellow-5': colorToken('#fffff5'), 'badge-bg': refToken('color/yellow-5') });
  const github = setWithColors({ 'yellow-5': colorToken('#fffff5'), 'badge-bg': refToken('color/yellow-5') });
  const { final } = buildSyncPlan(figma, github, {});
  assert.deepEqual(computeAuditChanges(final, github, {}), []);
});

function makeEntry(changes: ReturnType<typeof computeAuditChanges>): AuditEntry {
  return { timestamp: '2026-08-04T00:00:00.000Z', actor: 'tester', prNumber: 1, prUrl: 'https://example.com/pr/1', branch: 'design-sync/x', changes };
}

test('canRevertEntry: true when every change is "modified"', () => {
  const github = setWithColors({ a: colorToken('#111111') });
  const final = setWithColors({ a: colorToken('#222222') });
  const entry = makeEntry(computeAuditChanges(final, github, {}));
  assert.equal(canRevertEntry(entry), true);
});

test('canRevertEntry: false when any change is "added" (no well-defined inverse today)', () => {
  const github = setWithColors({});
  const final = setWithColors({ a: colorToken('#111111') });
  const entry = makeEntry(computeAuditChanges(final, github, {}));
  assert.equal(canRevertEntry(entry), false);
});

test('canRevertEntry: false for an entry with zero changes', () => {
  assert.equal(canRevertEntry(makeEntry([])), false);
});

test('invertAuditChanges: swaps previous/new value and clears resolution', () => {
  const github = setWithColors({ a: colorToken('#111111') });
  const final = setWithColors({ a: colorToken('#222222') });
  const changes = computeAuditChanges(final, github, { 'color:a': 'github' });
  const inverse = invertAuditChanges(changes);
  assert.equal(inverse[0].changeType, 'modified');
  assert.equal(valueOf(inverse[0].previousValue as DesignToken<unknown>), '#222222');
  assert.equal(valueOf(inverse[0].newValue as DesignToken<unknown>), '#111111');
  assert.equal(inverse[0].resolution, null);
});

// ---------------------------------------------------------------------------
// hasAnyEntries
// ---------------------------------------------------------------------------

test('hasAnyEntries: false for a completely empty TokenSet', () => {
  assert.equal(hasAnyEntries(emptyTokenSet()), false);
});

test('hasAnyEntries: true when any single category has an entry', () => {
  assert.equal(hasAnyEntries(setWithColors({ a: colorToken('#111111') })), true);
});

test('hasAnyEntries: reflects the real "GitHub already matched, only Figma needs updating" case', () => {
  // A token edited directly on GitHub, resolved as "Use GitHub" (the only
  // way it reaches figmaApply): buildSyncPlan sets final to GitHub's own
  // value, which already equals what's on GitHub — githubContentChanged is
  // false (nothing to commit) — but figmaApply still has the entry, since
  // Figma genuinely needs it. hasAnyEntries(figmaApply) must be true so
  // this sync still gets recorded, even though nothing needs to change on
  // GitHub's side.
  const figma = setWithColors({ a: colorToken('#111111') });
  const github = setWithColors({ a: colorToken('#222222') });
  const { final, figmaApply } = buildSyncPlan(figma, github, { 'color:a': 'github' });
  assert.equal(githubContentChanged(final, github), false);
  assert.equal(hasAnyEntries(figmaApply), true);
});
