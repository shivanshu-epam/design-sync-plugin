// Design Sync — plugin UI thread.
//
// Owns all GitHub network access (the Figma sandbox in code.ts has none),
// the diff/conflict-resolution engine, and every panel's DOM. Talks to
// code.ts purely via postMessage.

import type {
  DimensionTokenValue,
  GithubSettings,
  PluginToUIMessage,
  StorybookSyncMarker,
  SyncHistoryEntry,
  TokenCategory,
  TokenSet,
  UIToPluginMessage,
} from './shared/tokens';
import { emptyTokenSet, TOKEN_CATEGORIES } from './shared/tokens';

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
let applyResultResolver: ((result: { success: boolean; error?: string }) => void) | null = null;

function requestFigmaTokens(): Promise<TokenSet> {
  return new Promise((resolve) => {
    figmaTokensResolver = resolve;
    postToPlugin({ type: 'request-figma-tokens' });
  });
}

function applyTokensToFigma(tokens: TokenSet): Promise<{ success: boolean; error?: string }> {
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
        requestFigmaTokens().then((tokens) => {
          state.figmaTokens = tokens;
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

type Resolution = 'figma' | 'github' | 'skip';
type Tab = 'connect' | 'tokens' | 'sync' | 'status';
type StorybookStatus = 'unknown' | 'in-sync' | 'stale' | 'never-built' | 'error';

interface DiffEntry {
  category: TokenCategory;
  key: string;
  figmaValue: unknown;
  githubValue: unknown;
  status: 'added-figma' | 'added-github' | 'modified' | 'unchanged';
}

const state: {
  activeTab: Tab;
  settings: GithubSettings | null;
  history: SyncHistoryEntry[];
  figmaTokens: TokenSet;
  githubTokens: TokenSet;
  githubSha: string | null;
  diff: DiffEntry[];
  resolutions: Record<string, Resolution>;
  log: string[];
  connectStatus: { ok: boolean; message: string } | null;
  comparing: boolean;
  syncing: boolean;
  syncError: string | null;
  storybookMarker: StorybookSyncMarker | null;
  storybookStatus: StorybookStatus;
  storybookError: string | null;
} = {
  activeTab: 'connect',
  settings: null,
  history: [],
  figmaTokens: emptyTokenSet(),
  githubTokens: emptyTokenSet(),
  githubSha: null,
  diff: [],
  resolutions: {},
  log: [],
  connectStatus: null,
  comparing: false,
  syncing: false,
  syncError: null,
  storybookMarker: null,
  storybookStatus: 'unknown',
  storybookError: null,
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

async function githubRequest(path: string, settings: GithubSettings, init: RequestInit = {}): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    // GitHub's Contents API responses are cacheable (ETag/Cache-Control),
    // and repeated GETs to the same URL — exactly what every re-compare
    // does — were letting the browser silently serve a stale cached
    // response instead of hitting GitHub for the real current content.
    // Every request here needs fresh data, always.
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${settings.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
  });
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
  const parsed = JSON.parse(await rawRes.text()) as Partial<TokenSet>;
  return {
    tokens: {
      color: parsed.color ?? {},
      typography: parsed.typography ?? {},
      shadow: parsed.shadow ?? {},
      dimension: parsed.dimension ?? {},
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

async function commitGithubTokens(
  settings: GithubSettings,
  tokens: TokenSet,
  sha: string | null,
): Promise<{ sha: string; url: string }> {
  const payload: Record<string, unknown> = {
    message: 'Design Sync: update design tokens',
    content: encodeBase64Utf8(JSON.stringify(tokens, null, 2) + '\n'),
    branch: settings.branch,
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
// Diff + sync plan
// ---------------------------------------------------------------------------

function diffTokenSets(figmaTokens: TokenSet, githubTokens: TokenSet): DiffEntry[] {
  const entries: DiffEntry[] = [];
  for (const category of TOKEN_CATEGORIES) {
    const fCat = figmaTokens[category] as Record<string, unknown>;
    const gCat = githubTokens[category] as Record<string, unknown>;
    const keys = Array.from(new Set([...Object.keys(fCat), ...Object.keys(gCat)])).sort();
    for (const key of keys) {
      const fVal = fCat[key];
      const gVal = gCat[key];
      let status: DiffEntry['status'];
      if (fVal !== undefined && gVal === undefined) status = 'added-figma';
      else if (fVal === undefined && gVal !== undefined) status = 'added-github';
      else if (JSON.stringify(fVal) !== JSON.stringify(gVal)) status = 'modified';
      else status = 'unchanged';
      entries.push({ category, key, figmaValue: fVal, githubValue: gVal, status });
    }
  }
  return entries;
}

function buildSyncPlan(
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
  return state.diff.filter((d) => d.status === 'modified' && !state.resolutions[`${d.category}:${d.key}`]).length;
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

function formatValue(val: unknown): string {
  if (val === undefined) return '—';
  if (typeof val === 'object' && val !== null && '$value' in (val as Record<string, unknown>)) {
    const inner = (val as { $value: unknown }).$value;
    return typeof inner === 'string' ? inner : JSON.stringify(inner);
  }
  return JSON.stringify(val);
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

  const row = (labelText: string, input: HTMLElement) =>
    el('div', { className: 'field' }, [el('label', {}, [labelText]), input]);

  container.appendChild(row('Repository owner', ownerInput));
  container.appendChild(row('Repository name', repoInput));
  container.appendChild(el('div', { className: 'row' }, [row('Branch', branchInput), row('Token file path', pathInput)]));
  container.appendChild(row('Personal access token (repo scope)', tokenInput));
  container.appendChild(
    el('p', { className: 'hint' }, [
      'Stored locally on this machine only (figma.clientStorage), never leaves it except to talk to api.github.com. Use a fine-grained token scoped to this one repo.',
    ]),
  );

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
      const link = el('a', { href: entry.commitUrl, target: '_blank', textContent: entry.commitSha.slice(0, 7) });
      container.appendChild(
        el('div', { className: 'history-item' }, [`${new Date(entry.timestamp).toLocaleString()} — `, link]),
      );
    }
  }

  return container;
}

function renderTokensTab(): HTMLElement {
  const container = el('div');
  container.appendChild(el('h2', {}, ['Custom (dimension) tokens']));
  container.appendChild(
    el('p', { className: 'hint' }, [
      'Figma has no native style type for spacing/radius/etc. without an Enterprise Variables plan, so these are tracked here and stored with the file.',
    ]),
  );

  const entries = Object.entries(state.figmaTokens.dimension);
  const table = el('table', { className: 'token-table' });
  const thead = el('tr', {}, [el('th', {}, ['Name']), el('th', {}, ['Value']), el('th', {}, [''])]);
  table.appendChild(el('thead', {}, [thead]));
  const tbody = el('tbody');

  const rows: { nameInput: HTMLInputElement; valueInput: HTMLInputElement }[] = [];

  function addRow(name: string, value: string) {
    const nameInput = el('input', { type: 'text', value: name, placeholder: 'spacing/sm' });
    const valueInput = el('input', { type: 'text', value, placeholder: '8px' });
    const removeBtn = el('button', { className: 'icon-btn', textContent: '✕' });
    const tr = el('tr', {}, [
      el('td', {}, [nameInput]),
      el('td', {}, [valueInput]),
      el('td', {}, [removeBtn]),
    ]);
    removeBtn.onclick = () => {
      tr.remove();
      const idx = rows.findIndex((r) => r.nameInput === nameInput);
      if (idx >= 0) rows.splice(idx, 1);
    };
    tbody.appendChild(tr);
    rows.push({ nameInput, valueInput });
  }

  for (const [name, token] of entries) addRow(name, token.$value);
  table.appendChild(tbody);
  container.appendChild(table);

  const addBtn = el('button', { textContent: '+ Add token' });
  addBtn.onclick = () => addRow('', '');

  const saveBtn = el('button', { className: 'primary', textContent: 'Save' });
  saveBtn.onclick = () => {
    const dimension: Record<string, DimensionTokenValue> = {};
    for (const { nameInput, valueInput } of rows) {
      const name = nameInput.value.trim();
      const value = valueInput.value.trim();
      if (!name || !value) continue;
      dimension[name] = { $type: 'dimension', $value: value };
    }
    state.figmaTokens.dimension = dimension;
    postToPlugin({ type: 'save-dimension-tokens', dimension });
    appendLog(`Saved ${Object.keys(dimension).length} custom token(s) to the Figma file.`);
  };

  container.appendChild(el('div', { className: 'btn-row' }, [addBtn, saveBtn]));
  return container;
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
  }

  if (state.comparing && state.diff.length === 0) {
    container.appendChild(el('div', { className: 'empty-state' }, ['Comparing Figma styles with GitHub…']));
  }

  if (state.diff.length > 0) {
    const changed = state.diff.filter((d) => d.status !== 'unchanged');
    if (changed.length === 0) {
      container.appendChild(el('div', { className: 'status-banner success' }, ['Figma and GitHub are already in sync.']));
    } else {
      const bulkRow = el('div', { className: 'btn-row' });
      const useAllFigma = el('button', { textContent: 'Use all Figma (conflicts)' });
      useAllFigma.onclick = () => {
        for (const d of changed) if (d.status === 'modified') state.resolutions[`${d.category}:${d.key}`] = 'figma';
        render();
      };
      const useAllGithub = el('button', { textContent: 'Use all GitHub (conflicts)' });
      useAllGithub.onclick = () => {
        for (const d of changed) if (d.status === 'modified') state.resolutions[`${d.category}:${d.key}`] = 'github';
        render();
      };
      bulkRow.append(useAllFigma, useAllGithub);
      container.appendChild(bulkRow);

      for (const category of TOKEN_CATEGORIES) {
        const rows = changed.filter((d) => d.category === category);
        if (rows.length === 0) continue;
        const group = el('div', { className: 'diff-group' });
        group.appendChild(el('h2', {}, [category]));
        for (const d of rows) group.appendChild(renderDiffRow(d));
        container.appendChild(group);
      }

      const remaining = unresolvedConflictCount();
      const syncBtn = el('button', {
        className: 'cta',
        textContent: state.syncing ? 'Syncing…' : 'Sync (write to GitHub & Figma)',
      });
      if (remaining > 0 || state.syncing) syncBtn.setAttribute('disabled', 'true');
      syncBtn.onclick = () => runSync();
      container.appendChild(el('div', { className: 'btn-row' }, [syncBtn]));
      if (remaining > 0) {
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
  const row = el('div', { className: `diff-row status-${d.status}` });
  const badgeText = { 'added-figma': 'New in Figma', 'added-github': 'New in GitHub', modified: 'Conflict', unchanged: '' }[d.status];
  row.appendChild(el('div', { className: 'diff-key' }, [d.key, el('span', { className: 'diff-badge' }, [badgeText])]));
  row.appendChild(
    el('div', { className: 'diff-values' }, [
      el('div', {}, [`Figma: ${formatValue(d.figmaValue)}`]),
      el('div', {}, [`GitHub: ${formatValue(d.githubValue)}`]),
    ]),
  );

  if (d.status === 'modified') {
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
    const skipped = state.resolutions[resKey] === 'skip';
    const controls = el('div', { className: 'resolution-controls' });
    const id = `${resKey}:skip-toggle`;
    const checkbox = el('input', { type: 'checkbox', id, checked: skipped });
    checkbox.onchange = () => {
      if (checkbox.checked) state.resolutions[resKey] = 'skip';
      else delete state.resolutions[resKey];
    };
    controls.appendChild(el('label', { htmlFor: id }, [checkbox, ' Skip this token']));
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
    body.appendChild(el('p', { className: 'hint' }, ['Storybook is already set up here. To bring it up to date after a sync:']));
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
  }

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
          el('td', {}, [formatValue(d.figmaValue)]),
          el('td', {}, [formatValue(d.githubValue)]),
          el('td', {}, [DIFF_STATUS_LABEL[d.status]]),
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
  state.diff = [];
  state.resolutions = {};
  render();
  try {
    appendLog('Reading tokens from Figma styles…');
    appendLog(`Fetching ${settings.path} and .storybook-sync.json from GitHub…`);
    const [figmaTokens, githubResult, marker] = await Promise.all([
      requestFigmaTokens(),
      fetchGithubTokens(settings),
      fetchStorybookMarker(settings).catch((err) => {
        state.storybookError = err instanceof Error ? err.message : String(err);
        return null;
      }),
    ]);
    state.figmaTokens = figmaTokens;
    state.githubTokens = githubResult.tokens;
    state.githubSha = githubResult.sha;
    state.storybookMarker = marker;
    computeStorybookStatus();

    state.diff = diffTokenSets(state.figmaTokens, state.githubTokens);
    const changed = state.diff.filter((d) => d.status !== 'unchanged').length;
    appendLog(
      `Compared: ${state.diff.length} token(s) total, ${changed} changed. Storybook: ${state.storybookStatus}.`,
    );
  } catch (err) {
    state.syncError = err instanceof Error ? err.message : String(err);
    appendLog(`Error: ${state.syncError}`);
  } finally {
    state.comparing = false;
    render();
  }
}

async function runSync() {
  if (!state.settings) return;
  state.syncing = true;
  state.syncError = null;
  render();
  try {
    const { final, figmaApply } = buildSyncPlan(state.figmaTokens, state.githubTokens, state.resolutions);
    // Dimension tokens have no per-key native style — the whole set lives in
    // one plugin-data blob, so it must always be replaced in full rather
    // than patched with just the delta like color/typography/shadow are.
    figmaApply.dimension = final.dimension;

    appendLog('Committing merged tokens to GitHub…');
    const commit = await commitGithubTokens(state.settings, final, state.githubSha);
    appendLog(`Committed ${commit.sha.slice(0, 7)}.`);

    // GitHub has already changed at this point, independent of whether the
    // Figma-apply step below succeeds — state must track that immediately,
    // or a retry after a failed apply would resend this now-stale sha and
    // GitHub would 409 ("does not match") on every subsequent attempt.
    state.githubTokens = final;
    state.githubSha = commit.sha;
    state.resolutions = {};
    computeStorybookStatus();

    const historyEntry: SyncHistoryEntry = {
      timestamp: new Date().toISOString(),
      commitSha: commit.sha,
      commitUrl: commit.url,
    };
    state.history.unshift(historyEntry);
    postToPlugin({ type: 'save-history', entry: historyEntry });

    appendLog('Applying changes to Figma styles…');
    const result = await applyTokensToFigma(figmaApply);
    if (!result.success) {
      throw new Error(
        `GitHub was updated (commit ${commit.sha.slice(0, 7)}), but applying changes back to Figma failed: ${
          result.error ?? 'unknown error'
        }. This usually means you only have view access to this Figma file.`,
      );
    }
    appendLog('Figma styles updated.');
    appendLog('Sync complete.');
  } catch (err) {
    state.syncError = err instanceof Error ? err.message : String(err);
    appendLog(`Error: ${state.syncError}`);
  } finally {
    // Always reconcile against whatever actually happened, even on a
    // partial failure above.
    state.figmaTokens = await requestFigmaTokens();
    state.diff = diffTokenSets(state.figmaTokens, state.githubTokens);
    state.syncing = false;
    render();
  }
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
