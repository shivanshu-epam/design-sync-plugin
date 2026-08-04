// Design Sync — plugin UI thread.
//
// Owns all GitHub network access (the Figma sandbox in code.ts has none),
// the diff/conflict-resolution engine, and every panel's DOM. Talks to
// code.ts purely via postMessage.

import type {
  DesignToken,
  GithubSettings,
  PluginToUIMessage,
  StorybookSyncMarker,
  SyncHistoryEntry,
  TokenCategory,
  TokenSet,
  TokenValidationError,
  UIToPluginMessage,
} from './shared/tokens';
import { emptyTokenSet, normalizeLegacyBucket, TOKEN_CATEGORIES, validateTokenSet } from './shared/tokens';
import type { AuditChange, AuditEntry, DiffEntry, Resolution } from './sync-logic';
import {
  buildSyncPlan,
  canRevertEntry,
  computeAuditChanges,
  diffRowPriority,
  diffTokenSets,
  githubContentChanged,
  invertAuditChanges,
  isReferenceToken,
  preferLiveFigmaExtensions,
  resolveForFigmaApply,
} from './sync-logic';

// ---------------------------------------------------------------------------
// Messaging with code.ts
// ---------------------------------------------------------------------------

function postToPlugin(msg: UIToPluginMessage) {
  parent.postMessage({ pluginMessage: msg }, '*');
}

function isConfigured(settings: GithubSettings | null): settings is GithubSettings {
  return !!settings && !!settings.owner && !!settings.repo && !!settings.token;
}

let figmaTokensResolver: ((tokens: TokenSet) => void) | null = null;
let figmaTokensRejecter: ((err: Error) => void) | null = null;
let applyResultResolver: ((result: { success: boolean; error?: string; diagnostics?: string[] }) => void) | null = null;

function requestFigmaTokens(): Promise<TokenSet> {
  return new Promise((resolve, reject) => {
    figmaTokensResolver = resolve;
    figmaTokensRejecter = reject;
    postToPlugin({ type: 'request-figma-tokens' });
  });
}

function applyTokensToFigma(tokens: TokenSet): Promise<{ success: boolean; error?: string; diagnostics?: string[] }> {
  return new Promise((resolve) => {
    applyResultResolver = resolve;
    postToPlugin({ type: 'apply-tokens', tokens });
  });
}

window.onmessage = (event: MessageEvent) => {
  const msg = event.data.pluginMessage as PluginToUIMessage | undefined;
  if (!msg) return;
  switch (msg.type) {
    case 'init':
      state.settings = msg.settings;
      state.history = msg.history;
      if (isConfigured(state.settings)) {
        // Already connected — jump straight to the diff instead of making
        // the user click "Fetch & compare" every time they open the plugin.
        state.activeTab = 'sync';
        render();
        runCompare();
      } else {
        // Not connected yet — ask for the GitHub repo first.
        state.activeTab = 'connect';
        requestFigmaTokens()
          .then((tokens) => {
            state.figmaTokens = tokens;
            render();
          })
          .catch((err) => {
            state.syncError = err instanceof Error ? err.message : String(err);
            appendLog(`Error reading Figma styles/variables: ${state.syncError}`);
            render();
          });
        render();
      }
      break;
    case 'figma-tokens':
      state.figmaTokens = msg.tokens;
      if (figmaTokensResolver) {
        figmaTokensResolver(msg.tokens);
        figmaTokensResolver = null;
        figmaTokensRejecter = null;
      }
      break;
    case 'figma-tokens-error':
      if (figmaTokensRejecter) {
        figmaTokensRejecter(new Error(msg.error));
        figmaTokensResolver = null;
        figmaTokensRejecter = null;
      }
      break;
    case 'apply-tokens-result':
      if (applyResultResolver) {
        applyResultResolver(msg);
        applyResultResolver = null;
      }
      break;
  }
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type Tab = 'connect' | 'tokens' | 'sync' | 'status' | 'history';
type StorybookStatus = 'unknown' | 'in-sync' | 'stale' | 'never-built' | 'error';

interface SourcedValidationError extends TokenValidationError {
  source: 'figma' | 'github';
}

const state: {
  activeTab: Tab;
  settings: GithubSettings | null;
  history: SyncHistoryEntry[];
  figmaTokens: TokenSet;
  githubTokens: TokenSet;
  githubSha: string | null;
  diff: DiffEntry[];
  validationErrors: SourcedValidationError[];
  resolutions: Record<string, Resolution>;
  log: string[];
  connectStatus: { ok: boolean; message: string } | null;
  comparing: boolean;
  syncing: boolean;
  syncError: string | null;
  storybookMarker: StorybookSyncMarker | null;
  storybookStatus: StorybookStatus;
  storybookError: string | null;
  storybookDeploying: boolean;
  storybookDeployMessage: string | null;
  storybookDeployError: string | null;
  localStorybookReachable: boolean | null;
  checkingLocalStorybook: boolean;
  pendingPr: { number: number; url: string; state: 'open' | 'closed' } | null;
  availableRepos: RepoOption[];
  loadingRepos: boolean;
  reposError: string | null;
  auditLog: AuditEntry[];
  auditLogLoading: boolean;
  auditLogError: string | null;
  // Distinguishes "never clicked Load history yet" from "loaded, and there
  // are genuinely zero entries" — both look like an empty auditLog array,
  // but they need different empty-state copy.
  auditLogLoaded: boolean;
  // Timestamp (AuditEntry.timestamp) of the entry currently being reverted,
  // or null — a string id rather than a boolean since only one revert can
  // run at a time but the UI needs to know WHICH row's button to disable.
  reverting: string | null;
  notifyTestSending: boolean;
  notifyTestMessage: string | null;
  notifyTestError: string | null;
} = {
  activeTab: 'connect',
  settings: null,
  history: [],
  figmaTokens: emptyTokenSet(),
  githubTokens: emptyTokenSet(),
  githubSha: null,
  diff: [],
  validationErrors: [],
  resolutions: {},
  log: [],
  connectStatus: null,
  comparing: false,
  syncing: false,
  syncError: null,
  storybookMarker: null,
  storybookStatus: 'unknown',
  storybookError: null,
  storybookDeploying: false,
  storybookDeployMessage: null,
  storybookDeployError: null,
  localStorybookReachable: null,
  checkingLocalStorybook: false,
  pendingPr: null,
  availableRepos: [],
  loadingRepos: false,
  reposError: null,
  auditLog: [],
  auditLogLoading: false,
  auditLogError: null,
  auditLogLoaded: false,
  reverting: null,
  notifyTestSending: false,
  notifyTestMessage: null,
  notifyTestError: null,
};

function appendLog(line: string) {
  const time = new Date().toLocaleTimeString();
  state.log.push(`[${time}] ${line}`);
  renderLog();
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

const GITHUB_API = 'https://api.github.com';

function githubRequestWithToken(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    // GitHub's Contents API responses are cacheable (ETag/Cache-Control),
    // and repeated GETs to the same URL — exactly what every re-compare
    // does — were letting the browser silently serve a stale cached
    // response instead of hitting GitHub for the real current content.
    // Every request here needs fresh data, always.
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
  });
}

async function githubRequest(path: string, settings: GithubSettings, init: RequestInit = {}): Promise<Response> {
  return githubRequestWithToken(path, settings.token, init);
}

function encodeContentPath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

function encodeBase64Utf8(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

// Triggers .github/workflows/deploy-storybook.yml in the tokens repo via
// workflow_dispatch. That workflow has no `on: push` trigger by design —
// rebuilding Storybook is a deliberate action the user takes after
// reviewing the diff here, not a side effect of every commit. The API
// returns 204 with no run id, so there's nothing to poll; the user checks
// progress in the repo's Actions tab and re-runs "Refresh status" once
// GitHub Pages has redeployed.
async function triggerStorybookDeploy(settings: GithubSettings): Promise<void> {
  const res = await githubRequest(
    `/repos/${settings.owner}/${settings.repo}/actions/workflows/deploy-storybook.yml/dispatches`,
    settings,
    { method: 'POST', body: JSON.stringify({ ref: settings.branch }) },
  );
  if (res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Triggering Storybook deploy failed: ${res.status} ${body.message ?? res.statusText}`);
  }
}

// Same dispatch pattern as triggerStorybookDeploy — this workflow must
// already exist in the tokens repo (scripts/notify-on-sync.mjs +
// .github/workflows/notify-on-sync.yml). No pre-check for that here,
// consistent with triggerStorybookDeploy: a missing workflow file just
// surfaces as a 404 from the dispatch call itself, which is clear enough.
async function triggerNotifyTest(settings: GithubSettings): Promise<void> {
  const res = await githubRequest(
    `/repos/${settings.owner}/${settings.repo}/actions/workflows/notify-on-sync.yml/dispatches`,
    settings,
    { method: 'POST', body: JSON.stringify({ ref: settings.branch }) },
  );
  if (res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Sending test notification failed: ${res.status} ${body.message ?? res.statusText}`);
  }
}

interface RepoOption {
  fullName: string; // "owner/repo"
  owner: string;
  name: string;
  defaultBranch: string;
}

// GET /user/repos — every repo the token can see, not filtered by owner,
// since a fine-grained PAT is typically scoped to just one or two repos
// anyway (that's the whole point of "fine-grained"). Paginated, capped at
// 500 repos (5 pages) — plenty for an individual account, and avoids an
// unbounded fetch loop against an org PAT with broad access.
async function fetchUserRepos(token: string): Promise<RepoOption[]> {
  const repos: RepoOption[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await githubRequestWithToken(`/user/repos?per_page=100&page=${page}&sort=full_name`, token);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`Listing repositories failed: ${res.status} ${body.message ?? res.statusText}`);
    }
    const body = await res.json();
    for (const r of body) {
      repos.push({ fullName: r.full_name, owner: r.owner.login, name: r.name, defaultBranch: r.default_branch });
    }
    if (body.length < 100) break;
  }
  return repos;
}

async function testConnection(settings: GithubSettings): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await githubRequest(`/repos/${settings.owner}/${settings.repo}`, settings);
    if (res.ok) {
      const body = await res.json();
      return { ok: true, message: `Connected to ${body.full_name}` };
    }
    const body = await res.json().catch(() => ({}));
    return { ok: false, message: `${res.status} ${body.message ?? res.statusText}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function fetchGithubTokens(settings: GithubSettings): Promise<{ tokens: TokenSet; sha: string | null }> {
  const contentsUrl = `/repos/${settings.owner}/${settings.repo}/contents/${encodeContentPath(settings.path)}?ref=${encodeURIComponent(settings.branch)}`;

  const metaRes = await githubRequest(contentsUrl, settings);
  if (metaRes.status === 404) {
    return { tokens: emptyTokenSet(), sha: null };
  }
  if (!metaRes.ok) {
    const body = await metaRes.json().catch(() => ({}));
    throw new Error(`Reading ${settings.path} failed: ${metaRes.status} ${body.message ?? metaRes.statusText}`);
  }
  const meta = await metaRes.json();
  const sha = meta.sha as string;

  // The Contents API only inlines base64 `content` for files under 1MB —
  // above that it comes back empty, which made JSON.parse throw "Unexpected
  // end of JSON input" once the token set grew past ~1.5MB. The `.raw`
  // media type has no such limit; fetch the actual bytes that way instead.
  const rawRes = await githubRequest(contentsUrl, settings, {
    headers: { Accept: 'application/vnd.github.raw+json' },
  });
  if (!rawRes.ok) {
    throw new Error(`Reading ${settings.path} contents failed: ${rawRes.status} ${rawRes.statusText}`);
  }
  const parsed = JSON.parse(await rawRes.text()) as Partial<Record<TokenCategory, Record<string, unknown>>>;
  return {
    tokens: {
      color: normalizeLegacyBucket(parsed.color, 'color') as Record<string, DesignToken<string>>,
      typography: normalizeLegacyBucket(parsed.typography, 'typography') as TokenSet['typography'],
      shadow: normalizeLegacyBucket(parsed.shadow, 'shadow') as TokenSet['shadow'],
      dimension: normalizeLegacyBucket(parsed.dimension, 'dimension') as TokenSet['dimension'],
      string: normalizeLegacyBucket(parsed.string, 'string') as TokenSet['string'],
      boolean: normalizeLegacyBucket(parsed.boolean, 'boolean') as TokenSet['boolean'],
    },
    sha,
  };
}

// .storybook-sync.json is always looked up at the repo root, regardless of
// where the token file itself lives — it's written by
// scripts/record-sync-marker.mjs (the build-storybook postbuild hook) in
// the tokens repo.
async function fetchStorybookMarker(settings: GithubSettings): Promise<StorybookSyncMarker | null> {
  const res = await githubRequest(
    `/repos/${settings.owner}/${settings.repo}/contents/.storybook-sync.json?ref=${encodeURIComponent(settings.branch)}`,
    settings,
  );
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Reading .storybook-sync.json failed: ${res.status} ${body.message ?? res.statusText}`);
  }
  const body = await res.json();
  return JSON.parse(decodeBase64Utf8(body.content)) as StorybookSyncMarker;
}

// ---------------------------------------------------------------------------
// Audit trail (Phase 5) — .design-sync/audit-log.jsonl in the tokens repo,
// one JSON line per sync event. Committed to the tokens repo (not
// figma.clientStorage) because it's inherently team-shared, same reasoning
// as design-tokens.json itself.
// ---------------------------------------------------------------------------

const AUDIT_LOG_PATH = '.design-sync/audit-log.jsonl';

// Best-effort — a failed username lookup shouldn't block a sync. 'unknown'
// is a valid, honest value for an audit entry rather than a reason to fail.
async function fetchGithubUsername(settings: GithubSettings): Promise<string> {
  try {
    const res = await githubRequest('/user', settings);
    if (!res.ok) return 'unknown';
    const body = await res.json();
    return typeof body.login === 'string' ? body.login : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function fetchAuditLogRaw(settings: GithubSettings, ref: string): Promise<{ text: string; sha: string | null }> {
  const url = `/repos/${settings.owner}/${settings.repo}/contents/${AUDIT_LOG_PATH}?ref=${encodeURIComponent(ref)}`;
  const metaRes = await githubRequest(url, settings);
  if (metaRes.status === 404) return { text: '', sha: null };
  if (!metaRes.ok) {
    const body = await metaRes.json().catch(() => ({}));
    throw new Error(`Reading audit log failed: ${metaRes.status} ${body.message ?? metaRes.statusText}`);
  }
  const meta = await metaRes.json();
  const sha = meta.sha as string;
  // Same 1MB-inline-content concern as design-tokens.json itself — this log
  // only ever grows, so it will eventually cross that threshold too.
  const rawRes = await githubRequest(url, settings, { headers: { Accept: 'application/vnd.github.raw+json' } });
  if (!rawRes.ok) throw new Error(`Reading audit log contents failed: ${rawRes.status} ${rawRes.statusText}`);
  return { text: await rawRes.text(), sha };
}

function parseAuditLog(text: string): AuditEntry[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditEntry)
    .reverse(); // newest first
}

// Appends without parsing the existing lines — a malformed old line (hand
// edited, or from a future plugin version with a different shape) must
// never block appending a new one; this file's job is to always accept a
// new line, not to validate history it didn't write.
async function appendAuditLogEntry(settings: GithubSettings, branch: string, entry: AuditEntry): Promise<void> {
  const { text, sha } = await fetchAuditLogRaw(settings, branch);
  const withTrailingNewline = text.length > 0 && !text.endsWith('\n') ? `${text}\n` : text;
  const payload: Record<string, unknown> = {
    message: `Design Sync: record audit entry for PR #${entry.prNumber}`,
    content: encodeBase64Utf8(`${withTrailingNewline}${JSON.stringify(entry)}\n`),
    branch,
  };
  if (sha) payload.sha = sha;
  const res = await githubRequest(`/repos/${settings.owner}/${settings.repo}/contents/${AUDIT_LOG_PATH}`, settings, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Recording audit entry failed: ${res.status} ${body.message ?? res.statusText}`);
  }
}

async function commitGithubTokens(
  settings: GithubSettings,
  tokens: TokenSet,
  sha: string | null,
  branch: string,
): Promise<{ sha: string; url: string }> {
  const payload: Record<string, unknown> = {
    message: 'Design Sync: update design tokens',
    content: encodeBase64Utf8(JSON.stringify(tokens, null, 2) + '\n'),
    branch,
  };
  if (sha) payload.sha = sha;
  const res = await githubRequest(
    `/repos/${settings.owner}/${settings.repo}/contents/${encodeContentPath(settings.path)}`,
    settings,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Commit failed: ${res.status} ${body.message ?? res.statusText}`);
  }
  const body = await res.json();
  return { sha: body.content.sha as string, url: body.commit.html_url as string };
}

// ---------------------------------------------------------------------------
// PR-based review gate (Phase 3) — Sync opens a PR against settings.branch
// instead of committing to it directly, so nothing lands on the branch
// consumed by Storybook/downstream builds without a review step.
// ---------------------------------------------------------------------------

async function getBranchHeadSha(settings: GithubSettings, branch: string): Promise<string> {
  const res = await githubRequest(
    `/repos/${settings.owner}/${settings.repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    settings,
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Reading ${branch}'s current commit failed: ${res.status} ${body.message ?? res.statusText}`);
  }
  const body = await res.json();
  return body.object.sha as string;
}

async function createBranch(settings: GithubSettings, branch: string, fromSha: string): Promise<void> {
  const res = await githubRequest(`/repos/${settings.owner}/${settings.repo}/git/refs`, settings, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromSha }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Creating branch ${branch} failed: ${res.status} ${body.message ?? res.statusText}`);
  }
}

async function deleteBranch(settings: GithubSettings, branch: string): Promise<void> {
  await githubRequest(
    `/repos/${settings.owner}/${settings.repo}/git/refs/heads/${encodeURIComponent(branch)}`,
    settings,
    { method: 'DELETE' },
  );
  // Best-effort cleanup only — if this itself fails (e.g. the token also
  // lacks delete access), the caller's real error is what the user needs
  // to see, not this one, so failures here are swallowed by the caller.
}

async function createPullRequest(
  settings: GithubSettings,
  head: string,
  title: string,
  body: string,
): Promise<{ number: number; url: string }> {
  const res = await githubRequest(`/repos/${settings.owner}/${settings.repo}/pulls`, settings, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, head, base: settings.branch, body }),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(`Opening pull request failed: ${res.status} ${errBody.message ?? res.statusText}`);
  }
  const prBody = await res.json();
  return { number: prBody.number as number, url: prBody.html_url as string };
}

async function fetchPrStatus(settings: GithubSettings, number: number): Promise<{ state: 'open' | 'closed'; merged: boolean }> {
  const res = await githubRequest(`/repos/${settings.owner}/${settings.repo}/pulls/${number}`, settings);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Reading pull request #${number} failed: ${res.status} ${body.message ?? res.statusText}`);
  }
  const body = await res.json();
  return { state: body.state as 'open' | 'closed', merged: !!body.merged };
}

// Diff + sync plan logic (isReferenceToken, diffTokenSets, buildSyncPlan,
// preferLiveFigmaExtensions, resolveForFigmaApply, diffRowPriority,
// githubContentChanged) lives in sync-logic.ts — pure functions over
// TokenSet data, extracted so they're testable with node:test without a
// Figma runtime or a DOM. See sync-logic.test.ts.

// Storybook's default dev-server port (`storybook dev -p 6006` in the
// tokens repo's package.json). A plugin can't spawn that server itself —
// neither execution context has shell access — so the best it can do is
// check whether something is already listening there before opening a
// tab, rather than blindly opening a tab that 404s.
const LOCAL_STORYBOOK_URL = 'http://localhost:6006';

// `no-cors` mode is required here: Storybook's dev server sends no
// Access-Control-Allow-Origin header, so a normal `cors`-mode fetch would
// reject with the exact same "Failed to fetch" TypeError whether the port
// is closed or the server is just running without CORS headers — making
// the two cases indistinguishable. `no-cors` resolves to an opaque
// response as long as *something* answers the TCP connection, which is
// all we need to know.
async function checkLocalStorybook(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    await fetch(LOCAL_STORYBOOK_URL, { mode: 'no-cors', cache: 'no-store', signal: controller.signal });
    clearTimeout(timeout);
    return true;
  } catch {
    return false;
  }
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Figma's plugin UI iframe doesn't always grant the async Clipboard
    // API permission; a synchronous execCommand from the same click
    // handler works even when the promise-based API is denied.
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  }
}

function computeStorybookStatus() {
  if (state.storybookError) {
    state.storybookStatus = 'error';
  } else if (!state.storybookMarker) {
    state.storybookStatus = 'never-built';
  } else if (state.githubSha && state.storybookMarker.tokensBlobSha === state.githubSha) {
    state.storybookStatus = 'in-sync';
  } else {
    state.storybookStatus = 'stale';
  }
}

function unresolvedConflictCount(): number {
  return state.diff.filter((d) => d.status === 'modified' && !d.cascadeOnly && !state.resolutions[`${d.category}:${d.key}`]).length;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) {
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function diffValueLine(label: 'Figma' | 'GitHub', display: string, isRef: boolean): HTMLElement {
  const children: (Node | string)[] = [
    el('span', { className: `diff-value-label ${label.toLowerCase()}` }, [label]),
    el('span', { className: 'diff-value-text' }, [display]),
  ];
  if (isRef) children.push(el('span', { className: 'diff-badge' }, ['REF']));
  return el('div', { className: 'diff-value-line' }, children);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const panel = () => document.getElementById('panel') as HTMLElement;
const logPre = () => document.getElementById('log') as HTMLPreElement | null;

function renderLog() {
  const pre = logPre();
  if (pre) pre.textContent = state.log.join('\n');
}

function render() {
  document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === state.activeTab);
  });
  const root = panel();
  root.innerHTML = '';
  if (state.activeTab === 'connect') root.appendChild(renderConnectTab());
  if (state.activeTab === 'tokens') root.appendChild(renderTokensTab());
  if (state.activeTab === 'sync') root.appendChild(renderSyncTab());
  if (state.activeTab === 'status') root.appendChild(renderStatusTab());
  if (state.activeTab === 'history') root.appendChild(renderHistoryTab());
}

function renderConnectTab(): HTMLElement {
  const container = el('div');
  container.appendChild(el('h2', {}, ['GitHub Repository']));

  if (state.connectStatus) {
    container.appendChild(
      el(
        'div',
        { className: `status-banner ${state.connectStatus.ok ? 'success' : 'error'}` },
        [state.connectStatus.message],
      ),
    );
  }

  const s = state.settings ?? { owner: '', repo: '', branch: 'main', path: 'design-tokens.json', token: '' };

  const ownerInput = el('input', { type: 'text', placeholder: 'octocat', value: s.owner });
  const repoInput = el('input', { type: 'text', placeholder: 'design-system', value: s.repo });
  const branchInput = el('input', { type: 'text', placeholder: 'main', value: s.branch });
  const pathInput = el('input', { type: 'text', placeholder: 'design-tokens.json', value: s.path });
  const tokenInput = el('input', { type: 'password', placeholder: 'ghp_...', value: s.token });

  const requiredLabel = (text: string) => el('label', {}, [text, el('span', { className: 'required-mark' }, ['*'])]);
  const row = (labelText: string, input: HTMLElement) =>
    el('div', { className: 'field' }, [el('label', {}, [labelText]), input]);
  const requiredRow = (labelText: string, input: HTMLElement) =>
    el('div', { className: 'field' }, [requiredLabel(labelText), input]);

  // --- 1. Token (required — nothing else in this tab works without it) ---
  container.appendChild(el('h2', {}, ['1. Personal access token']));
  container.appendChild(requiredRow('Fine-grained token, scoped to one repo', tokenInput));
  container.appendChild(
    el('p', { className: 'hint' }, [
      'Stored locally on this machine only (figma.clientStorage), never leaves it except to talk to api.github.com. ' +
        'Needs Contents: read/write, Pull requests: read/write (Sync opens a PR), and Actions: read/write ' +
        '(only for the Status tab\'s "Rebuild Storybook" button).',
    ]),
  );

  container.appendChild(el('hr', { className: 'section-divider' }));

  // --- 2. Repo picker (optional convenience — the fields below always
  // work by hand, this just saves typing owner/repo) ---
  container.appendChild(el('h2', {}, ['2. Find repository (optional)']));
  const datalistId = 'repo-options';
  const repoSearchInput = el('input', {
    type: 'text',
    placeholder: state.loadingRepos ? 'Loading…' : 'Type to search, or pick from the list',
  });
  // `list` is a read-only IDL property on HTMLInputElement (reflects the
  // associated <datalist>, doesn't set it) — must go through setAttribute,
  // not the usual el() prop-assignment path.
  repoSearchInput.setAttribute('list', datalistId);
  // .btn-row is a flex row with no stretch behavior of its own (unlike
  // .field's direct children, which stretch via flex-direction: column +
  // the default align-items: stretch) — without this the input would
  // shrink to its default ~20-character width next to the button.
  repoSearchInput.style.flex = '1';
  if (state.loadingRepos) repoSearchInput.setAttribute('disabled', 'true');
  const datalist = el('datalist', { id: datalistId });
  for (const repo of state.availableRepos) {
    datalist.appendChild(el('option', { value: repo.fullName }));
  }
  repoSearchInput.oninput = () => {
    const match = state.availableRepos.find((r) => r.fullName === repoSearchInput.value);
    if (match) {
      ownerInput.value = match.owner;
      repoInput.value = match.name;
      if (!branchInput.value.trim()) branchInput.value = match.defaultBranch;
    }
  };
  const loadReposBtn = el('button', {
    textContent: state.loadingRepos ? 'Loading…' : 'Load my repos',
    title: 'Fetch every repository the token above can see, via GET /user/repos',
  });
  if (state.loadingRepos) loadReposBtn.setAttribute('disabled', 'true');
  loadReposBtn.onclick = () => loadUserRepos(tokenInput.value.trim());
  container.appendChild(
    el('div', { className: 'field' }, [
      el('label', {}, ['Lists every repo the token above can see']),
      el('div', { className: 'btn-row' }, [repoSearchInput, loadReposBtn]),
    ]),
  );
  container.appendChild(datalist);
  if (state.reposError) {
    container.appendChild(el('div', { className: 'status-banner error' }, [state.reposError]));
  } else if (state.availableRepos.length > 0) {
    container.appendChild(
      el('p', { className: 'hint' }, [`${state.availableRepos.length} repositor${state.availableRepos.length === 1 ? 'y' : 'ies'} loaded — selecting one fills in the fields below.`]),
    );
  }

  container.appendChild(el('hr', { className: 'section-divider' }));

  // --- 3. Repository details (owner/name required; branch/path have
  // sensible defaults, shown as placeholders, so they're not marked
  // required even though something always ends up in them) ---
  container.appendChild(el('h2', {}, ['3. Repository details']));
  container.appendChild(requiredRow('Repository owner', ownerInput));
  container.appendChild(requiredRow('Repository name', repoInput));
  container.appendChild(el('div', { className: 'row' }, [row('Branch', branchInput), row('Token file path', pathInput)]));

  const readSettings = (): GithubSettings => ({
    owner: ownerInput.value.trim(),
    repo: repoInput.value.trim(),
    branch: branchInput.value.trim() || 'main',
    path: pathInput.value.trim() || 'design-tokens.json',
    token: tokenInput.value.trim(),
  });

  const saveBtn = el('button', { className: 'primary', textContent: 'Save' });
  saveBtn.onclick = () => {
    state.settings = readSettings();
    postToPlugin({ type: 'save-settings', settings: state.settings });
    state.connectStatus = { ok: true, message: 'Settings saved.' };
    if (isConfigured(state.settings)) {
      // Don't make them reopen the plugin to see the diff — jump straight
      // to Sync and run the comparison now that we have everything we need.
      state.activeTab = 'sync';
      render();
      runCompare();
    } else {
      render();
    }
  };

  const testBtn = el('button', { textContent: 'Test connection' });
  testBtn.onclick = async () => {
    testBtn.textContent = 'Testing…';
    testBtn.setAttribute('disabled', 'true');
    state.connectStatus = await testConnection(readSettings());
    testBtn.textContent = 'Test connection';
    testBtn.removeAttribute('disabled');
    render();
  };

  container.appendChild(el('div', { className: 'btn-row' }, [saveBtn, testBtn]));

  if (state.history.length > 0) {
    const historyHeading = el('h2', {}, ['Recent syncs']);
    historyHeading.style.marginTop = '18px';
    container.appendChild(historyHeading);
    for (const entry of state.history.slice(0, 5)) {
      const link = el('a', { href: entry.prUrl, target: '_blank', textContent: `PR #${entry.prNumber}` });
      container.appendChild(
        el('div', { className: 'history-item' }, [`${new Date(entry.timestamp).toLocaleString()} — `, link]),
      );
    }
  }

  if (isConfigured(state.settings)) {
    container.appendChild(el('hr', { className: 'section-divider' }));
    const notifyHeading = el('h2', {}, ['Notifications (optional)']);
    container.appendChild(notifyHeading);
    container.appendChild(renderNotificationsGuide());
  }

  return container;
}

// Shared editor for the two plain key/value custom-token categories
// (dimension and string differ only in placeholder text and $type).
function buildTextTokenEditor(
  category: 'dimension' | 'string',
  entries: [string, DesignToken<string>][],
  namePlaceholder: string,
  valuePlaceholder: string,
): { container: HTMLElement; collect: () => Record<string, DesignToken<string>> } {
  const table = el('table', { className: 'token-table' });
  table.appendChild(el('thead', {}, [el('tr', {}, [el('th', {}, ['Name']), el('th', {}, ['Value']), el('th', {}, [''])])]));
  const tbody = el('tbody');
  const rows: { nameInput: HTMLInputElement; valueInput: HTMLInputElement }[] = [];

  function addRow(name: string, value: string) {
    const nameInput = el('input', { type: 'text', value: name, placeholder: namePlaceholder });
    const valueInput = el('input', { type: 'text', value, placeholder: valuePlaceholder });
    const removeBtn = el('button', { className: 'icon-btn', textContent: '✕' });
    const tr = el('tr', {}, [el('td', {}, [nameInput]), el('td', {}, [valueInput]), el('td', {}, [removeBtn])]);
    removeBtn.onclick = () => {
      tr.remove();
      const idx = rows.findIndex((r) => r.nameInput === nameInput);
      if (idx >= 0) rows.splice(idx, 1);
    };
    tbody.appendChild(tr);
    rows.push({ nameInput, valueInput });
  }

  for (const [name, token] of entries) {
    if (token.$value.kind === 'value') addRow(name, token.$value.value);
  }
  table.appendChild(tbody);

  const addBtn = el('button', { textContent: '+ Add token' });
  addBtn.onclick = () => addRow('', '');

  const container = el('div', {}, [table, el('div', { className: 'btn-row' }, [addBtn])]);

  const collect = (): Record<string, DesignToken<string>> => {
    const out: Record<string, DesignToken<string>> = {};
    for (const { nameInput, valueInput } of rows) {
      const name = nameInput.value.trim();
      const value = valueInput.value.trim();
      if (!name || !value) continue;
      out[name] = { $type: category, $value: { kind: 'value', value } };
    }
    return out;
  };

  return { container, collect };
}

function buildBooleanTokenEditor(entries: [string, DesignToken<boolean>][]): {
  container: HTMLElement;
  collect: () => Record<string, DesignToken<boolean>>;
} {
  const table = el('table', { className: 'token-table' });
  table.appendChild(el('thead', {}, [el('tr', {}, [el('th', {}, ['Name']), el('th', {}, ['Value']), el('th', {}, [''])])]));
  const tbody = el('tbody');
  const rows: { nameInput: HTMLInputElement; valueInput: HTMLInputElement }[] = [];

  function addRow(name: string, value: boolean) {
    const nameInput = el('input', { type: 'text', value: name, placeholder: 'isDarkModeDefault' });
    const valueInput = el('input', { type: 'checkbox', checked: value });
    const removeBtn = el('button', { className: 'icon-btn', textContent: '✕' });
    const tr = el('tr', {}, [el('td', {}, [nameInput]), el('td', {}, [valueInput]), el('td', {}, [removeBtn])]);
    removeBtn.onclick = () => {
      tr.remove();
      const idx = rows.findIndex((r) => r.nameInput === nameInput);
      if (idx >= 0) rows.splice(idx, 1);
    };
    tbody.appendChild(tr);
    rows.push({ nameInput, valueInput });
  }

  for (const [name, token] of entries) {
    if (token.$value.kind === 'value') addRow(name, token.$value.value);
  }
  table.appendChild(tbody);

  const addBtn = el('button', { textContent: '+ Add token' });
  addBtn.onclick = () => addRow('', false);

  const container = el('div', {}, [table, el('div', { className: 'btn-row' }, [addBtn])]);

  const collect = (): Record<string, DesignToken<boolean>> => {
    const out: Record<string, DesignToken<boolean>> = {};
    for (const { nameInput, valueInput } of rows) {
      const name = nameInput.value.trim();
      if (!name) continue;
      out[name] = { $type: 'boolean', $value: { kind: 'value', value: valueInput.checked } };
    }
    return out;
  };

  return { container, collect };
}

function renderTokensTab(): HTMLElement {
  const container = el('div');
  container.appendChild(el('h2', {}, ['Custom tokens']));
  container.appendChild(
    el('p', { className: 'hint' }, [
      'Figma has no native style type for spacing/radius, arbitrary strings, or booleans without an Enterprise Variables plan, so these are tracked here and stored with the file.',
    ]),
  );

  const dimensionHeading = el('h2', {}, ['Dimension']);
  dimensionHeading.style.marginTop = '14px';
  container.appendChild(dimensionHeading);
  const dimensionEditor = buildTextTokenEditor(
    'dimension',
    Object.entries(state.figmaTokens.dimension),
    'spacing/sm',
    '8px',
  );
  container.appendChild(dimensionEditor.container);

  const stringHeading = el('h2', {}, ['String']);
  stringHeading.style.marginTop = '14px';
  container.appendChild(stringHeading);
  const stringEditor = buildTextTokenEditor(
    'string',
    Object.entries(state.figmaTokens.string),
    'font/primary-family',
    'Inter',
  );
  container.appendChild(stringEditor.container);

  const booleanHeading = el('h2', {}, ['Boolean']);
  booleanHeading.style.marginTop = '14px';
  container.appendChild(booleanHeading);
  const booleanEditor = buildBooleanTokenEditor(Object.entries(state.figmaTokens.boolean));
  container.appendChild(booleanEditor.container);

  const saveBtn = el('button', { className: 'primary', textContent: 'Save all' });
  saveBtn.onclick = () => {
    const dimension = dimensionEditor.collect();
    const string = stringEditor.collect();
    const boolean = booleanEditor.collect();
    state.figmaTokens.dimension = dimension;
    state.figmaTokens.string = string;
    state.figmaTokens.boolean = boolean;
    postToPlugin({ type: 'save-custom-tokens', dimension, string, boolean });
    appendLog(
      `Saved ${Object.keys(dimension).length} dimension, ${Object.keys(string).length} string, ${Object.keys(boolean).length} boolean custom token(s).`,
    );
  };
  const saveRow = el('div', { className: 'btn-row' }, [saveBtn]);
  saveRow.style.marginTop = '10px';
  container.appendChild(saveRow);

  return container;
}

function renderValidationErrors(): HTMLElement | null {
  if (state.validationErrors.length === 0) return null;
  const box = el('div', { className: 'status-banner error' });
  box.appendChild(
    el('div', {}, [
      `${state.validationErrors.length} token reference problem${state.validationErrors.length === 1 ? '' : 's'} — these specific tokens need a manual choice below, everything else will sync normally:`,
    ]),
  );
  const list = el('ul');
  for (const e of state.validationErrors.slice(0, 10)) {
    list.appendChild(el('li', {}, [`${e.source} · ${e.category}/${e.key} — ${e.message}`]));
  }
  box.appendChild(list);
  if (state.validationErrors.length > 10) {
    box.appendChild(el('div', {}, [`…and ${state.validationErrors.length - 10} more.`]));
  }
  return box;
}

function renderSyncTab(): HTMLElement {
  const container = el('div');

  if (!isConfigured(state.settings)) {
    container.appendChild(el('div', { className: 'empty-state' }, ['Set up your GitHub repository in the Connect tab first.']));
    return container;
  }

  const compareBtn = el('button', {
    className: 'primary',
    textContent: state.comparing ? 'Comparing…' : state.diff.length ? 'Re-fetch & compare' : 'Fetch & compare',
  });
  if (state.comparing) compareBtn.setAttribute('disabled', 'true');
  compareBtn.onclick = () => runCompare();
  container.appendChild(el('div', { className: 'btn-row' }, [compareBtn]));

  if (state.syncError) {
    container.appendChild(el('div', { className: 'status-banner error' }, [state.syncError]));
    const guide = renderPermissionErrorGuide(state.syncError);
    if (guide) container.appendChild(guide);
  }
  const validationBanner = renderValidationErrors();
  if (validationBanner) container.appendChild(validationBanner);

  if (state.comparing && state.diff.length === 0) {
    container.appendChild(el('div', { className: 'empty-state' }, ['Comparing Figma styles with GitHub…']));
  }

  if (state.diff.length > 0) {
    const changed = state.diff.filter((d) => d.status !== 'unchanged');
    if (changed.length === 0) {
      container.appendChild(el('div', { className: 'status-banner success' }, ['Figma and GitHub are already in sync.']));
    } else {
      const addedCount = changed.filter((d) => d.status !== 'modified').length;
      const conflictCount = changed.filter((d) => d.status === 'modified' && !d.cascadeOnly).length;

      if (addedCount > 0) {
        const selectRow = el('div', { className: 'btn-row' });
        const selectAll = el('button', { className: 'primary', textContent: `Select all (${addedCount} new)` });
        selectAll.onclick = () => {
          for (const d of changed) {
            if (d.status !== 'modified') delete state.resolutions[`${d.category}:${d.key}`];
          }
          render();
        };
        const selectNone = el('button', { textContent: 'Deselect all' });
        selectNone.onclick = () => {
          for (const d of changed) {
            if (d.status !== 'modified') state.resolutions[`${d.category}:${d.key}`] = 'skip';
          }
          render();
        };
        selectRow.append(selectAll, selectNone);
        container.appendChild(selectRow);
        container.appendChild(
          el('p', { className: 'hint' }, [
            'New tokens (from either side) are included by default — uncheck individual rows below, or use these to bulk-select.',
          ]),
        );
      }

      if (conflictCount > 0) {
        const bulkRow = el('div', { className: 'btn-row' });
        const useAllFigma = el('button', { textContent: 'Use all Figma (conflicts)' });
        useAllFigma.onclick = () => {
          for (const d of changed) if (d.status === 'modified' && !d.cascadeOnly) state.resolutions[`${d.category}:${d.key}`] = 'figma';
          render();
        };
        const useAllGithub = el('button', { textContent: 'Use all GitHub (conflicts)' });
        useAllGithub.onclick = () => {
          for (const d of changed) if (d.status === 'modified' && !d.cascadeOnly) state.resolutions[`${d.category}:${d.key}`] = 'github';
          render();
        };
        bulkRow.append(useAllFigma, useAllGithub);
        container.appendChild(bulkRow);
      }

      for (const category of TOKEN_CATEGORIES) {
        const rows = changed.filter((d) => d.category === category).sort((a, b) => diffRowPriority(a) - diffRowPriority(b));
        if (rows.length === 0) continue;
        const group = el('div', { className: 'diff-group' });
        group.appendChild(el('h2', {}, [category]));
        for (const d of rows) group.appendChild(renderDiffRow(d));
        container.appendChild(group);
      }

      // Broken/circular references (state.validationErrors) are NOT a
      // reason to block syncing the other 11,000+ tokens that are fine —
      // each broken one already shows up below as its own "modified" row
      // (its resolved value can't be compared, so it can't read as
      // "unchanged" either) and gets Skipped/resolved like any other
      // conflict. Only genuinely unresolved conflicts block Sync.
      const remaining = unresolvedConflictCount();
      const blocked = remaining > 0 || state.syncing;
      const syncBtn = el('button', {
        className: 'cta',
        textContent: state.syncing ? 'Opening pull request…' : 'Sync (open PR & update Figma)',
        title: 'Applies your resolutions to Figma immediately, and opens a pull request against ' +
          (state.settings?.branch ?? 'the configured branch') +
          ' with the merged tokens — nothing is committed directly to that branch.',
      });
      if (blocked) syncBtn.setAttribute('disabled', 'true');
      syncBtn.onclick = () => runSync();
      container.appendChild(el('div', { className: 'btn-row' }, [syncBtn]));
      if (!state.syncing && remaining > 0) {
        container.appendChild(
          el('p', { className: 'hint' }, [`Resolve ${remaining} conflicting token${remaining === 1 ? '' : 's'} before syncing.`]),
        );
      }
    }
  }

  container.appendChild(el('pre', { id: 'log', textContent: state.log.join('\n') }));
  return container;
}

function renderDiffRow(d: DiffEntry): HTMLElement {
  const row = el('div', { className: `diff-row status-${d.status}${d.cascadeOnly ? ' cascade-only' : ''}` });
  const badgeText = d.cascadeOnly
    ? 'Auto-resolves'
    : { 'added-figma': 'New in Figma', 'added-github': 'New in GitHub', modified: 'Conflict', unchanged: '' }[d.status];
  row.appendChild(el('div', { className: 'diff-key' }, [d.key, el('span', { className: 'diff-badge' }, [badgeText])]));
  row.appendChild(
    el('div', { className: 'diff-values' }, [
      diffValueLine('Figma', d.figmaDisplay, isReferenceToken(d.figmaValue)),
      diffValueLine('GitHub', d.githubDisplay, isReferenceToken(d.githubValue)),
    ]),
  );

  if (d.status === 'modified' && d.cascadeOnly) {
    // Nothing stored on this key changed — only what it resolves to,
    // because something it points at changed elsewhere in this diff. No
    // resolution to make: it settles on its own once the underlying
    // reference is handled, same as any CSS variable's consumers picking
    // up a new value automatically.
    row.appendChild(
      el('p', { className: 'cascade-note' }, [
        "Nothing to decide here — this value only changed because a token it references changed. It resolves automatically once that token is handled.",
      ]),
    );
  } else if (d.status === 'modified') {
    const resKey = `${d.category}:${d.key}`;
    const current = state.resolutions[resKey];
    const controls = el('div', { className: 'resolution-controls' });
    for (const [value, text] of [
      ['figma', 'Use Figma'],
      ['github', 'Use GitHub'],
      ['skip', 'Skip'],
    ] as [Resolution, string][]) {
      const id = `${resKey}:${value}`;
      const radio = el('input', { type: 'radio', name: resKey, id, checked: current === value });
      radio.onchange = () => {
        state.resolutions[resKey] = value;
        render();
      };
      const label = el('label', { htmlFor: id }, [radio, ` ${text}`]);
      controls.appendChild(label);
    }
    row.appendChild(controls);
  } else if (d.status === 'added-figma' || d.status === 'added-github') {
    const resKey = `${d.category}:${d.key}`;
    // Included by default (no resolution stored at all) — this checkbox is
    // an opt-OUT, not a decision that has to be made. Checked = will sync,
    // matching what actually happens if you never touch it.
    const included = state.resolutions[resKey] !== 'skip';
    const controls = el('div', { className: 'resolution-controls' });
    const id = `${resKey}:include-toggle`;
    const checkbox = el('input', { type: 'checkbox', id, checked: included });
    checkbox.onchange = () => {
      if (checkbox.checked) delete state.resolutions[resKey];
      else state.resolutions[resKey] = 'skip';
    };
    controls.appendChild(el('label', { htmlFor: id }, [checkbox, ' Include in sync']));
    row.appendChild(controls);
  }

  return row;
}

const STORYBOOK_STATUS_COPY: Record<StorybookStatus, { cls: string; text: (() => string) | string }> = {
  unknown: { cls: '', text: '' },
  'in-sync': {
    cls: 'success',
    text: () =>
      `Storybook is in sync with GitHub${
        state.storybookMarker ? ` — built ${new Date(state.storybookMarker.builtAt).toLocaleString()}` : ''
      }.`,
  },
  stale: {
    cls: 'error',
    text: () =>
      `Storybook is out of date — GitHub's tokens changed since the last build${
        state.storybookMarker ? ` (built ${new Date(state.storybookMarker.builtAt).toLocaleString()})` : ''
      }. Run "npm run build-storybook" in the tokens repo and push.`,
  },
  'never-built': {
    cls: 'error',
    text: 'Storybook has never been built from this repo (no .storybook-sync.json found). Run "npm run build-storybook" and push.',
  },
  error: {
    cls: 'error',
    text: () => `Couldn't check Storybook: ${state.storybookError ?? 'unknown error'}`,
  },
};

const DIFF_STATUS_LABEL: Record<DiffEntry['status'], string> = {
  'added-figma': 'New in Figma',
  'added-github': 'New in GitHub',
  modified: 'Conflict',
  unchanged: '',
};

// Surfaces a step-by-step fix whenever a GitHub call fails on a permission
// error (403 "Resource not accessible by personal access token" is the
// common one — usually Pull requests or Actions write access missing from
// the PAT), instead of leaving the user to work out from a raw API error
// message which of the three permissions this plugin needs is missing.
function renderPermissionErrorGuide(error: string): HTMLElement | null {
  if (!/403|not accessible/i.test(error)) return null;

  const details = el('details', { open: true, className: 'setup-guide' });
  details.appendChild(el('summary', {}, ['How to fix this: grant the missing permission']));

  const body = el('div', {});
  body.appendChild(
    el('p', { className: 'hint' }, [
      'The GitHub token in the Connect tab is missing a permission this action needs. Depending on ' +
        'what you were doing, it\'s one of: ',
      el('code', {}, ['Contents: Read and write']),
      ' (reading/committing tokens), ',
      el('code', {}, ['Pull requests: Read and write']),
      ' (Sync opens a PR), or ',
      el('code', {}, ['Actions: Read and write']),
      ' ("Rebuild Storybook").',
    ]),
  );
  body.appendChild(
    el('p', { className: 'hint' }, [
      el('strong', {}, ['Fine-grained token']), ' (starts ', el('code', {}, ['github_pat_']), '):',
    ]),
  );
  body.appendChild(
    el('pre', {}, [
      '1. github.com/settings/personal-access-tokens\n' +
        '2. Find this token → Edit permissions\n' +
        '3. Under "Repository permissions", set the missing one(s) above to "Read and write"\n' +
        '4. Save — takes effect immediately, no need to regenerate',
    ]),
  );
  body.appendChild(
    el('p', { className: 'hint' }, [
      el('strong', {}, ['Classic token']), ' (starts ', el('code', {}, ['ghp_']), '):',
    ]),
  );
  body.appendChild(
    el('pre', {}, [
      '1. github.com/settings/tokens\n' +
        '2. Regenerate with the "repo" scope checked (classic tokens have no\n' +
        '   narrower Pull requests/Actions scope — "repo" covers all three)',
    ]),
  );
  body.appendChild(
    el('p', { className: 'hint' }, [
      'Then come back here and click the action again — nothing else needs to change.',
    ]),
  );
  details.appendChild(body);
  return details;
}

// Notifications are CI-driven, not plugin-driven: the webhook URL is a
// team-shared secret, and figma.clientStorage is explicitly single-machine
// (same reasoning as the audit log itself living in the repo, not
// clientStorage). So the plugin's job here is setup guidance + a way to
// verify it worked, not holding the secret itself — see notify-on-sync.mjs
// and notify-on-sync.yml in the tokens repo.
function renderNotificationsGuide(): HTMLElement {
  const details = el('details', { className: 'setup-guide' });
  details.appendChild(el('summary', {}, ['Set up Teams or Slack notifications']));

  const body = el('div', {});
  body.appendChild(
    el('p', { className: 'hint' }, [
      'Posts a message whenever a sync lands (see the History tab) — actor, PR link, and how many tokens changed. ' +
        'Requires ',
      el('code', {}, ['.github/workflows/notify-on-sync.yml']),
      ' and ',
      el('code', {}, ['scripts/notify-on-sync.mjs']),
      ' to exist in the tokens repo. Set up either provider, or both — neither is required.',
    ]),
  );

  body.appendChild(el('p', { className: 'hint' }, [el('strong', {}, ['Microsoft Teams']), ':']));
  body.appendChild(
    el('pre', {}, [
      '1. In the target Teams channel: ⋯ next to the channel name → Workflows\n' +
        '   (Teams retired classic "Connectors" webhooks — Workflows is the\n' +
        '   current replacement, built on Power Automate.)\n' +
        '2. Search the template "Post to a channel when a webhook request is\n' +
        '   received" → select this channel → Add workflow\n' +
        '3. Copy the URL it gives you\n' +
        `4. github.com/${state.settings?.owner ?? '<owner>'}/${state.settings?.repo ?? '<repo>'}` +
        '/settings/secrets/actions → New repository secret\n' +
        '   Name: TEAMS_WEBHOOK_URL — Value: the URL from step 3',
    ]),
  );

  body.appendChild(el('p', { className: 'hint' }, [el('strong', {}, ['Slack']), ':']));
  body.appendChild(
    el('pre', {}, [
      '1. api.slack.com/apps → Create New App → From scratch\n' +
        '2. Features → Incoming Webhooks → toggle on\n' +
        '3. Add New Webhook to Workspace → pick the channel → Allow\n' +
        '4. Copy the URL (starts hooks.slack.com/services/…)\n' +
        `5. github.com/${state.settings?.owner ?? '<owner>'}/${state.settings?.repo ?? '<repo>'}` +
        '/settings/secrets/actions → New repository secret\n' +
        '   Name: SLACK_WEBHOOK_URL — Value: the URL from step 4',
    ]),
  );

  const testBtn = el('button', { textContent: state.notifyTestSending ? 'Sending…' : 'Send test notification' });
  if (state.notifyTestSending) testBtn.setAttribute('disabled', 'true');
  testBtn.onclick = async () => {
    if (!state.settings) return;
    state.notifyTestSending = true;
    state.notifyTestMessage = null;
    state.notifyTestError = null;
    render();
    try {
      await triggerNotifyTest(state.settings);
      state.notifyTestMessage =
        'Triggered — check the configured channel(s) in a few seconds. If nothing arrives, confirm the secret name(s) match exactly and the webhook is still valid.';
    } catch (err) {
      state.notifyTestError = err instanceof Error ? err.message : String(err);
    } finally {
      state.notifyTestSending = false;
      render();
    }
  };
  body.appendChild(el('div', { className: 'btn-row' }, [testBtn]));
  if (state.notifyTestMessage) body.appendChild(el('p', { className: 'hint' }, [state.notifyTestMessage]));
  if (state.notifyTestError) {
    body.appendChild(el('div', { className: 'status-banner error' }, [state.notifyTestError]));
    const guide = renderPermissionErrorGuide(state.notifyTestError);
    if (guide) body.appendChild(guide);
  }

  details.appendChild(body);
  return details;
}

function renderStorybookGuide(): HTMLElement {
  const settings = state.settings;
  const repoName = settings?.repo ?? '<repo>';
  const cloneUrl = settings ? `https://github.com/${settings.owner}/${settings.repo}.git` : 'https://github.com/<owner>/<repo>.git';
  const needsSetup = state.storybookStatus === 'never-built' || state.storybookStatus === 'error' || state.storybookStatus === 'unknown';

  const details = el('details', { open: needsSetup, className: 'setup-guide' });
  details.appendChild(el('summary', {}, [needsSetup ? 'How to set up Storybook for this repo' : 'How to update Storybook']));

  const body = el('div', {});
  if (needsSetup) {
    body.appendChild(
      el('p', { className: 'hint' }, [
        'One-time setup, run in a terminal — Figma plugins can\'t run local commands, so this part is manual:',
      ]),
    );
    body.appendChild(
      el('pre', {}, [
        `git clone ${cloneUrl}\ncd ${repoName}\nnpm install\nnpx storybook init   # auto-detects a framework, adds config\nnpm run build-storybook`,
      ]),
    );
    body.appendChild(
      el('p', { className: 'hint' }, [
        'Point your stories at ',
        el('code', {}, [settings?.path ?? 'design-tokens.json']),
        ' at the repo root — that\'s the file this plugin keeps synced. Then add a ',
        el('code', {}, ['postbuild-storybook']),
        ' npm script that writes ',
        el('code', {}, ['.storybook-sync.json']),
        ' with ',
        el('code', {}, ['{ "tokensBlobSha": "<git hash-object ' + (settings?.path ?? 'design-tokens.json') + '>", "builtAt": "<now>" }']),
        ' — that\'s how this Status tab knows a build is current.',
      ]),
    );
  } else {
    body.appendChild(
      el('p', { className: 'hint' }, [
        'Storybook is already set up here. Use the "Rebuild Storybook" button above to trigger ',
        el('code', {}, ['deploy-storybook.yml']),
        ' from here, or run it manually:',
      ]),
    );
    body.appendChild(
      el('pre', {}, [`cd ${repoName}\nnpm run build-storybook\ngit add -A\ngit commit -m "Update Storybook"\ngit push`]),
    );
  }
  details.appendChild(body);
  return details;
}

function renderStatusTab(): HTMLElement {
  const container = el('div');

  if (!isConfigured(state.settings)) {
    container.appendChild(el('div', { className: 'empty-state' }, ['Set up your GitHub repository in the Connect tab first.']));
    return container;
  }

  const refreshBtn = el('button', {
    className: 'primary',
    textContent: state.comparing ? 'Checking…' : 'Refresh status',
  });
  if (state.comparing) refreshBtn.setAttribute('disabled', 'true');
  refreshBtn.onclick = () => runCompare();
  container.appendChild(el('div', { className: 'btn-row' }, [refreshBtn]));

  if (state.syncError) {
    container.appendChild(el('div', { className: 'status-banner error' }, [state.syncError]));
    const guide = renderPermissionErrorGuide(state.syncError);
    if (guide) container.appendChild(guide);
  }
  const validationBanner = renderValidationErrors();
  if (validationBanner) container.appendChild(validationBanner);

  if (state.diff.length === 0 && state.storybookStatus === 'unknown') {
    container.appendChild(
      el('div', { className: 'empty-state' }, [
        state.comparing ? 'Checking Figma, GitHub, and Storybook…' : 'Click "Refresh status" to check all three.',
      ]),
    );
    return container;
  }

  const outOfSync = state.diff.filter((d) => d.status !== 'unchanged');
  const figmaGithubInSync = outOfSync.length === 0;
  const storybookInSync = state.storybookStatus === 'in-sync';
  const pairsInSync = (figmaGithubInSync ? 1 : 0) + (storybookInSync ? 1 : 0);
  container.appendChild(
    el('div', { className: `status-banner ${pairsInSync === 2 ? 'success' : 'error'}` }, [
      pairsInSync === 2
        ? '✓ Figma, GitHub, and Storybook are all in sync.'
        : `${pairsInSync} of 2 sync relationships are up to date — see below.`,
    ]),
  );

  if (state.pendingPr) {
    const link = el('a', { href: state.pendingPr.url, target: '_blank', textContent: `PR #${state.pendingPr.number}` });
    container.appendChild(
      el(
        'div',
        { className: `status-banner ${state.pendingPr.state === 'open' ? '' : 'error'}` },
        state.pendingPr.state === 'open'
          ? [link, ' is open and pending review. The differences below won\'t resolve until it\'s merged — that\'s expected, not an error.']
          : [link, ' was closed without merging. Re-run Sync below if these changes are still needed.'],
      ),
    );
  }

  container.appendChild(el('h2', {}, ['1. Figma ↔ GitHub']));
  if (figmaGithubInSync) {
    container.appendChild(el('div', { className: 'status-banner success' }, ['Every token matches between Figma and GitHub.']));
  } else {
    container.appendChild(
      el('div', { className: 'status-banner error' }, [`${outOfSync.length} token(s) differ — see below.`]),
    );
    const table = el('table', { className: 'token-table' });
    table.appendChild(
      el('thead', {}, [
        el('tr', {}, [el('th', {}, ['Token']), el('th', {}, ['Figma']), el('th', {}, ['GitHub']), el('th', {}, ['Status'])]),
      ]),
    );
    const tbody = el('tbody');
    for (const d of outOfSync) {
      tbody.appendChild(
        el('tr', {}, [
          el('td', {}, [`${d.category}/${d.key}`]),
          el('td', {}, [d.figmaDisplay]),
          el('td', {}, [d.githubDisplay]),
          el('td', {}, [d.cascadeOnly ? 'Auto-resolves (reference)' : DIFF_STATUS_LABEL[d.status]]),
        ]),
      );
    }
    table.appendChild(tbody);
    container.appendChild(table);
  }

  const storybookHeading = el('h2', {}, ['2. GitHub ↔ Storybook']);
  storybookHeading.style.marginTop = '18px';
  container.appendChild(storybookHeading);
  if (state.storybookStatus !== 'unknown') {
    const info = STORYBOOK_STATUS_COPY[state.storybookStatus];
    const text = typeof info.text === 'function' ? info.text() : info.text;
    container.appendChild(el('div', { className: `status-banner ${info.cls}` }, [text]));
  }

  const viewBtn = el('button', {
    textContent: state.checkingLocalStorybook ? 'Checking…' : 'View Storybook (local)',
    title: `Checks for a dev server at ${LOCAL_STORYBOOK_URL} and opens it if found. A plugin can't start the server itself — no shell access in either execution context.`,
  });
  if (state.checkingLocalStorybook) viewBtn.setAttribute('disabled', 'true');
  viewBtn.onclick = () => viewLocalStorybook();
  container.appendChild(el('div', { className: 'btn-row' }, [viewBtn]));

  if (state.localStorybookReachable === true) {
    container.appendChild(
      el('div', { className: 'status-banner success' }, [`Found it running at ${LOCAL_STORYBOOK_URL} — opened in your browser.`]),
    );
  } else if (state.localStorybookReachable === false) {
    const repoName = state.settings?.repo ?? 'design-tokens';
    const command = `cd ${repoName}\nnpm run storybook`;
    const guide = el('div', { className: 'status-banner error' }, [
      `Nothing's listening at ${LOCAL_STORYBOOK_URL}. Run this in a terminal, then click the button again:`,
    ]);
    container.appendChild(guide);
    const commandRow = el('div', { className: 'btn-row' });
    commandRow.appendChild(el('pre', {}, [command]));
    const copyBtn = el('button', { textContent: 'Copy' });
    copyBtn.onclick = async () => {
      const ok = await copyToClipboard(command);
      copyBtn.textContent = ok ? 'Copied!' : 'Copy failed';
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
      }, 1500);
    };
    commandRow.appendChild(copyBtn);
    container.appendChild(commandRow);
  }

  const canDeploy = state.storybookStatus === 'stale' || state.storybookStatus === 'never-built';
  const deployDisabledReason: string | null = state.storybookDeploying
    ? null
    : canDeploy
      ? null
      : state.storybookStatus === 'in-sync'
        ? 'Storybook already reflects the latest tokens on GitHub — nothing to rebuild.'
        : state.storybookStatus === 'error'
          ? "Couldn't determine Storybook status — see the error above before retrying."
          : 'Run "Refresh status" first so this can tell whether Storybook needs rebuilding.';

  const deployBtn = el('button', {
    className: 'primary',
    textContent: state.storybookDeploying ? 'Triggering…' : 'Rebuild Storybook',
    title: state.storybookDeploying ? 'Deploy already in progress' : (deployDisabledReason ?? 'Rebuild and redeploy Storybook from the latest tokens on GitHub'),
  });
  if (state.storybookDeploying || deployDisabledReason) deployBtn.setAttribute('disabled', 'true');
  deployBtn.onclick = () => deployStorybook();
  container.appendChild(el('div', { className: 'btn-row' }, [deployBtn]));
  if (deployDisabledReason && !state.storybookDeploying) {
    container.appendChild(el('p', { className: 'hint' }, [deployDisabledReason]));
  }

  if (state.storybookDeployMessage) {
    container.appendChild(el('div', { className: 'status-banner success' }, [state.storybookDeployMessage]));
  }
  if (state.storybookDeployError) {
    container.appendChild(el('div', { className: 'status-banner error' }, [state.storybookDeployError]));
  }

  container.appendChild(renderStorybookGuide());

  return container;
}

// ---------------------------------------------------------------------------
// Sync actions
// ---------------------------------------------------------------------------

async function runCompare() {
  if (!state.settings) return;
  const settings = state.settings;
  state.comparing = true;
  state.syncError = null;
  state.storybookError = null;
  state.storybookDeployMessage = null;
  state.storybookDeployError = null;
  state.diff = [];
  state.validationErrors = [];
  state.resolutions = {};
  render();
  try {
    appendLog('Reading tokens from Figma styles…');
    appendLog(`Fetching ${settings.path} and .storybook-sync.json from GitHub…`);
    // Only the most recent sync's PR is worth checking — if it's still
    // open, that's why Figma↔GitHub may still show a diff below (the
    // resolution already exists, just not merged into settings.branch yet).
    const latestPr = state.history[0]?.prNumber != null ? state.history[0] : null;
    const [figmaTokens, githubResult, marker, prStatus] = await Promise.all([
      requestFigmaTokens(),
      fetchGithubTokens(settings),
      fetchStorybookMarker(settings).catch((err) => {
        state.storybookError = err instanceof Error ? err.message : String(err);
        return null;
      }),
      latestPr ? fetchPrStatus(settings, latestPr.prNumber).catch(() => null) : Promise.resolve(null),
    ]);
    state.figmaTokens = figmaTokens;
    state.githubTokens = githubResult.tokens;
    state.githubSha = githubResult.sha;
    state.storybookMarker = marker;
    computeStorybookStatus();

    if (latestPr && prStatus && prStatus.state === 'open') {
      state.pendingPr = { number: latestPr.prNumber, url: latestPr.prUrl, state: 'open' };
    } else if (latestPr && prStatus && prStatus.state === 'closed' && !prStatus.merged) {
      state.pendingPr = { number: latestPr.prNumber, url: latestPr.prUrl, state: 'closed' };
    } else {
      state.pendingPr = null;
    }

    // Broken/circular references must block syncing outright — surfacing
    // them as a normal "conflict" wouldn't make sense, there's no value to
    // pick between.
    state.validationErrors = [
      ...validateTokenSet(state.figmaTokens).map((e) => ({ ...e, source: 'figma' as const })),
      ...validateTokenSet(state.githubTokens).map((e) => ({ ...e, source: 'github' as const })),
    ];

    state.diff = diffTokenSets(state.figmaTokens, state.githubTokens);
    const changed = state.diff.filter((d) => d.status !== 'unchanged').length;
    appendLog(
      `Compared: ${state.diff.length} token(s) total, ${changed} changed. Storybook: ${state.storybookStatus}.` +
        (state.validationErrors.length > 0 ? ` ${state.validationErrors.length} validation error(s).` : ''),
    );
  } catch (err) {
    state.syncError = err instanceof Error ? err.message : String(err);
    appendLog(`Error: ${state.syncError}`);
  } finally {
    state.comparing = false;
    render();
  }
}

async function loadUserRepos(token: string) {
  if (!token) {
    state.reposError = 'Enter your personal access token above first.';
    render();
    return;
  }
  state.loadingRepos = true;
  state.reposError = null;
  render();
  try {
    state.availableRepos = await fetchUserRepos(token);
  } catch (err) {
    state.reposError = err instanceof Error ? err.message : String(err);
  } finally {
    state.loadingRepos = false;
    render();
  }
}

async function viewLocalStorybook() {
  state.checkingLocalStorybook = true;
  state.localStorybookReachable = null;
  render();
  const reachable = await checkLocalStorybook();
  state.checkingLocalStorybook = false;
  state.localStorybookReachable = reachable;
  if (reachable) postToPlugin({ type: 'open-external', url: LOCAL_STORYBOOK_URL });
  render();
}

async function deployStorybook() {
  if (!state.settings) return;
  state.storybookDeploying = true;
  state.storybookDeployMessage = null;
  state.storybookDeployError = null;
  render();
  try {
    appendLog('Triggering Storybook rebuild…');
    await triggerStorybookDeploy(state.settings);
    state.storybookDeployMessage =
      'Rebuild triggered — check the repo\'s Actions tab for progress, then run "Refresh status" once it finishes.';
    appendLog('Storybook rebuild triggered.');
  } catch (err) {
    state.storybookDeployError = err instanceof Error ? err.message : String(err);
    appendLog(`Error: ${state.storybookDeployError}`);
  } finally {
    state.storybookDeploying = false;
    render();
  }
}

function syncBranchName(): string {
  // Colons aren't valid in a git ref name.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `design-sync/sync-${stamp}`;
}

async function runSync() {
  if (!state.settings) return;
  const settings = state.settings;
  state.syncing = true;
  state.syncError = null;
  render();
  try {
    const { final, figmaApply } = buildSyncPlan(state.figmaTokens, state.githubTokens, state.resolutions);
    // Phase 2: dimension/string/boolean tokens backed by a Figma Variable
    // now get a real per-key write (setValueForMode), same as color — so,
    // like color/typography/shadow, figmaApply's delta-only subset from
    // buildSyncPlan is exactly what should be applied. Overwriting it with
    // the full merged set here (the pre-Phase-2 behavior, back when these
    // categories only ever wrote a single plugin-data blob that had to be
    // replaced wholesale) would re-write every variable-backed
    // dimension/string/boolean token on every sync, changed or not.
    preferLiveFigmaExtensions(figmaApply, state.figmaTokens);

    // A resolved conflict doesn't always mean GitHub's stored content
    // actually needs to change — e.g. every conflict got resolved as
    // "keep GitHub's value", or the only "conflicts" were reference
    // cascades (see cascadeOnly on DiffEntry) that were never going to
    // touch GitHub's file at all. If nothing differs, opening a branch + PR
    // would just be empty noise — a real case hit while testing the
    // cascade-only fix above, where the only "changes" were cascades and
    // the resulting PR had a 0-line diff.
    const githubChanged = githubContentChanged(final, state.githubTokens);

    let pr: { number: number; url: string } | null = null;
    if (githubChanged) {
      // Sync opens a PR against settings.branch instead of committing to it
      // directly — nothing lands on the branch Storybook/downstream builds
      // consume without a review step (Phase 3). The base branch's SHA is
      // untouched by any of this, so state.githubSha stays valid; a 409 on
      // retry (the original reason for eagerly updating it after a direct
      // commit) can't happen here, since we're never writing to the tip of
      // settings.branch.
      const branch = syncBranchName();
      appendLog(`Creating branch ${branch}…`);
      const baseSha = await getBranchHeadSha(settings, settings.branch);
      await createBranch(settings, branch, baseSha);

      appendLog('Committing merged tokens to the new branch…');
      await commitGithubTokens(settings, final, state.githubSha, branch);

      const changedCount = state.diff.filter((d) => d.status !== 'unchanged' && !(state.resolutions[`${d.category}:${d.key}`] === 'skip')).length;
      appendLog('Opening pull request…');
      try {
        pr = await createPullRequest(
          settings,
          branch,
          'Design Sync: update design tokens',
          `Opened by the Design Sync Figma plugin. ${changedCount} token(s) resolved.\n\nMerging this brings \`${settings.path}\` in line with the current Figma file.`,
        );
      } catch (err) {
        // The branch + commit above already succeeded — leaving it behind
        // would just accumulate dead `design-sync/sync-*` branches every
        // time this fails (e.g. a PAT missing Pull requests: write). Clean
        // it up so a retry starts fresh instead of leaving orphans.
        appendLog(`Opening pull request failed — deleting branch ${branch}…`);
        await deleteBranch(settings, branch).catch(() => {});
        throw err;
      }
      appendLog(`Opened PR #${pr.number}.`);

      const historyEntry: SyncHistoryEntry = {
        timestamp: new Date().toISOString(),
        prNumber: pr.number,
        prUrl: pr.url,
        branch,
      };
      state.history.unshift(historyEntry);
      postToPlugin({ type: 'save-history', entry: historyEntry });
      state.pendingPr = { number: pr.number, url: pr.url, state: 'open' };

      // Audit trail (Phase 5): record what this sync actually changed on
      // GitHub. Committed to the same branch as the tokens themselves, so
      // it's part of the same PR the reviewer sees — best-effort: a failed
      // audit-log write shouldn't fail a sync whose real work (the PR) has
      // already succeeded, so it's logged as a warning, not thrown.
      const changes: AuditChange[] = computeAuditChanges(final, state.githubTokens, state.resolutions);
      try {
        const actor = await fetchGithubUsername(settings);
        const auditEntry: AuditEntry = { timestamp: historyEntry.timestamp, actor, prNumber: pr.number, prUrl: pr.url, branch, changes };
        await appendAuditLogEntry(settings, branch, auditEntry);
      } catch (err) {
        appendLog(`Warning: recording the audit entry failed (${err instanceof Error ? err.message : String(err)}) — the sync itself still succeeded.`);
      }
    } else {
      appendLog('No GitHub changes needed — merged result already matches GitHub. Skipping branch/PR.');
    }

    state.resolutions = {};

    // Figma is a local design file, not the shared repo the review gate
    // protects — applying the merged resolution here immediately (ahead
    // of the PR being reviewed/merged) is intentional, not a bypass. The
    // next "Refresh status" will correctly show these tokens as still
    // differing from settings.branch until the PR actually merges.
    appendLog('Applying changes to Figma styles…');
    const resolvedApply = resolveForFigmaApply(figmaApply, final);
    const result = await applyTokensToFigma(resolvedApply);
    if (!result.success) {
      const prContext = pr ? `Pull request #${pr.number} was opened, but applying` : 'Applying';
      throw new Error(
        `${prContext} changes back to Figma failed: ${
          result.error ?? 'unknown error'
        }. This usually means you only have view access to this Figma file.`,
      );
    }
    // Per-token detail on whether each color/dimension/string/boolean token
    // wrote back to a real Figma Variable or fell back to a Style/plugin
    // data blob, and why — the only way to actually see that from the UI,
    // since applyTokensToFigma's write-back attempt is otherwise invisible.
    for (const line of result.diagnostics ?? []) appendLog(`  ${line}`);
    appendLog('Figma styles updated.');
    appendLog(pr ? 'Sync complete — pull request pending review.' : 'Sync complete.');
  } catch (err) {
    state.syncError = err instanceof Error ? err.message : String(err);
    appendLog(`Error: ${state.syncError}`);
  } finally {
    // Always reconcile Figma-side state against whatever actually
    // happened, even on a partial failure above — but don't let a failure
    // *here* mask whatever error the try block already recorded, or go
    // unhandled entirely (runSync() itself is fired from an onclick with
    // no .catch()). GitHub-side state (githubTokens/githubSha) is left
    // alone — settings.branch didn't change, the PR did.
    try {
      state.figmaTokens = await requestFigmaTokens();
      state.diff = diffTokenSets(state.figmaTokens, state.githubTokens);
    } catch (err) {
      if (!state.syncError) {
        state.syncError = err instanceof Error ? err.message : String(err);
        appendLog(`Error re-reading Figma after sync: ${state.syncError}`);
      }
    }
    state.syncing = false;
    render();
  }
}

// ---------------------------------------------------------------------------
// History tab (Phase 5)
// ---------------------------------------------------------------------------

// Reads from settings.branch (the base branch) rather than any in-flight
// sync branch — the History tab shows what's actually merged, matching
// what a team member checking history from a different machine would see.
async function loadAuditLog() {
  if (!state.settings) return;
  state.auditLogLoading = true;
  state.auditLogError = null;
  render();
  try {
    const { text } = await fetchAuditLogRaw(state.settings, state.settings.branch);
    state.auditLog = parseAuditLog(text);
    state.auditLogLoaded = true;
  } catch (err) {
    state.auditLogError = err instanceof Error ? err.message : String(err);
  } finally {
    state.auditLogLoading = false;
    render();
  }
}

async function runRevert(entry: AuditEntry) {
  if (!state.settings || !canRevertEntry(entry)) return;
  const settings = state.settings;
  state.reverting = entry.timestamp;
  state.syncError = null;
  render();
  try {
    appendLog(`Reverting sync from ${new Date(entry.timestamp).toLocaleString()} (PR #${entry.prNumber})…`);

    // Re-read GitHub's CURRENT content fresh rather than trusting whatever
    // is already in state — the History tab can be opened without a prior
    // Sync tab compare this session, and reverting against a stale base
    // risks clobbering a later sync this session doesn't know about.
    const { tokens: currentGithubTokens, sha: currentSha } = await fetchGithubTokens(settings);

    const inverse = invertAuditChanges(entry.changes);
    const reverted: TokenSet = emptyTokenSet();
    for (const category of TOKEN_CATEGORIES) reverted[category] = { ...currentGithubTokens[category] } as never;
    const revertApply: TokenSet = emptyTokenSet();
    for (const change of inverse) {
      (reverted[change.category] as Record<string, unknown>)[change.key] = change.newValue;
      (revertApply[change.category] as Record<string, unknown>)[change.key] = change.newValue;
    }

    const branch = syncBranchName();
    appendLog(`Creating branch ${branch}…`);
    const baseSha = await getBranchHeadSha(settings, settings.branch);
    await createBranch(settings, branch, baseSha);

    appendLog('Committing reverted tokens to the new branch…');
    await commitGithubTokens(settings, reverted, currentSha, branch);

    let pr: { number: number; url: string };
    try {
      pr = await createPullRequest(
        settings,
        branch,
        `Design Sync: revert sync from ${new Date(entry.timestamp).toLocaleString()}`,
        `Reverts ${entry.changes.length} token(s) changed by PR #${entry.prNumber} back to their previous values.\n\nOpened by the Design Sync Figma plugin's History tab.`,
      );
    } catch (err) {
      appendLog(`Opening revert pull request failed — deleting branch ${branch}…`);
      await deleteBranch(settings, branch).catch(() => {});
      throw err;
    }
    appendLog(`Opened revert PR #${pr.number}.`);

    const revertTimestamp = new Date().toISOString();
    const historyEntry: SyncHistoryEntry = { timestamp: revertTimestamp, prNumber: pr.number, prUrl: pr.url, branch };
    state.history.unshift(historyEntry);
    postToPlugin({ type: 'save-history', entry: historyEntry });
    state.pendingPr = { number: pr.number, url: pr.url, state: 'open' };

    // A revert is itself a new, auditable sync event — not a special
    // git-level operation that bypasses the log.
    try {
      const actor = await fetchGithubUsername(settings);
      const auditEntry: AuditEntry = { timestamp: revertTimestamp, actor, prNumber: pr.number, prUrl: pr.url, branch, changes: inverse };
      await appendAuditLogEntry(settings, branch, auditEntry);
    } catch (err) {
      appendLog(`Warning: recording the revert's audit entry failed (${err instanceof Error ? err.message : String(err)}) — the revert PR itself still succeeded.`);
    }

    // Figma is a local design file — apply immediately, same reasoning as
    // a normal sync (see runSync above).
    appendLog('Applying reverted values to Figma…');
    preferLiveFigmaExtensions(revertApply, state.figmaTokens);
    const resolvedApply = resolveForFigmaApply(revertApply, reverted);
    const result = await applyTokensToFigma(resolvedApply);
    if (!result.success) {
      appendLog(
        `Warning: applying reverted values to Figma failed (${result.error ?? 'unknown error'}) — the revert PR was still opened; merging it and syncing again will pick it up.`,
      );
    } else {
      for (const line of result.diagnostics ?? []) appendLog(`  ${line}`);
      appendLog('Figma updated with reverted values.');
    }

    appendLog('Revert complete — pull request pending review.');
    await loadAuditLog();
  } catch (err) {
    state.syncError = err instanceof Error ? err.message : String(err);
    appendLog(`Error: ${state.syncError}`);
  } finally {
    state.reverting = null;
    render();
  }
}

function renderAuditChangeRow(c: AuditChange): HTMLElement {
  const format = (v: unknown) => (v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v));
  return el('div', { className: 'audit-change-row' }, [
    el('div', { className: 'audit-change-key' }, [`${c.category}/${c.key}`]),
    el('div', { className: 'audit-change-values' }, [`${format(c.previousValue)} → ${format(c.newValue)}`]),
  ]);
}

function renderHistoryTab(): HTMLElement {
  const container = el('div');

  if (!isConfigured(state.settings)) {
    container.appendChild(el('div', { className: 'empty-state' }, ['Set up your GitHub repository in the Connect tab first.']));
    return container;
  }

  const loadBtn = el('button', { className: 'primary', textContent: state.auditLogLoading ? 'Loading…' : 'Load history' });
  if (state.auditLogLoading) loadBtn.setAttribute('disabled', 'true');
  loadBtn.onclick = () => loadAuditLog();
  container.appendChild(el('div', { className: 'btn-row' }, [loadBtn]));

  if (state.auditLogError) {
    container.appendChild(el('div', { className: 'status-banner error' }, [state.auditLogError]));
    const guide = renderPermissionErrorGuide(state.auditLogError);
    if (guide) container.appendChild(guide);
  }
  if (state.syncError) {
    container.appendChild(el('div', { className: 'status-banner error' }, [state.syncError]));
  }

  if (state.auditLog.length === 0) {
    let message: string;
    if (state.auditLogLoading) message = 'Loading history…';
    else if (state.auditLogLoaded) {
      // Loaded successfully, genuinely nothing there yet — most likely
      // because no sync has run since this branch's audit log was created,
      // or an older audit-log.jsonl predates this plugin version.
      message = `No sync history recorded yet on "${state.settings.branch}" — it's created by the first sync run after this feature shipped (v1.6.0).`;
    } else message = 'Click "Load history" to see past syncs from this repo\'s configured branch.';
    container.appendChild(el('div', { className: 'empty-state' }, [message]));
    return container;
  }

  for (const entry of state.auditLog) {
    const canRevert = canRevertEntry(entry);
    const reverting = state.reverting === entry.timestamp;
    const item = el('div', { className: 'diff-row' });
    item.appendChild(
      el('div', { className: 'diff-key' }, [
        `${new Date(entry.timestamp).toLocaleString()} — ${entry.actor}`,
        el('span', { className: 'diff-badge' }, [`${entry.changes.length} change${entry.changes.length === 1 ? '' : 's'}`]),
      ]),
    );
    const prLink = el('a', { href: entry.prUrl, target: '_blank', textContent: `PR #${entry.prNumber}` });
    item.appendChild(el('p', { className: 'hint' }, [prLink]));

    const details = el('div', { className: 'diff-values' });
    for (const c of entry.changes) details.appendChild(renderAuditChangeRow(c));
    item.appendChild(details);

    const controls = el('div', { className: 'resolution-controls' });
    const revertBtn = el('button', {
      textContent: reverting ? 'Reverting…' : 'Revert this sync',
      title: canRevert
        ? 'Opens a new pull request restoring every token in this entry to its previous value.'
        : "This sync added new tokens — revert isn't supported for additions yet. Remove them directly in GitHub if needed.",
    });
    if (!canRevert || reverting || state.reverting) revertBtn.setAttribute('disabled', 'true');
    revertBtn.onclick = () => runRevert(entry);
    controls.appendChild(revertBtn);
    item.appendChild(controls);

    container.appendChild(item);
  }

  return container;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach((btn) => {
  btn.onclick = () => {
    state.activeTab = (btn.dataset.tab as Tab) ?? 'connect';
    render();
  };
});

postToPlugin({ type: 'ui-ready' });
render();
