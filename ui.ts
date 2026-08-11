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
import type { AuditChange, AuditEntry, DiffEntry, Resolution, SyncExecutionPlan } from './sync-logic';
import {
  AUDIT_LOG_PATH,
  buildSyncPlan,
  canRevertEntry,
  diffRowPriority,
  diffTokenSets,
  invertAuditChanges,
  isReferenceToken,
  planSync,
  preferLiveFigmaExtensions,
  resolveForFigmaApply,
} from './sync-logic';
import { iconSvg, type IconName } from './icons';

// Injected at build time by scripts/build-ui.mjs via esbuild's `define` —
// the same package.json version already baked into the footer's HTML text,
// exposed here as a real value so this file's own code (the update-check
// banner) can compare against it, not scrape the DOM for it.
declare const __APP_VERSION__: string;

// This plugin's OWN repo — distinct from state.settings, which points at
// whatever tokens repo the user has connected. Checking for a plugin
// update never depends on a repo connection existing at all.
const PLUGIN_REPO = { owner: 'shivanshu-epam', repo: 'design-sync-plugin' };

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
      state.dismissedUpdateVersion = msg.dismissedUpdateVersion;
      // Fire-and-forget — never blocks init, never blocks the rest of this
      // handler. A slow or failed check (offline, repo not public yet, rate
      // limited) just means no banner shows, not a hang or an error state
      // anywhere else in the app.
      fetchLatestPluginRelease().then((release) => {
        if (release) {
          state.latestPluginRelease = release;
          render();
        }
      });
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
  // 'unknown' = not checked yet (or the last check failed/was unauthorized —
  // deliberately NOT treated the same as "confirmed not configured", so a
  // missing Pages:read PAT scope reads as "can't tell" rather than a false
  // "not deployed" claim).
  pagesStatus: 'unknown' | 'not-configured' | 'configured';
  pagesUrl: string | null;
  pagesLastBuildAt: string | null;
  pagesError: string | null;
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
  // Set once fetchLatestPluginRelease() finds a version newer than
  // __APP_VERSION__ — null means "nothing newer found (or check hasn't
  // resolved / failed / repo not public yet)," never a false "up to date"
  // claim, since a failed check simply never sets this at all.
  latestPluginRelease: { version: string; changelogEntry: string } | null;
  // Loaded from clientStorage at init — the last version the user actually
  // dismissed the banner for, so it doesn't resurface on every relaunch
  // once seen (but does resurface again for the NEXT version after that).
  dismissedUpdateVersion: string | null;
  // Connect tab: false + already configured => show the compact status
  // card instead of the full form. Global state, not a local closure
  // variable — render() rebuilds this tab's DOM from scratch on every
  // unrelated state change, so a closure-local toggle would silently
  // reset every time. (The manual-entry owner/repo/branch/path disclosure
  // doesn't need its own state field — its open/closed default is derived
  // fresh each render from whether those fields already have values, same
  // pattern as renderStorybookGuide's `needsSetup`.)
  connectEditing: boolean;
  // Persists every <details> accordion's open/closed state across
  // renders, keyed by a stable id. Native <details> state lives on the
  // DOM node itself — and render() replaces every node in a tab's
  // container from scratch on ANY state change, including the ones a
  // button *inside* an accordion triggers (e.g. "Send test notification"
  // showing a loading state), which was silently closing every open
  // accordion on the page whenever that happened. Absent from this map =
  // "never explicitly toggled" => falls back to that accordion's own
  // computed default (e.g. open on first render if it needs attention).
  openDetails: Record<string, boolean>;
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
  pagesStatus: 'unknown',
  pagesUrl: null,
  pagesLastBuildAt: null,
  pagesError: null,
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
  latestPluginRelease: null,
  dismissedUpdateVersion: null,
  connectEditing: false,
  openDetails: {},
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
// scripts/record-sync-marker.mjs (explicitly invoked by deploy-storybook.yml
// after a real Pages deploy succeeds, not an npm postbuild hook — see that
// script's header comment) in the tokens repo.
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

interface PagesStatus {
  configured: boolean;
  url: string | null;
  lastBuildAt: string | null;
}

// GET /pages tells us whether GitHub Pages is even enabled for this repo —
// checked here (against api.github.com, already an allowed domain) instead
// of just opening https://{owner}.github.io/{repo}/ directly and letting the
// user hit a raw GitHub 404 page, which is exactly what prompted this. On a
// private repo this 404s the same way whether Pages is genuinely
// unconfigured OR the token just lacks the Pages:read scope — those two
// cases are handled identically at the call site (both read as "can't
// confirm it's live," never as a false "definitely not deployed").
async function fetchPagesStatus(settings: GithubSettings): Promise<PagesStatus> {
  const pagesRes = await githubRequest(`/repos/${settings.owner}/${settings.repo}/pages`, settings);
  if (pagesRes.status === 404) {
    return { configured: false, url: null, lastBuildAt: null };
  }
  if (!pagesRes.ok) {
    const body = await pagesRes.json().catch(() => ({}));
    throw new Error(`Checking GitHub Pages status failed: ${pagesRes.status} ${body.message ?? pagesRes.statusText}`);
  }
  const pages = await pagesRes.json();

  // Best-effort — knowing Pages is configured at all is the important part;
  // a failure here just means no "last deployed" timestamp, not an error.
  let lastBuildAt: string | null = null;
  try {
    const buildRes = await githubRequest(`/repos/${settings.owner}/${settings.repo}/pages/builds/latest`, settings);
    if (buildRes.ok) {
      const build = await buildRes.json();
      if (typeof build.updated_at === 'string') lastBuildAt = build.updated_at;
    }
  } catch {
    // ignore
  }

  return { configured: true, url: typeof pages.html_url === 'string' ? pages.html_url : null, lastBuildAt };
}

// ---------------------------------------------------------------------------
// In-plugin release notices (Phase 22)
// ---------------------------------------------------------------------------

// Pulls the section for `version` out of a CHANGELOG.md that follows this
// project's own "## [X.Y.Z] - YYYY-MM-DD" convention. Returns '' (not an
// error) if the version isn't found — a missing changelog entry shouldn't
// block showing the version-number banner itself.
function extractChangelogSection(changelog: string, version: string): string {
  const marker = `## [${version}]`;
  const start = changelog.indexOf(marker);
  if (start === -1) return '';
  const rest = changelog.slice(start);
  const nextHeading = rest.indexOf('\n## [', 1);
  return (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
}

// Deliberately UNauthenticated — this checks the plugin's own repo, not the
// user's connected tokens repo, and must work whether or not a repo is even
// connected yet. Requires design-sync-plugin to be a PUBLIC repo; on a 404
// (private, or briefly unreachable) this fails silently and no banner shows
// — never surfaced as an error state anywhere else in the app, since "can't
// check for updates right now" isn't something worth interrupting anyone
// over.
async function fetchLatestPluginRelease(): Promise<{ version: string; changelogEntry: string } | null> {
  try {
    const pkgRes = await fetch(`${GITHUB_API}/repos/${PLUGIN_REPO.owner}/${PLUGIN_REPO.repo}/contents/package.json`, {
      cache: 'no-store',
    });
    if (!pkgRes.ok) return null;
    const pkgBody = await pkgRes.json();
    const pkg = JSON.parse(decodeBase64Utf8(pkgBody.content)) as { version?: string };
    const latestVersion = pkg.version;
    if (!latestVersion || latestVersion === __APP_VERSION__) return null;

    let changelogEntry = '';
    try {
      const changelogRes = await fetch(
        `${GITHUB_API}/repos/${PLUGIN_REPO.owner}/${PLUGIN_REPO.repo}/contents/CHANGELOG.md`,
        { cache: 'no-store' },
      );
      if (changelogRes.ok) {
        const changelogBody = await changelogRes.json();
        changelogEntry = extractChangelogSection(decodeBase64Utf8(changelogBody.content), latestVersion);
      }
    } catch {
      // best-effort — the version number alone is still worth showing without changelog text
    }
    return { version: latestVersion, changelogEntry };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Audit trail (Phase 5) — .design-sync/audit-log.jsonl in the tokens repo,
// one JSON line per sync event. Committed to the tokens repo (not
// figma.clientStorage) because it's inherently team-shared, same reasoning
// as design-tokens.json itself.
// ---------------------------------------------------------------------------

// AUDIT_LOG_PATH is imported from sync-logic.ts — single source of truth,
// since planSync's PR-body text also needs it.

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
// Committed BEFORE the PR exists (see runSync) — entry.prNumber/prUrl are
// placeholders at this point (0 / ''), patched to the real values by
// patchLastAuditLogEntry once the PR is created. This ordering is
// deliberate: GitHub rejects PR creation with a 422 ("No commits between
// X and Y") if the branch has no commit yet, and this entry — always
// genuinely new content, since it's an appended line — is what guarantees
// that first commit exists, regardless of whether design-tokens.json
// itself needed to change.
async function appendAuditLogEntry(settings: GithubSettings, branch: string, entry: AuditEntry): Promise<void> {
  const { text, sha } = await fetchAuditLogRaw(settings, branch);
  const withTrailingNewline = text.length > 0 && !text.endsWith('\n') ? `${text}\n` : text;
  const payload: Record<string, unknown> = {
    message: 'Design Sync: record audit entry',
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

// Rewrites just the LAST line of audit-log.jsonl with the real PR
// number/URL, once the PR that appendAuditLogEntry's placeholder was
// waiting on actually exists. Doesn't parse/touch any earlier lines
// (a malformed old line shouldn't block this any more than it blocks
// appendAuditLogEntry itself).
async function patchLastAuditLogEntry(settings: GithubSettings, branch: string, prNumber: number, prUrl: string): Promise<void> {
  const { text, sha } = await fetchAuditLogRaw(settings, branch);
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return; // nothing to patch — shouldn't happen, but not fatal if it does
  const last = JSON.parse(lines[lines.length - 1]) as AuditEntry;
  last.prNumber = prNumber;
  last.prUrl = prUrl;
  lines[lines.length - 1] = JSON.stringify(last);
  const payload: Record<string, unknown> = {
    message: `Design Sync: link audit entry to PR #${prNumber}`,
    content: encodeBase64Utf8(`${lines.join('\n')}\n`),
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
    throw new Error(`Linking audit entry to PR failed: ${res.status} ${body.message ?? res.statusText}`);
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

// Shared "Copy" button — icon swaps to a checkmark on success (or an X on
// failure) for ~1.5s instead of the old text-only "Copy" → "Copied!" swap,
// which read as a plain state change rather than a confirmation.
function copyButton(text: string): HTMLButtonElement {
  const idleContent = (): (Node | string)[] => [icon('Copy', undefined, 13), 'Copy'];
  const btn = el('button', {}, idleContent());
  btn.onclick = async () => {
    const ok = await copyToClipboard(text);
    btn.replaceChildren(...[icon(ok ? 'Check' : 'XCircle', undefined, 13), ok ? 'Copied!' : 'Copy failed']);
    setTimeout(() => btn.replaceChildren(...idleContent()), 1500);
  };
  return btn;
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

// Icon markup is a fixed, hand-authored constant (icons.ts) — never user
// input — so setting innerHTML here carries no injection risk. `size`
// matches the 16px default most UI text sits at; pass a larger value for
// the rare spot that needs one (none currently do).
function icon(name: IconName, className?: string, size?: number): HTMLElement {
  return el('span', { className: `icon${className ? ` ${className}` : ''}`, innerHTML: iconSvg(name, size) });
}

// Every status-banner call site used to build its own success/error <div>
// by hand — 13+ near-identical copies. Centralizing here means the
// icon-pairing (never convey status by color alone) only had to be added
// once, and can't drift out of sync between call sites.
const STATUS_BANNER_ICON: Record<'success' | 'error' | 'info', IconName> = {
  success: 'CheckCircle',
  error: 'XCircle',
  info: 'Info',
};
function statusBanner(kind: 'success' | 'error' | 'info', children: (Node | string)[]): HTMLElement {
  return el('div', { className: `status-banner ${kind}` }, [
    icon(STATUS_BANNER_ICON[kind], 'status-banner-icon', 14),
    el('div', { className: 'status-banner-content' }, children),
  ]);
}

// A small scannable fact chip (a filename, a permission scope) — pairs a
// short visible label with an optional data-tip carrying the "why", instead
// of writing the why out as prose next to it.
function tag(text: string, tip?: string): HTMLElement {
  const t = el('span', { className: 'tag' }, [text]);
  if (tip) t.setAttribute('data-tip', tip);
  return t;
}

// A link to a PR always leaves the plugin — the external-link icon signals
// that before the click, rather than a bare "PR #12" that looks like it
// might do something in-place.
function prLink(url: string, number: number): HTMLElement {
  return el('a', { href: url, target: '_blank', className: 'pr-link' }, [`PR #${number}`, icon('ArrowSquareOut', undefined, 11)]);
}

// Every "Checking…"/"Loading…"/"Triggering…" button used to be plain text
// with no motion feedback at all. A spun CircleNotch replaces that — used
// as button *children*, not textContent, so el()'s Object.assign(node,
// props) can't be used for the loading label itself.
function loadingLabel(loading: boolean, loadingText: string, idleText: string): (Node | string)[] {
  return loading ? [icon('CircleNotch', 'spin', 13), loadingText] : [idleText];
}

// <details>'s open/closed state is native DOM state, toggled by the browser
// directly — it never goes through this app's own render() cycle, so a
// caret icon set once at creation would go stale the first time someone
// clicks it. Listens to the native 'toggle' event instead of re-deriving
// on every render.
function detailsSummary(details: HTMLDetailsElement, children: (Node | string)[]): HTMLElement {
  const caret = icon(details.open ? 'CaretDown' : 'CaretRight', 'caret', 11);
  details.addEventListener('toggle', () => {
    caret.innerHTML = iconSvg(details.open ? 'CaretDown' : 'CaretRight', 11);
  });
  return el('summary', {}, [caret, ...children]);
}

// Every collapsible section in the app should go through this rather than
// a bare el('details', ...) — plain <details> visually snaps shut the
// moment anything inside it (or anywhere else on the tab) triggers
// render(), since render() rebuilds the whole container from fresh DOM
// nodes and native <details> state lives only on the node instance. `id`
// must be stable and unique per accordion (e.g. include a category/index
// for anything rendered in a loop) — it's the key into state.openDetails.
// `defaultOpen` only applies the FIRST time this id is ever seen; once a
// user toggles it, their choice is what persists, not the default.
function persistentDetails(id: string, defaultOpen: boolean, className: string, summaryChildren: (Node | string)[]): HTMLDetailsElement {
  const open = state.openDetails[id] ?? defaultOpen;
  const details = el('details', { className, open }) as HTMLDetailsElement;
  details.appendChild(detailsSummary(details, summaryChildren));
  details.addEventListener('toggle', () => {
    state.openDetails[id] = details.open;
  });
  return details;
}

function diffValueLine(label: 'Figma' | 'GitHub', display: string, isRef: boolean): HTMLElement {
  // FigmaLogo/GithubLogo used only to identify which side a value came
  // from — nominative use (naming the actual product), not an endorsement
  // claim, same convention as any "open in GitHub" icon button.
  const labelIcon: IconName = label === 'Figma' ? 'FigmaLogo' : 'GithubLogo';
  const children: (Node | string)[] = [
    el('span', { className: `diff-value-label ${label.toLowerCase()}` }, [icon(labelIcon, undefined, 11), label]),
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

// Shown above whichever tab is active — a plugin update isn't specific to
// any one tab. Returns null (renders nothing) once there's no newer version,
// or once the user has already dismissed this exact version — dismissing
// only suppresses THIS version's banner, a later release shows its own.
function renderUpdateBanner(): HTMLElement | null {
  const release = state.latestPluginRelease;
  if (!release || release.version === state.dismissedUpdateVersion) return null;

  const dismissBtn = el('button', { className: 'icon-btn' }, [icon('XCircle', undefined, 13)]);
  dismissBtn.setAttribute('data-tip', 'Dismiss until the next release');
  dismissBtn.setAttribute('aria-label', 'Dismiss until the next release');
  dismissBtn.onclick = () => {
    state.dismissedUpdateVersion = release.version;
    postToPlugin({ type: 'save-dismissed-update-version', version: release.version });
    render();
  };

  const headline = el('div', { className: 'update-banner-headline' }, [
    el('span', {}, [`Design Sync v${release.version} is available `]),
    el('span', { className: 'hint' }, [`(you're on v${__APP_VERSION__})`]),
    dismissBtn,
  ]);

  const content: (Node | string)[] = [headline];

  if (release.changelogEntry) {
    const details = persistentDetails(`update-${release.version}`, false, 'setup-guide nested', ["What's new"]);
    details.appendChild(el('pre', {}, [release.changelogEntry]));
    content.push(details);
  }

  // Honest about the actual constraint (README §4 / every other "can't
  // automate this" moment in this app): there is no one-click update in
  // this distribution mode, only a pointer to what to do manually.
  content.push(
    el('p', { className: 'hint' }, [
      'This plugin has no auto-update — pull the latest code, rebuild, then fully close and relaunch the plugin (not just this panel) to pick it up.',
    ]),
  );

  return statusBanner('info', content);
}

function render() {
  document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === state.activeTab);
  });
  const root = panel();
  root.innerHTML = '';
  const updateBanner = renderUpdateBanner();
  if (updateBanner) root.appendChild(updateBanner);
  if (state.activeTab === 'connect') root.appendChild(renderConnectTab());
  if (state.activeTab === 'tokens') root.appendChild(renderTokensTab());
  if (state.activeTab === 'sync') root.appendChild(renderSyncTab());
  if (state.activeTab === 'status') root.appendChild(renderStatusTab());
  if (state.activeTab === 'history') root.appendChild(renderHistoryTab());
}

// Compact "already connected" state — replaces the full form once
// configured, so returning to this tab day-to-day shows 2 lines instead of
// the entire setup flow. Test/Edit are icon-only, so both need an explicit
// aria-label (the accessibility rule this whole revamp leaned on: icon
// buttons without a label are a High-severity anti-pattern).
// Single shared header for all three Connect-tab states — same code path,
// not just similar CSS, so the row a user sees never actually changes shape
// or position when the state underneath it does. Mirrors the principle
// details.setup-guide already uses (fixed frame, swappable content), one
// level up: the panel and this header never disappear, only what's inside
// and below them does.
function renderConnectHeader(kind: 'setup' | 'editing' | 'connected', settings: GithubSettings | null): HTMLElement {
  if (kind === 'connected' && settings) {
    const testBtn = el('button', {}, [icon('Pulse', undefined, 13), 'Test']);
    testBtn.onclick = async () => {
      testBtn.replaceChildren(icon('CircleNotch', 'spin', 13), 'Test');
      testBtn.setAttribute('disabled', 'true');
      state.connectStatus = await testConnection(settings);
      render();
    };
    const editBtn = el('button', {}, [icon('PencilSimple', undefined, 13), 'Edit']);
    editBtn.onclick = () => {
      state.connectEditing = true;
      state.connectStatus = null;
      render();
    };
    return el('div', { className: 'connect-header' }, [
      icon('CheckCircle', 'connect-header-icon connected', 20),
      el('div', { className: 'connect-header-text' }, [
        el('strong', {}, [`${settings.owner}/${settings.repo}`]),
        el('span', { className: 'connect-header-detail' }, [`· ${settings.branch}`]),
      ]),
      el('div', { className: 'connect-header-actions' }, [testBtn, editBtn]),
    ]);
  }
  return el('div', { className: 'connect-header' }, [
    icon('GithubLogo', 'connect-header-icon', 20),
    el('div', { className: 'connect-header-text' }, [
      kind === 'editing' ? 'Update your GitHub connection' : 'Link a GitHub repo to keep tokens in sync',
    ]),
  ]);
}

// The setup/edit form — shown when not yet configured, or when Edit was
// clicked on the compact card. Condensed from the original 3-section
// always-expanded layout: the token's permission requirements and the
// owner/repo/branch/path fields both move behind collapsed disclosures,
// since the search-driven flow (the common path) never needs to touch
// them directly.
function renderConnectForm(container: HTMLElement): void {
  const s = state.settings ?? { owner: '', repo: '', branch: 'main', path: 'design-tokens.json', token: '' };
  const wasConfigured = isConfigured(state.settings);

  const ownerInput = el('input', { type: 'text', placeholder: 'octocat', value: s.owner });
  const repoInput = el('input', { type: 'text', placeholder: 'design-system', value: s.repo });
  const branchInput = el('input', { type: 'text', placeholder: 'main', value: s.branch });
  const pathInput = el('input', { type: 'text', placeholder: 'design-tokens.json', value: s.path });
  const tokenInput = el('input', { type: 'password', placeholder: 'ghp_...', value: s.token });
  // Validates the token AND reveals the repo step in one move — reuses the
  // same call the reload button makes, just triggered by leaving the field
  // instead of requiring a separate click. Guarded so repeated blurs on an
  // unchanged value don't refire the request every time.
  let lastCheckedToken = s.token;
  tokenInput.addEventListener('blur', () => {
    const value = tokenInput.value.trim();
    if (value && value !== lastCheckedToken) {
      lastCheckedToken = value;
      loadUserRepos(value);
    }
  });
  // Repo step stays hidden until there's something to show — one decision
  // at a time instead of a full form dumped up front. Already-configured
  // connections (editing) skip straight past this since the fields are
  // already filled in.
  const showRepoStep = wasConfigured || state.loadingRepos || state.availableRepos.length > 0 || !!state.reposError;

  const requiredLabel = (text: string) => el('label', {}, [text, el('span', { className: 'required-mark' }, ['*'])]);
  const row = (labelText: string, input: HTMLElement) =>
    el('div', { className: 'field' }, [el('label', {}, [labelText]), input]);
  const requiredRow = (labelText: string, input: HTMLElement) =>
    el('div', { className: 'field' }, [requiredLabel(labelText), input]);

  // --- Token ---
  const tokenLabelRow = requiredRow('Personal access token', tokenInput);
  container.appendChild(tokenLabelRow);
  // Verified once a token has successfully listed repos — a quiet inline
  // confirmation instead of a separate click, replacing itself the moment
  // the token changes again (loadUserRepos clears availableRepos on error).
  if (state.availableRepos.length > 0 && !state.reposError) {
    tokenLabelRow.querySelector('label')?.appendChild(
      el('span', { className: 'field-verified' }, [icon('CheckCircle', undefined, 11), 'Verified']),
    );
  }
  container.appendChild(
    el('p', { className: 'trust-badge' }, [icon('CheckCircle', undefined, 12), 'Stored locally, never uploaded except to api.github.com']),
  );
  const permsDetails = persistentDetails('connect-permissions', false, 'setup-guide nested', ['What permissions does this need?']);
  permsDetails.appendChild(
    el('div', {}, [
      el('p', { className: 'hint' }, ['Fine-grained token, scoped to one repo.']),
      el('div', { className: 'tag-row' }, [
        tag('Contents: read/write', 'Reading and committing tokens'),
        tag('Pull requests: read/write', 'Sync opens a PR'),
        tag('Actions: read/write', 'Only for Status tab\'s "Rebuild Storybook" and "Send test notification"'),
        tag('Pages: read-only', 'Only to check whether a deployed Storybook build exists'),
      ]),
    ]),
  );
  container.appendChild(permsDetails);

  if (!showRepoStep) {
    container.appendChild(el('p', { className: 'hint' }, ['Paste a token above to find your repo.']));
  } else {
  container.appendChild(el('hr', { className: 'section-divider' }));

  // --- Repo search (the default path) ---
  container.appendChild(el('label', {}, ['Find your repository']));
  // A native <input list> + <datalist> combo used to drive this — inside a
  // Figma plugin's sandboxed iframe, the browser-native popup was unreliable
  // and would vanish as soon as the user kept typing or the input regained
  // focus. Rendered by hand instead so open/close is fully in our control.
  const searchWrap = el('div', { className: 'repo-search-wrap' });
  const repoSearchInput = el('input', {
    type: 'text',
    autocomplete: 'off',
    placeholder: state.loadingRepos ? 'Loading…' : 'Search or pick from the list',
  });
  if (state.loadingRepos) repoSearchInput.setAttribute('disabled', 'true');

  const applyMatch = (match: RepoOption) => {
    repoSearchInput.value = match.fullName;
    ownerInput.value = match.owner;
    repoInput.value = match.name;
    if (!branchInput.value.trim()) branchInput.value = match.defaultBranch;
  };

  const menu = el('div', { className: 'repo-search-menu' });
  menu.style.display = 'none';
  const hideMenu = () => {
    menu.style.display = 'none';
  };
  const showMenu = () => {
    const query = repoSearchInput.value.trim().toLowerCase();
    const matches = query ? state.availableRepos.filter((r) => r.fullName.toLowerCase().includes(query)) : state.availableRepos;
    menu.innerHTML = '';
    if (matches.length === 0) {
      menu.appendChild(
        el('div', { className: 'repo-search-empty' }, [
          state.availableRepos.length === 0 ? 'No repos loaded yet — click the reload button to fetch.' : 'No matches.',
        ]),
      );
    } else {
      for (const repo of matches.slice(0, 30)) {
        const option = el('div', { className: 'repo-search-option' }, [repo.fullName]);
        // mousedown (not click) fires before the input's blur handler, so
        // the selection lands before hideMenu() would otherwise beat it.
        option.addEventListener('mousedown', (e) => {
          e.preventDefault();
          applyMatch(repo);
          hideMenu();
        });
        menu.appendChild(option);
      }
    }
    menu.style.display = '';
  };
  repoSearchInput.oninput = () => {
    const match = state.availableRepos.find((r) => r.fullName === repoSearchInput.value);
    if (match) applyMatch(match);
    showMenu();
  };
  repoSearchInput.addEventListener('focus', () => showMenu());
  repoSearchInput.addEventListener('blur', () => hideMenu());
  repoSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideMenu();
  });
  searchWrap.appendChild(repoSearchInput);
  searchWrap.appendChild(menu);

  const loadReposBtn = el(
    'button',
    { className: 'icon-btn' },
    state.loadingRepos ? [icon('CircleNotch', 'spin', 13)] : [icon('ArrowsClockwise', undefined, 13)],
  );
  loadReposBtn.setAttribute('data-tip', 'Fetch every repo this token can see');
  loadReposBtn.setAttribute('aria-label', 'Load my repos');
  if (state.loadingRepos) loadReposBtn.setAttribute('disabled', 'true');
  loadReposBtn.onclick = () => loadUserRepos(tokenInput.value.trim());
  container.appendChild(el('div', { className: 'btn-row' }, [searchWrap, loadReposBtn]));
  if (state.reposError) {
    container.appendChild(statusBanner('error', [state.reposError]));
  } else if (state.availableRepos.length > 0) {
    container.appendChild(
      el('p', { className: 'hint' }, [`${state.availableRepos.length} repositor${state.availableRepos.length === 1 ? 'y' : 'ies'} loaded.`]),
    );
  }

  // --- Manual entry (escape hatch — open by default only when there's
  // nothing to show yet, i.e. no owner/repo set and search hasn't been
  // used; otherwise collapsed, since search already filled them in) ---
  const manualDetails = persistentDetails(
    'connect-manual-entry',
    !s.owner.trim() && !s.repo.trim(),
    'manual-entry-link',
    ['Enter repository manually'],
  );
  const manualBody = el('div', {});
  manualBody.appendChild(requiredRow('Repository owner', ownerInput));
  manualBody.appendChild(requiredRow('Repository name', repoInput));
  manualBody.appendChild(el('div', { className: 'row' }, [row('Branch', branchInput), row('Token file path', pathInput)]));
  manualDetails.appendChild(manualBody);
  container.appendChild(manualDetails);
  }

  const readSettings = (): GithubSettings => ({
    owner: ownerInput.value.trim(),
    repo: repoInput.value.trim(),
    branch: branchInput.value.trim() || 'main',
    path: pathInput.value.trim() || 'design-tokens.json',
    token: tokenInput.value.trim(),
  });

  // Connect = save + test in one step. Jumps to Sync only on a VERIFIED
  // successful connection — the old Save button jumped unconditionally
  // once fields were non-empty, even with an invalid token, dumping you
  // onto an empty/broken Sync tab. On failure, stays put with the same
  // error + permission-fix guide Test connection already showed.
  const connectBtn = el('button', { className: 'primary' }, ['Connect']);
  connectBtn.onclick = async () => {
    connectBtn.replaceChildren(...loadingLabel(true, 'Connecting…', 'Connect'));
    connectBtn.setAttribute('disabled', 'true');
    state.settings = readSettings();
    postToPlugin({ type: 'save-settings', settings: state.settings });
    state.connectStatus = await testConnection(state.settings);
    if (state.connectStatus.ok && isConfigured(state.settings)) {
      // A beat before jumping tabs — makes the connection land as a moment
      // instead of an instant, silent redirect. The pulse itself is
      // decorative (CSS gates it under prefers-reduced-motion) but the
      // pause is pacing, not decoration, so it stays either way.
      connectBtn.replaceChildren(icon('CheckCircle', undefined, 13), 'Connected');
      connectBtn.classList.add('btn-success-pulse');
      await new Promise((resolve) => setTimeout(resolve, 450));
      state.connectEditing = false;
      // Don't make them reopen the plugin to see the diff — jump straight
      // to Sync and run the comparison now that we have everything we need.
      state.activeTab = 'sync';
      render();
      runCompare();
      return;
    }
    connectBtn.replaceChildren(...loadingLabel(false, 'Connecting…', 'Connect'));
    connectBtn.removeAttribute('disabled');
    render();
  };

  // Test connection stays available independently — Connect bundles a test
  // in for first-time setup, but re-testing without touching other fields
  // (e.g. after rotating the token) is still a real, separate need.
  const testBtn = el('button', {}, ['Test connection']);
  testBtn.onclick = async () => {
    testBtn.replaceChildren(...loadingLabel(true, 'Testing…', 'Test connection'));
    testBtn.setAttribute('disabled', 'true');
    state.connectStatus = await testConnection(readSettings());
    testBtn.replaceChildren(...loadingLabel(false, 'Testing…', 'Test connection'));
    testBtn.removeAttribute('disabled');
    render();
  };

  const actionsRow = el('div', { className: 'btn-row' }, [connectBtn, testBtn]);
  if (wasConfigured) {
    const cancelBtn = el('button', {}, ['Cancel']);
    cancelBtn.onclick = () => {
      state.connectEditing = false;
      state.connectStatus = null;
      render();
    };
    actionsRow.appendChild(cancelBtn);
  }
  container.appendChild(actionsRow);

  if (state.connectStatus) {
    container.appendChild(statusBanner(state.connectStatus.ok ? 'success' : 'error', [state.connectStatus.message]));
    if (!state.connectStatus.ok) {
      const guide = renderPermissionErrorGuide(state.connectStatus.message, 'connect');
      if (guide) container.appendChild(guide);
    }
  }
}

// Always-available history, collapsed by default — was an always-visible
// list even for someone who never looks at it. No accordion at all when
// there's nothing to show, rather than a pointless empty trigger.
function renderRecentActivity(): HTMLElement | null {
  if (state.history.length === 0) return null;
  const details = persistentDetails('recent-activity', false, 'setup-guide', [`Recent activity (${Math.min(state.history.length, 5)})`]);
  const body = el('div', {});
  for (const entry of state.history.slice(0, 5)) {
    body.appendChild(
      el('div', { className: 'history-item' }, [`${new Date(entry.timestamp).toLocaleString()} — `, prLink(entry.prUrl, entry.prNumber)]),
    );
  }
  details.appendChild(body);
  return details;
}

function renderConnectTab(): HTMLElement {
  const container = el('div');
  container.appendChild(el('h2', {}, ['Connect']));

  // One panel, one header, for every state — the header's own code path is
  // identical whether setting up, editing, or already connected, so the
  // frame around it never has to disappear and reappear as something else.
  const connected = isConfigured(state.settings) && !state.connectEditing;
  const kind: 'setup' | 'editing' | 'connected' = connected ? 'connected' : state.connectEditing ? 'editing' : 'setup';
  const panel = el('div', { className: 'connect-panel' });
  panel.appendChild(renderConnectHeader(kind, state.settings));
  if (connected) {
    if (state.connectStatus) {
      panel.appendChild(statusBanner(state.connectStatus.ok ? 'success' : 'error', [state.connectStatus.message]));
    }
  } else {
    renderConnectForm(panel);
  }
  container.appendChild(panel);

  const activity = renderRecentActivity();
  if (activity) container.appendChild(activity);

  if (isConfigured(state.settings)) {
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
  const content: (Node | string)[] = [
    el('div', {}, [
      `${state.validationErrors.length} token reference problem${state.validationErrors.length === 1 ? '' : 's'} — these specific tokens need a manual choice below, everything else will sync normally:`,
    ]),
  ];
  const list = el('ul');
  for (const e of state.validationErrors.slice(0, 10)) {
    list.appendChild(el('li', {}, [`${e.source} · ${e.category}/${e.key} — ${e.message}`]));
  }
  content.push(list);
  if (state.validationErrors.length > 10) {
    content.push(el('div', {}, [`…and ${state.validationErrors.length - 10} more.`]));
  }
  return statusBanner('error', content);
}

function renderSyncTab(): HTMLElement {
  const container = el('div');

  if (!isConfigured(state.settings)) {
    container.appendChild(el('div', { className: 'empty-state' }, ['Set up your GitHub repository in the Connect tab first.']));
    return container;
  }

  container.appendChild(el('h2', {}, ['Sync']));

  const compareBtn = el(
    'button',
    { className: 'primary' },
    loadingLabel(state.comparing, 'Comparing…', state.diff.length ? 'Re-fetch & compare' : 'Fetch & compare'),
  );
  if (!state.comparing) compareBtn.prepend(icon('ArrowsClockwise', undefined, 13));
  if (state.comparing) compareBtn.setAttribute('disabled', 'true');
  compareBtn.onclick = () => runCompare();
  container.appendChild(el('div', { className: 'btn-row' }, [compareBtn]));

  if (state.syncError) {
    container.appendChild(statusBanner('error', [state.syncError]));
    const guide = renderPermissionErrorGuide(state.syncError, 'sync');
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
      container.appendChild(statusBanner('success', ['Figma and GitHub are already in sync.']));
    } else {
      const addedCount = changed.filter((d) => d.status !== 'modified').length;
      const conflictCount = changed.filter((d) => d.status === 'modified' && !d.cascadeOnly).length;

      if (addedCount > 0) {
        const selectRow = el('div', { className: 'btn-row' });
        const selectAll = el('button', { className: 'primary' }, ['Select all']);
        selectAll.onclick = () => {
          for (const d of changed) {
            if (d.status !== 'modified') delete state.resolutions[`${d.category}:${d.key}`];
          }
          render();
        };
        const selectNone = el('button', {}, ['Deselect all']);
        selectNone.onclick = () => {
          for (const d of changed) {
            if (d.status !== 'modified') state.resolutions[`${d.category}:${d.key}`] = 'skip';
          }
          render();
        };
        const countTag = el('span', { className: 'tag' }, [`${addedCount} new`]);
        const infoIcon = icon('Info', 'info-hint', 12);
        infoIcon.title = 'New tokens (from either side) are included by default — uncheck individual rows below, or use these to bulk-select.';
        selectRow.append(selectAll, selectNone, countTag, infoIcon);
        container.appendChild(selectRow);
      }

      if (conflictCount > 0) {
        const bulkRow = el('div', { className: 'btn-row' });
        const useAllFigma = el('button', {}, [icon('FigmaLogo', undefined, 12), 'Use all Figma']);
        useAllFigma.onclick = () => {
          for (const d of changed) if (d.status === 'modified' && !d.cascadeOnly) state.resolutions[`${d.category}:${d.key}`] = 'figma';
          render();
        };
        const useAllGithub = el('button', {}, [icon('GithubLogo', undefined, 12), 'Use all GitHub']);
        useAllGithub.onclick = () => {
          for (const d of changed) if (d.status === 'modified' && !d.cascadeOnly) state.resolutions[`${d.category}:${d.key}`] = 'github';
          render();
        };
        const countTag = el('span', { className: 'tag' }, [`${conflictCount} conflict${conflictCount === 1 ? '' : 's'}`]);
        bulkRow.append(useAllFigma, useAllGithub, countTag);
        container.appendChild(bulkRow);
      }

      for (const category of TOKEN_CATEGORIES) {
        const rows = changed.filter((d) => d.category === category).sort((a, b) => diffRowPriority(a) - diffRowPriority(b));
        if (rows.length === 0) continue;
        const group = el('div', { className: 'diff-group' });
        group.appendChild(el('h2', {}, [category, el('span', { className: 'tag' }, [String(rows.length)])]));
        // cascadeOnly rows have nothing to decide (see 1.4.2) — clicking any
        // button on them is a no-op, so showing each one at full size just
        // pads out the list a reviewer actually has to scroll through.
        // Collapsed into one summary per category instead of dropped
        // entirely, since they're still worth being able to check.
        const actionable = rows.filter((d) => !d.cascadeOnly);
        const cascade = rows.filter((d) => d.cascadeOnly);
        for (const d of actionable) group.appendChild(renderDiffRow(d));
        if (cascade.length > 0) group.appendChild(renderCascadeGroup(cascade));
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
      const syncBtn = el(
        'button',
        { className: 'cta' },
        loadingLabel(state.syncing, 'Opening pull request…', 'Sync (open PR & update Figma)'),
      );
      syncBtn.setAttribute(
        'data-tip',
        'Applies your resolutions to Figma immediately, and opens a pull request against ' +
          (state.settings?.branch ?? 'the configured branch') +
          ' — nothing is committed directly to that branch.',
      );
      if (!state.syncing) syncBtn.prepend(icon('ArrowsLeftRight', undefined, 13));
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

  if (state.log.length > 0) {
    // `defaultOpen: true` only applies the first time this id is ever seen
    // (persistentDetails) — which is the first render after a compare/sync
    // has actually started logging something, so it opens right when there's
    // something to watch. Once the user closes it, that choice persists
    // across the rest of this run and any future one.
    const logDetails = persistentDetails('sync-log', true, 'setup-guide', [icon('Pulse', undefined, 13), 'Activity log']);
    logDetails.appendChild(el('pre', { id: 'log', textContent: state.log.join('\n') }));
    container.appendChild(logDetails);
  }
  return container;
}

// cascadeOnly rows (see 1.4.2) have nothing to decide — clicking any button
// on them doesn't affect the sync. Collapsed by default, one compact line
// per row, instead of each getting the full renderDiffRow treatment
// (label chips, resolution controls' worth of vertical space, the
// explanatory note repeated N times) — that's what made a category with a
// handful of real conflicts scroll for pages once a token with many
// downstream references changed. Reuses the existing .setup-guide
// collapsible and .audit-change-row compact-list styling rather than
// introducing new CSS for a one-off.
function renderCascadeGroup(rows: DiffEntry[]): HTMLElement {
  const details = persistentDetails(`cascade-${rows[0]?.category ?? 'unknown'}`, false, 'setup-guide', [
    icon('ArrowsLeftRight', 'summary-icon', 13),
    `${rows.length} more auto-resolve — no action needed`,
  ]);
  const body = el('div', {});
  body.appendChild(
    el('p', { className: 'hint' }, [
      "These reference a token above and update automatically once it's resolved — nothing to decide here.",
    ]),
  );
  for (const d of rows) {
    body.appendChild(
      el('div', { className: 'audit-change-row' }, [
        el('div', { className: 'audit-change-key' }, [d.key]),
        el('div', { className: 'audit-change-values' }, [`${d.figmaDisplay} → ${d.githubDisplay}`]),
      ]),
    );
  }
  details.appendChild(body);
  return details;
}

// Only ever called with actionable rows (cascadeOnly ones get the compact
// collapsed treatment in renderCascadeGroup instead) — no cascadeOnly
// branching needed here.
function renderDiffRow(d: DiffEntry): HTMLElement {
  const row = el('div', { className: `diff-row status-${d.status}` });
  const badgeText = { 'added-figma': 'New in Figma', 'added-github': 'New in GitHub', modified: 'Conflict', unchanged: '' }[d.status];
  const badgeIcon: IconName = d.status === 'modified' ? 'WarningCircle' : 'PlusCircle';
  row.appendChild(
    el('div', { className: 'diff-key' }, [d.key, el('span', { className: 'diff-badge' }, [icon(badgeIcon, undefined, 10), badgeText])]),
  );
  row.appendChild(
    el('div', { className: 'diff-values' }, [
      diffValueLine('Figma', d.figmaDisplay, isReferenceToken(d.figmaValue)),
      diffValueLine('GitHub', d.githubDisplay, isReferenceToken(d.githubValue)),
    ]),
  );

  if (d.status === 'modified') {
    const resKey = `${d.category}:${d.key}`;
    const current = state.resolutions[resKey];
    const toggle = el('div', { className: 'resolution-toggle' });
    for (const [value, cls, label, iconName] of [
      ['figma', 'figma', 'Use Figma', 'FigmaLogo'],
      ['github', 'github', 'Use GitHub', 'GithubLogo'],
      ['skip', 'skip', 'Skip', 'XCircle'],
    ] as [Resolution, string, string, IconName][]) {
      const btn = el('button', { type: 'button', className: cls }, [icon(iconName, undefined, 12)]);
      btn.setAttribute('data-tip', label);
      btn.setAttribute('aria-label', label);
      if (current === value) btn.classList.add('active');
      btn.onclick = () => {
        state.resolutions[resKey] = value;
        render();
      };
      toggle.appendChild(btn);
    }
    row.appendChild(toggle);
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

const STORYBOOK_STATUS_COPY: Record<StorybookStatus, { cls: 'success' | 'error'; text: (() => string) | string }> = {
  unknown: { cls: 'error', text: '' }, // unreachable — render site below is guarded by `!== 'unknown'`
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
function renderPermissionErrorGuide(error: string, contextId: string): HTMLElement | null {
  if (!/403|not accessible/i.test(error)) return null;

  const details = persistentDetails(`permission-guide-${contextId}`, true, 'setup-guide', ['How to fix this: grant the missing permission']);

  const body = el('div', {});
  body.appendChild(
    el('p', { className: 'hint' }, ['The GitHub token in the Connect tab is missing one of these:']),
  );
  body.appendChild(
    el('div', { className: 'tag-row' }, [
      tag('Contents: read/write', 'Reading and committing tokens'),
      tag('Pull requests: read/write', 'Sync opens a PR'),
      tag('Actions: read/write', 'Rebuild Storybook'),
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
  const details = persistentDetails('notifications', false, 'setup-guide', ['Notifications']);

  const body = el('div', {});
  body.appendChild(el('p', { className: 'hint' }, ['Posts a message when a sync lands. Set up either provider, or both.']));

  const teamsDetails = persistentDetails('notifications-teams', false, 'setup-guide nested', [
    icon('MicrosoftTeamsLogo', undefined, 13),
    'Microsoft Teams',
  ]);
  teamsDetails.appendChild(
    el('div', {}, [
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
    ]),
  );
  body.appendChild(teamsDetails);

  const slackDetails = persistentDetails('notifications-slack', false, 'setup-guide nested', [icon('SlackLogo', undefined, 13), 'Slack']);
  slackDetails.appendChild(
    el('div', {}, [
      el('pre', {}, [
        '1. api.slack.com/apps → Create New App → From scratch\n' +
          '2. Features → Incoming Webhooks → toggle on\n' +
          '3. Add New Webhook to Workspace → pick the channel → Allow\n' +
          '4. Copy the URL (starts hooks.slack.com/services/…)\n' +
          `5. github.com/${state.settings?.owner ?? '<owner>'}/${state.settings?.repo ?? '<repo>'}` +
          '/settings/secrets/actions → New repository secret\n' +
          '   Name: SLACK_WEBHOOK_URL — Value: the URL from step 4',
      ]),
    ]),
  );
  body.appendChild(slackDetails);
  body.appendChild(
    el('div', { className: 'tag-row' }, [
      tag('.github/workflows/notify-on-sync.yml', 'Required workflow file in the tokens repo'),
      tag('scripts/notify-on-sync.mjs', 'Required script in the tokens repo'),
    ]),
  );

  const testBtn = el('button', {}, loadingLabel(state.notifyTestSending, 'Sending…', 'Send test notification'));
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
    body.appendChild(statusBanner('error', [state.notifyTestError]));
    const guide = renderPermissionErrorGuide(state.notifyTestError, 'notify-test');
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

  const details = persistentDetails('storybook-guide', needsSetup, 'setup-guide', [
    icon('Info', undefined, 13),
    needsSetup ? 'How to set up Storybook for this repo' : 'How to update Storybook',
  ]);

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
        ' at the repo root — that\'s the file this plugin keeps synced.',
      ]),
    );
    const hookNote = el('span', { className: 'tip-note' }, ['not a postbuild hook']);
    hookNote.setAttribute(
      'data-tip',
      'A postbuild hook also fires on every CI validation build that never deploys — this Status tab would think a build is live when nothing was published.',
    );
    body.appendChild(
      el('p', { className: 'hint' }, [
        'Then add a script that writes ',
        el('code', {}, ['.storybook-sync.json']),
        ', called explicitly from your ',
        el('strong', {}, ['deploy']),
        ' workflow after Pages finishes deploying — ',
        hookNote,
        ':',
      ]),
    );
    body.appendChild(
      el('pre', {}, [`{ "tokensBlobSha": "<git hash-object ${settings?.path ?? 'design-tokens.json'}>", "builtAt": "<now>" }`]),
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

  container.appendChild(el('h2', {}, ['Status']));

  const refreshBtn = el('button', { className: 'primary' }, loadingLabel(state.comparing, 'Checking…', 'Refresh status'));
  if (!state.comparing) refreshBtn.prepend(icon('ArrowsClockwise', undefined, 13));
  if (state.comparing) refreshBtn.setAttribute('disabled', 'true');
  refreshBtn.onclick = () => runCompare();
  container.appendChild(el('div', { className: 'btn-row' }, [refreshBtn]));

  if (state.syncError) {
    container.appendChild(statusBanner('error', [state.syncError]));
    const guide = renderPermissionErrorGuide(state.syncError, 'status');
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
    statusBanner(pairsInSync === 2 ? 'success' : 'error', [
      pairsInSync === 2
        ? 'Figma, GitHub, and Storybook are all in sync.'
        : `${pairsInSync} of 2 sync relationships are up to date — see below.`,
    ]),
  );

  if (state.pendingPr) {
    const link = prLink(state.pendingPr.url, state.pendingPr.number);
    container.appendChild(
      statusBanner(
        state.pendingPr.state === 'open' ? 'info' : 'error',
        state.pendingPr.state === 'open'
          ? [link, ' is open and pending review. The differences below won\'t resolve until it\'s merged — that\'s expected, not an error.']
          : [link, ' was closed without merging. Re-run Sync below if these changes are still needed.'],
      ),
    );
  }

  container.appendChild(
    el('h2', { className: 'status-section-heading' }, [
      icon('FigmaLogo', undefined, 12),
      icon('GithubLogo', undefined, 12),
      'Figma ↔ GitHub',
      el('span', { className: 'tag' }, [figmaGithubInSync ? 'in sync' : `${outOfSync.length} differ`]),
    ]),
  );
  if (figmaGithubInSync) {
    container.appendChild(statusBanner('success', ['Every token matches between Figma and GitHub.']));
  } else {
    // First time this id is seen (i.e. the first render where there's
    // something to show), open by default — same rationale as Sync's
    // activity log. After that, whatever the user last set persists.
    const tableDetails = persistentDetails('status-diff-table', true, 'setup-guide', [
      `${outOfSync.length} token${outOfSync.length === 1 ? '' : 's'} differ`,
    ]);
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
    tableDetails.appendChild(table);
    container.appendChild(tableDetails);
  }

  const storybookHeading = el('h2', { className: 'status-section-heading' }, [
    icon('Pulse', undefined, 12),
    'GitHub ↔ Storybook',
    ...(state.storybookStatus !== 'unknown'
      ? [el('span', { className: 'tag' }, [state.storybookStatus === 'in-sync' ? 'in sync' : state.storybookStatus])]
      : []),
  ]);
  storybookHeading.style.marginTop = '18px';
  container.appendChild(storybookHeading);
  if (state.storybookStatus !== 'unknown') {
    const info = STORYBOOK_STATUS_COPY[state.storybookStatus];
    const text = typeof info.text === 'function' ? info.text() : info.text;
    container.appendChild(statusBanner(info.cls, [text]));
  }

  const viewBtn = el('button', {}, loadingLabel(state.checkingLocalStorybook, 'Checking…', 'View Storybook (local)'));
  viewBtn.setAttribute('data-tip', `Checks for a dev server at ${LOCAL_STORYBOOK_URL} and opens it if found — a plugin can't start the server itself.`);
  if (!state.checkingLocalStorybook) viewBtn.prepend(icon('ArrowSquareOut', undefined, 13));
  if (state.checkingLocalStorybook) viewBtn.setAttribute('disabled', 'true');
  viewBtn.onclick = () => viewLocalStorybook();

  const viewButtons = [viewBtn];
  // Checked against GET /repos/.../pages first (api.github.com — already an
  // allowed domain) rather than just opening the guessed URL and letting a
  // user hit a raw GitHub 404 page, which is exactly what prompted this.
  // pagesUrl (when present) is GitHub's own reported html_url — no guessing.
  if (state.pagesStatus === 'configured' && state.pagesUrl) {
    const deployedUrl = state.pagesUrl;
    const deployedBtn = el('button', {}, [icon('ArrowSquareOut', undefined, 13), 'View Storybook (deployed)']);
    deployedBtn.setAttribute(
      'data-tip',
      `Opens ${deployedUrl}${state.pagesLastBuildAt ? ` — last deployed ${new Date(state.pagesLastBuildAt).toLocaleString()}` : ''}`,
    );
    deployedBtn.onclick = () => postToPlugin({ type: 'open-external', url: deployedUrl });
    viewButtons.push(deployedBtn);
  }
  container.appendChild(el('div', { className: 'btn-row' }, viewButtons));
  if (state.pagesStatus === 'configured' && state.pagesLastBuildAt) {
    container.appendChild(el('p', { className: 'hint' }, [`Deployed build last updated ${new Date(state.pagesLastBuildAt).toLocaleString()}.`]));
  }

  if (state.pagesStatus !== 'configured') {
    // 'not-configured' (a genuine 404 from GitHub) and 'unknown' (the check
    // itself failed — network error, or a 403 from a PAT missing the
    // Pages:read scope) are deliberately shown the same way here: neither
    // one is confident enough to claim "definitely not deployed," so both
    // just point at the same setup guide rather than asserting something
    // that might be wrong.
    container.appendChild(
      el('p', { className: 'hint' }, [
        state.pagesStatus === 'unknown'
          ? "Couldn't confirm whether a deployed build exists (may need the Pages: read-only token permission — see below)."
          : 'No deployed build found yet.',
      ]),
    );
    const pagesGuide = persistentDetails('pages-setup-guide', false, 'setup-guide', ['How to enable GitHub Pages']);
    const pagesGuideBody = el('div', {});
    pagesGuideBody.appendChild(
      el('p', { className: 'hint' }, ['One-time setup — this plugin can\'t enable Pages itself, it needs repo-admin access this token deliberately doesn\'t request:']),
    );
    pagesGuideBody.appendChild(
      el('pre', {}, [
        `1. github.com/${state.settings?.owner}/${state.settings?.repo}/settings/pages\n2. Build and deployment → Source → GitHub Actions\n3. Run "Rebuild Storybook" below (or the "Deploy Storybook" workflow manually)`,
      ]),
    );
    pagesGuide.appendChild(pagesGuideBody);
    container.appendChild(pagesGuide);
  }

  if (state.localStorybookReachable === true) {
    container.appendChild(
      statusBanner('success', [`Found it running at ${LOCAL_STORYBOOK_URL} — opened in your browser.`]),
    );
  } else if (state.localStorybookReachable === false) {
    const repoName = state.settings?.repo ?? 'design-tokens';
    const command = `cd ${repoName}\nnpm run storybook`;
    container.appendChild(
      statusBanner('error', [`Nothing's listening at ${LOCAL_STORYBOOK_URL}. Run this in a terminal, then click the button again:`]),
    );
    const commandRow = el('div', { className: 'btn-row' });
    commandRow.appendChild(el('pre', {}, [command]));
    const copyBtn = copyButton(command);
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

  const deployBtn = el('button', { className: 'primary' }, loadingLabel(state.storybookDeploying, 'Triggering…', 'Rebuild Storybook'));
  deployBtn.setAttribute(
    'data-tip',
    state.storybookDeploying ? 'Deploy already in progress' : (deployDisabledReason ?? 'Rebuild and redeploy Storybook from the latest tokens on GitHub'),
  );
  if (!state.storybookDeploying) deployBtn.prepend(icon('ArrowsClockwise', undefined, 13));
  if (state.storybookDeploying || deployDisabledReason) deployBtn.setAttribute('disabled', 'true');
  deployBtn.onclick = () => deployStorybook();
  container.appendChild(el('div', { className: 'btn-row' }, [deployBtn]));
  if (deployDisabledReason && !state.storybookDeploying) {
    container.appendChild(el('p', { className: 'hint' }, [deployDisabledReason]));
  }

  if (state.storybookDeployMessage) {
    container.appendChild(statusBanner('success', [state.storybookDeployMessage]));
  }
  if (state.storybookDeployError) {
    container.appendChild(statusBanner('error', [state.storybookDeployError]));
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
  state.pagesError = null;
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
    const [figmaTokens, githubResult, marker, prStatus, pages] = await Promise.all([
      requestFigmaTokens(),
      fetchGithubTokens(settings),
      fetchStorybookMarker(settings).catch((err) => {
        state.storybookError = err instanceof Error ? err.message : String(err);
        return null;
      }),
      latestPr ? fetchPrStatus(settings, latestPr.prNumber).catch(() => null) : Promise.resolve(null),
      fetchPagesStatus(settings).catch((err) => {
        state.pagesError = err instanceof Error ? err.message : String(err);
        return null;
      }),
    ]);
    state.figmaTokens = figmaTokens;
    state.githubTokens = githubResult.tokens;
    state.githubSha = githubResult.sha;
    state.storybookMarker = marker;
    computeStorybookStatus();

    if (pages) {
      state.pagesStatus = pages.configured ? 'configured' : 'not-configured';
      state.pagesUrl = pages.url;
      state.pagesLastBuildAt = pages.lastBuildAt;
    } else {
      // Fetch failed (network error, or non-404 like a 403 from a missing
      // Pages:read scope) — 'unknown', not 'not-configured'; see the state
      // field's own comment for why that distinction matters here.
      state.pagesStatus = 'unknown';
    }

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

    // Every decision about whether to open a PR, whether to commit the
    // tokens file, what the audit entry contains, and what the PR body
    // says lives in planSync (sync-logic.ts) — extracted there, and
    // covered by tests, specifically because every one of the last three
    // production bugs (a 422 opening the PR, a sync invisible to
    // History/notifications, "0 changes" shown for a real Figma update)
    // was a mistake in exactly this logic when it lived inline here.
    const plan: SyncExecutionPlan = planSync(
      final,
      state.figmaTokens,
      state.githubTokens,
      figmaApply,
      state.resolutions,
      state.diff,
      settings.path,
    );

    let pr: { number: number; url: string } | null = null;
    if (plan.shouldOpenPr) {
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

      // Audit entry FIRST, with placeholder PR fields, patched to the real
      // values once the PR exists below. This ordering is deliberate, not
      // incidental: a real 422 ("No commits between main and
      // design-sync/...") was hit when the tokens file didn't need a
      // commit (shouldCommitTokens false) and nothing else had been
      // committed yet — GitHub refuses to open a PR from a branch with
      // zero commits ahead of base. This entry always has genuinely new
      // content (an appended line), so it's guaranteed to give the branch
      // a real commit before PR creation, regardless of whether the
      // tokens file itself changed.
      const timestamp = new Date().toISOString();
      const actor = await fetchGithubUsername(settings);
      appendLog('Recording this sync…');
      await appendAuditLogEntry(settings, branch, { timestamp, actor, prNumber: 0, prUrl: '', branch, changes: plan.changes });

      if (plan.shouldCommitTokens) {
        appendLog('Committing merged tokens to the new branch…');
        await commitGithubTokens(settings, final, state.githubSha, branch);
      }

      appendLog('Opening pull request…');
      try {
        pr = await createPullRequest(settings, branch, 'Design Sync: update design tokens', plan.prBody);
      } catch (err) {
        // The branch (+ commits above) already succeeded — leaving it
        // behind would just accumulate dead `design-sync/sync-*` branches
        // every time this fails (e.g. a PAT missing Pull requests: write).
        // Clean it up so a retry starts fresh instead of leaving orphans.
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

      // Link the audit entry committed above to the PR that now exists —
      // best-effort: a failed patch shouldn't fail a sync whose real work
      // (the PR, and the audit entry's actual content) has already
      // succeeded. Worst case, History shows this entry linked to PR #0
      // until manually corrected — cosmetic, not data loss.
      try {
        await patchLastAuditLogEntry(settings, branch, pr.number, pr.url);
      } catch (err) {
        appendLog(`Warning: linking the audit entry to PR #${pr.number} failed (${err instanceof Error ? err.message : String(err)}) — the sync itself still succeeded.`);
      }
    } else {
      appendLog('No changes needed — nothing to sync.');
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

// AuditChange.previousValue/newValue store the FULL DesignToken object
// ({$type, $value: {kind, value|refKey}, $extensions}) as written by
// computeAuditChanges — not a bare scalar. Extract just the resolved value
// (or "→ refKey" for a reference) instead of dumping the whole token as
// JSON, which is unreadable in a change list. Found and fixed the same bug
// in notify-on-sync.mjs's resolvedValueOf() at the same time.
function formatAuditValue(v: unknown): string {
  if (v === undefined) return '—';
  const token = v as DesignToken<unknown> | undefined;
  if (token && typeof token === 'object' && token.$value) {
    if (token.$value.kind === 'reference') return `→ ${token.$value.refKey}`;
    const val = token.$value.value;
    return typeof val === 'string' ? val : JSON.stringify(val);
  }
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function renderAuditChangeRow(c: AuditChange): HTMLElement {
  return el('div', { className: 'audit-change-row' }, [
    el('div', { className: 'audit-change-key' }, [`${c.category}/${c.key}`]),
    el('div', { className: 'audit-change-values' }, [`${formatAuditValue(c.previousValue)} → ${formatAuditValue(c.newValue)}`]),
  ]);
}

function renderHistoryTab(): HTMLElement {
  const container = el('div');

  if (!isConfigured(state.settings)) {
    container.appendChild(el('div', { className: 'empty-state' }, ['Set up your GitHub repository in the Connect tab first.']));
    return container;
  }

  container.appendChild(el('h2', {}, ['History']));

  const loadBtn = el('button', { className: 'primary' }, loadingLabel(state.auditLogLoading, 'Loading…', 'Load history'));
  if (!state.auditLogLoading) loadBtn.prepend(icon('ArrowsClockwise', undefined, 13));
  if (state.auditLogLoading) loadBtn.setAttribute('disabled', 'true');
  loadBtn.onclick = () => loadAuditLog();
  container.appendChild(el('div', { className: 'btn-row' }, [loadBtn]));

  if (state.auditLogError) {
    container.appendChild(statusBanner('error', [state.auditLogError]));
    const guide = renderPermissionErrorGuide(state.auditLogError, 'history');
    if (guide) container.appendChild(guide);
  }
  if (state.syncError) {
    container.appendChild(statusBanner('error', [state.syncError]));
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
    item.appendChild(el('div', { className: 'diff-key' }, [`${new Date(entry.timestamp).toLocaleString()} — ${entry.actor}`]));
    item.appendChild(el('p', { className: 'hint' }, [prLink(entry.prUrl, entry.prNumber)]));

    const changesDetails = persistentDetails(`history-changes-${entry.timestamp}`, false, 'setup-guide', [
      `${entry.changes.length} change${entry.changes.length === 1 ? '' : 's'}`,
    ]);
    const changesBody = el('div', { className: 'diff-values' });
    for (const c of entry.changes) changesBody.appendChild(renderAuditChangeRow(c));
    changesDetails.appendChild(changesBody);
    item.appendChild(changesDetails);

    const controls = el('div', { className: 'resolution-controls' });
    const revertBtn = el(
      'button',
      {},
      reverting
        ? [icon('CircleNotch', 'spin', 13), 'Reverting…']
        : [icon('ArrowCounterClockwise', undefined, 13), 'Revert this sync'],
    );
    revertBtn.setAttribute(
      'data-tip',
      canRevert
        ? 'Opens a new pull request restoring every token in this entry to its previous value.'
        : "This sync added new tokens — revert isn't supported for additions yet. Remove them directly in GitHub if needed.",
    );
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

// Tab icons are injected here rather than duplicated as static SVG markup
// in ui.template.html — icons.ts stays the single source of truth for what
// each icon actually looks like.
const TAB_ICONS: Record<Tab, IconName> = {
  connect: 'Plug',
  tokens: 'PencilSimple',
  sync: 'ArrowsClockwise',
  status: 'Pulse',
  history: 'ClockCounterClockwise',
};

document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach((btn) => {
  const tab = btn.dataset.tab as Tab | undefined;
  if (tab && TAB_ICONS[tab]) {
    const label = btn.textContent ?? '';
    btn.textContent = '';
    btn.appendChild(icon(TAB_ICONS[tab], undefined, 18));
    btn.appendChild(el('span', { textContent: label }));
  }
  btn.onclick = () => {
    state.activeTab = tab ?? 'connect';
    render();
  };
});

const appLogo = document.querySelector('.app-logo');
if (appLogo) appLogo.replaceWith(icon('ArrowsClockwise', 'app-logo', 14));

postToPlugin({ type: 'ui-ready' });
render();
