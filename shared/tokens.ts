// Shared token model + message protocol between code.ts (Figma sandbox) and
// ui.ts (plugin UI iframe). Kept dependency-free so it can be imported from
// both build targets (which have different lib/typeRoots).

export type TokenCategory = 'color' | 'typography' | 'shadow' | 'dimension';

export interface ColorTokenValue {
  $type: 'color';
  $value: string; // hex, e.g. "#1a73e8" or "rgba(26,115,232,0.5)"
}

export interface TypographyTokenValue {
  $type: 'typography';
  $value: {
    fontFamily: string;
    fontStyle: string; // e.g. "Regular", "Bold", "Italic"
    fontSize: number;
    // Mirrors Figma's own LineHeight/LetterSpacing unit vocabulary so
    // round-tripping through code.ts needs no conversion.
    lineHeight: { value: number; unit: 'PIXELS' | 'PERCENT' | 'AUTO' };
    letterSpacing: { value: number; unit: 'PIXELS' | 'PERCENT' };
  };
}

export interface ShadowLayer {
  type: 'DROP_SHADOW' | 'INNER_SHADOW';
  color: string; // rgba(...)
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
}

export interface ShadowTokenValue {
  $type: 'shadow';
  $value: ShadowLayer[];
}

export interface DimensionTokenValue {
  $type: 'dimension';
  $value: string; // e.g. "8px"
}

export type TokenValue =
  | ColorTokenValue
  | TypographyTokenValue
  | ShadowTokenValue
  | DimensionTokenValue;

export interface TokenSet {
  color: Record<string, ColorTokenValue>;
  typography: Record<string, TypographyTokenValue>;
  shadow: Record<string, ShadowTokenValue>;
  dimension: Record<string, DimensionTokenValue>;
}

export const TOKEN_CATEGORIES: TokenCategory[] = ['color', 'typography', 'shadow', 'dimension'];

export function emptyTokenSet(): TokenSet {
  return { color: {}, typography: {}, shadow: {}, dimension: {} };
}

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
  | { type: 'save-dimension-tokens'; dimension: Record<string, DimensionTokenValue> }
  | { type: 'apply-tokens'; tokens: TokenSet }
  | { type: 'save-history'; entry: SyncHistoryEntry };

export type PluginToUIMessage =
  | { type: 'init'; settings: GithubSettings | null; history: SyncHistoryEntry[] }
  | { type: 'figma-tokens'; tokens: TokenSet }
  | { type: 'apply-tokens-result'; success: boolean; error?: string };
