// Message protocol between code.ts (Figma sandbox) and ui.ts (plugin UI
// iframe), plus plugin-local types (GitHub connection settings, sync
// history). The token schema itself — TokenSet, DesignToken<T>,
// resolveToken, validateTokenSet, the legacy-shape normalizer — used to be
// defined here AND hand-duplicated in the design-tokens repo's
// src/tokens.ts. It now lives in one place, the `design-sync-schema`
// package, imported by both repos; re-exported here so every existing
// `from './shared/tokens'` import elsewhere in this codebase keeps working
// unchanged.
export * from 'design-sync-schema';

import type {
  BooleanToken,
  DimensionToken,
  StringToken,
  TokenSet,
} from 'design-sync-schema';

export interface GithubSettings {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  token: string;
}

export interface SyncHistoryEntry {
  timestamp: string; // ISO
  commitSha: string;
  commitUrl: string;
}

// Written by `npm run build-storybook`'s postbuild hook in the tokens repo
// (scripts/record-sync-marker.mjs) as .storybook-sync.json at the repo
// root. tokensBlobSha is the git blob SHA of design-tokens.json at build
// time — identical to the "sha" GitHub's Contents API reports for that
// file, so comparing the two tells us whether the last Storybook build
// reflects what's currently on GitHub, with no live Storybook deployment
// or extra network domain required.
export interface StorybookSyncMarker {
  tokensBlobSha: string;
  builtAt: string; // ISO
}

// ---- postMessage protocol -------------------------------------------------

export type UIToPluginMessage =
  | { type: 'ui-ready' }
  | { type: 'save-settings'; settings: GithubSettings }
  | { type: 'request-figma-tokens' }
  | { type: 'save-custom-tokens'; dimension: Record<string, DimensionToken>; string: Record<string, StringToken>; boolean: Record<string, BooleanToken> }
  | { type: 'apply-tokens'; tokens: TokenSet }
  | { type: 'save-history'; entry: SyncHistoryEntry };

export type PluginToUIMessage =
  | { type: 'init'; settings: GithubSettings | null; history: SyncHistoryEntry[] }
  | { type: 'figma-tokens'; tokens: TokenSet }
  | { type: 'figma-tokens-error'; error: string }
  | { type: 'apply-tokens-result'; success: boolean; error?: string };
