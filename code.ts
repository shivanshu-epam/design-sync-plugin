// Design Sync — Figma plugin main thread.
//
// Reads/writes design tokens using Figma primitives that are available on
// every plan (Paint/Text/Effect styles) plus local Variables (COLOR, FLOAT,
// STRING, BOOLEAN). Variable aliases are preserved as references (Phase 1,
// see shared/tokens.ts) rather than resolved away — resolving to a concrete
// value only happens where one is actually required (writing a Style back
// to Figma, which has no alias concept the way a Variable does).
//
// "dimension"/"string"/"boolean" tokens that don't come from a Variable
// (hand-entered in the Custom Tokens tab) are stored as a JSON blob in the
// file's shared plugin data, since Figma has no native style type for them.
//
// All GitHub network calls happen in ui.ts (the sandboxed main thread here
// has no network access); this file only talks to the Figma document and to
// figma.clientStorage, relaying results to/from the UI via postMessage.

import type {
  BooleanToken,
  ColorToken,
  DesignToken,
  DimensionToken,
  GithubSettings,
  ShadowLayer,
  StringToken,
  SyncHistoryEntry,
  TokenCategory,
  TokenSet,
  TokenValue,
  TypographyValue,
  UIToPluginMessage,
} from './shared/tokens';
import { emptyTokenSet } from './shared/tokens';

type EffectShadow = DropShadowEffect | InnerShadowEffect;

const SETTINGS_KEY = 'design-sync:github-settings';
const HISTORY_KEY = 'design-sync:sync-history';
const CUSTOM_TOKENS_KEY = 'design-sync:custom-tokens'; // holds { dimension, string, boolean }
const PLUGIN_DATA_NAMESPACE = 'designsync';

figma.showUI(__html__, { width: 420, height: 640 });

// code.ts has no "dom" lib (this runs in Figma's sandbox, not a browser),
// so no TextEncoder — count UTF-8 bytes by hand for the pluginData size check.
function utf8ByteLength(str: string): number {
  let bytes = 0;
  for (const char of str) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

function rgbaToHex({ r, g, b, a }: { r: number; g: number; b: number; a?: number }): string {
  const toHex = (n: number) =>
    Math.round(Math.max(0, Math.min(1, n)) * 255)
      .toString(16)
      .padStart(2, '0');
  const hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  if (a !== undefined && a < 1) {
    return `${hex}${toHex(a)}`;
  }
  return hex;
}

function hexToRgba(hex: string): { r: number; g: number; b: number; a: number } {
  const clean = hex.replace('#', '');
  const bytes =
    clean.length === 8
      ? [clean.slice(0, 2), clean.slice(2, 4), clean.slice(4, 6), clean.slice(6, 8)]
      : [clean.slice(0, 2), clean.slice(2, 4), clean.slice(4, 6), 'ff'];
  const [r, g, b, a] = bytes.map((b) => parseInt(b, 16) / 255);
  return { r, g, b, a };
}

function paintToHex(paint: Paint): string | null {
  if (paint.type !== 'SOLID') return null;
  return rgbaToHex({ ...paint.color, a: paint.opacity ?? 1 });
}

function figmaEffectToShadow(effect: Effect): ShadowLayer | null {
  if (effect.type !== 'DROP_SHADOW' && effect.type !== 'INNER_SHADOW') return null;
  const shadow = effect as EffectShadow;
  return {
    type: shadow.type,
    color: rgbaToHex(shadow.color),
    offsetX: shadow.offset.x,
    offsetY: shadow.offset.y,
    blur: shadow.radius,
    spread: shadow.spread ?? 0,
  };
}

function variableTypeToCategory(resolvedType: VariableResolvedDataType): TokenCategory | null {
  switch (resolvedType) {
    case 'COLOR':
      return 'color';
    case 'FLOAT':
      return 'dimension';
    case 'STRING':
      return 'string';
    case 'BOOLEAN':
      return 'boolean';
    default:
      return null;
  }
}

// A variable's OWN raw value for one mode — no alias-following here anymore
// (that's a separate, deliberate step below). Falls back to the variable's
// collection's default mode if it has no value for the requested mode id.
async function getRawVariableValue(variable: Variable, modeId: string): Promise<VariableValue | undefined> {
  let raw: VariableValue | undefined = variable.valuesByMode[modeId];
  if (raw === undefined) {
    const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
    if (collection) raw = variable.valuesByMode[collection.defaultModeId];
  }
  return raw;
}

// When a variable's raw value is a VARIABLE_ALIAS, this builds the refKey
// (see shared/tokens.ts) for the token it points at — the same
// "CollectionName/[ModeName/]VariableName" key scheme used everywhere else,
// category-prefixed. Deliberately does NOT recurse into the target's own
// value: Phase 1's whole point is to keep the reference itself, not resolve
// through it. `sourceModeId` is used to pick a matching mode on the target
// when the target's collection has more than one mode and shares mode ids
// with the source (the common same-collection-alias case); otherwise falls
// back to the target's own default mode.
async function buildAliasRefKey(aliasTargetId: string, sourceModeId: string): Promise<string | undefined> {
  const target = await figma.variables.getVariableByIdAsync(aliasTargetId);
  if (!target) return undefined;
  const category = variableTypeToCategory(target.resolvedType);
  if (!category) return undefined;
  const collection = await figma.variables.getVariableCollectionByIdAsync(target.variableCollectionId);
  if (!collection) return undefined;

  const multiMode = collection.modes.length > 1;
  let modeName: string | undefined;
  if (multiMode) {
    const mode =
      collection.modes.find((m) => m.modeId === sourceModeId) ??
      collection.modes.find((m) => m.modeId === collection.defaultModeId);
    modeName = mode?.name;
  }
  const key = `${collection.name}/${modeName ? `${modeName}/` : ''}${target.name}`;
  return `${category}/${key}`;
}

// Follows an alias chain by variable ID (not by refKey/name) all the way to
// a concrete value. Used specifically for aliases whose target is a
// "removed" Figma variable: it's still reachable by direct ID lookup (so
// this still works), but it's excluded from getLocalVariablesAsync()'s bulk
// listing, which means it will never get its own entry in our token set —
// storing a reference to it would be a permanently-dangling "Token not
// found". Resolving to a snapshot value instead is strictly better than a
// reference to a ghost that can never resolve.
async function resolveOrphanedAlias(variableId: string, modeId: string, visited: Set<string>): Promise<VariableValue | undefined> {
  if (visited.has(variableId)) return undefined;
  visited.add(variableId);
  const variable = await figma.variables.getVariableByIdAsync(variableId);
  if (!variable) return undefined;
  const raw = await getRawVariableValue(variable, modeId);
  if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'VARIABLE_ALIAS') {
    return resolveOrphanedAlias(raw.id, modeId, visited);
  }
  return raw;
}

function assignConcreteValue(
  result: VariableTokens,
  category: TokenCategory,
  name: string,
  raw: VariableValue,
  extensions: DesignToken<unknown>['$extensions'],
) {
  if (category === 'color' && raw && typeof raw === 'object' && 'r' in raw && 'g' in raw && 'b' in raw) {
    const rgba = raw as RGBA;
    result.color[name] = {
      $type: 'color',
      $value: { kind: 'value', value: rgbaToHex({ r: rgba.r, g: rgba.g, b: rgba.b, a: 'a' in rgba ? rgba.a : 1 }) },
      $extensions: extensions,
    };
  } else if (category === 'dimension' && typeof raw === 'number') {
    result.dimension[name] = { $type: 'dimension', $value: { kind: 'value', value: `${raw}px` }, $extensions: extensions };
  } else if (category === 'string' && typeof raw === 'string') {
    result.string[name] = { $type: 'string', $value: { kind: 'value', value: raw }, $extensions: extensions };
  } else if (category === 'boolean' && typeof raw === 'boolean') {
    result.boolean[name] = { $type: 'boolean', $value: { kind: 'value', value: raw }, $extensions: extensions };
  }
}

interface VariableTokens {
  color: Record<string, ColorToken>;
  dimension: Record<string, DimensionToken>;
  string: Record<string, StringToken>;
  boolean: Record<string, BooleanToken>;
}

function emptyVariableTokens(): VariableTokens {
  return { color: {}, dimension: {}, string: {}, boolean: {} };
}

// Figma Variables (semantic/neutral/surface/size/etc. collections) — unlike
// Paint/Text/Effect styles, these need an Enterprise-gated feature to
// *publish* as a shared library, but reading local variables via the
// plugin API works on whatever plan the file itself was created under.
// Falls back to nothing (not an error) if the API rejects, so files
// without variables still sync fine via styles alone.
async function readFigmaVariables(): Promise<VariableTokens> {
  const result = emptyVariableTokens();

  let collections: VariableCollection[];
  let variables: Variable[];
  try {
    [collections, variables] = await Promise.all([
      figma.variables.getLocalVariableCollectionsAsync(),
      figma.variables.getLocalVariablesAsync(),
    ]);
  } catch {
    return result;
  }

  const collectionsById = new Map(collections.map((c) => [c.id, c]));
  // Variables NOT in this set won't get their own entry below (they're
  // excluded from the bulk listing — typically because they've been
  // removed in Figma) — an alias pointing at one of these can never
  // resolve as a reference, so it's handled as a fallback-to-concrete case
  // instead of a permanently-dangling "Token not found".
  const activeVariableIds = new Set(variables.map((v) => v.id));

  for (const variable of variables) {
    const category = variableTypeToCategory(variable.resolvedType);
    if (!category) continue; // no other Figma variable types exist today, but stay defensive
    const collection = collectionsById.get(variable.variableCollectionId);
    if (!collection) continue;
    const multiMode = collection.modes.length > 1;

    for (const mode of collection.modes) {
      const raw = await getRawVariableValue(variable, mode.modeId);
      if (raw === undefined) continue;
      const name = `${collection.name}/${multiMode ? `${mode.name}/` : ''}${variable.name}`;
      const extensions = {
        'design-sync.figmaSourceType': 'variable' as const,
        'design-sync.variableId': variable.id,
      };

      if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'VARIABLE_ALIAS') {
        if (activeVariableIds.has(raw.id)) {
          const refKey = await buildAliasRefKey(raw.id, mode.modeId);
          if (refKey) {
            const value: TokenValue<never> = { kind: 'reference', refKey };
            if (category === 'color') result.color[name] = { $type: 'color', $value: value, $extensions: extensions };
            else if (category === 'dimension') result.dimension[name] = { $type: 'dimension', $value: value, $extensions: extensions };
            else if (category === 'string') result.string[name] = { $type: 'string', $value: value, $extensions: extensions };
            else result.boolean[name] = { $type: 'boolean', $value: value, $extensions: extensions };
            continue;
          }
        }
        // Target is missing from the active list (removed/orphaned) or its
        // shape couldn't be determined — resolve to a concrete snapshot
        // value instead of storing a reference nothing will ever satisfy.
        const resolved = await resolveOrphanedAlias(raw.id, mode.modeId, new Set([variable.id]));
        if (resolved === undefined) continue;
        assignConcreteValue(result, category, name, resolved, extensions);
        continue;
      }

      assignConcreteValue(result, category, name, raw, extensions);
    }
  }

  return result;
}

interface CustomTokens {
  dimension: Record<string, DimensionToken>;
  string: Record<string, StringToken>;
  boolean: Record<string, BooleanToken>;
}

function emptyCustomTokens(): CustomTokens {
  return { dimension: {}, string: {}, boolean: {} };
}

// Pre-Phase-1 plugin data: dimension-only, flat `$value: string` shape,
// stored under this key instead of CUSTOM_TOKENS_KEY. Read once as a
// fallback so hand-entered tokens from before Phase 1 aren't silently
// orphaned — the next "Save all" in the Custom Tokens tab writes them back
// under the new key/shape.
const LEGACY_DIMENSION_KEY = 'design-sync:dimension-tokens';

function readCustomTokens(): CustomTokens {
  const raw = figma.root.getSharedPluginData(PLUGIN_DATA_NAMESPACE, CUSTOM_TOKENS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<CustomTokens>;
      return { dimension: parsed.dimension ?? {}, string: parsed.string ?? {}, boolean: parsed.boolean ?? {} };
    } catch {
      // fall through to the legacy read below
    }
  }

  const legacyRaw = figma.root.getSharedPluginData(PLUGIN_DATA_NAMESPACE, LEGACY_DIMENSION_KEY);
  if (legacyRaw) {
    try {
      const legacy = JSON.parse(legacyRaw) as Record<string, { $type: string; $value: string }>;
      const dimension: Record<string, DimensionToken> = {};
      for (const [key, token] of Object.entries(legacy)) {
        dimension[key] = { $type: 'dimension', $value: { kind: 'value', value: token.$value } };
      }
      return { dimension, string: {}, boolean: {} };
    } catch {
      // corrupt — ignore
    }
  }

  return emptyCustomTokens();
}

async function readFigmaTokens(): Promise<TokenSet> {
  const tokens = emptyTokenSet();

  const paintStyles = await figma.getLocalPaintStylesAsync();
  for (const style of paintStyles) {
    const hex = style.paints.length === 1 ? paintToHex(style.paints[0]) : null;
    if (!hex) continue; // skip gradients/images/multi-fill styles in this MVP
    tokens.color[style.name] = {
      $type: 'color',
      $value: { kind: 'value', value: hex },
      $extensions: { 'design-sync.figmaSourceType': 'style' },
    };
  }

  const textStyles = await figma.getLocalTextStylesAsync();
  for (const style of textStyles) {
    const lineHeight =
      style.lineHeight.unit === 'AUTO'
        ? { value: 0, unit: 'AUTO' as const }
        : { value: style.lineHeight.value, unit: style.lineHeight.unit };
    const letterSpacing = { value: style.letterSpacing.value, unit: style.letterSpacing.unit };
    const value: TypographyValue = {
      fontFamily: style.fontName.family,
      fontStyle: style.fontName.style,
      fontSize: style.fontSize,
      lineHeight,
      letterSpacing,
    };
    tokens.typography[style.name] = {
      $type: 'typography',
      $value: { kind: 'value', value },
      $extensions: { 'design-sync.figmaSourceType': 'style' },
    };
  }

  const effectStyles = await figma.getLocalEffectStylesAsync();
  for (const style of effectStyles) {
    const layers = style.effects.map(figmaEffectToShadow).filter((s): s is ShadowLayer => s !== null);
    if (layers.length === 0) continue; // skip blur-only styles in this MVP
    tokens.shadow[style.name] = {
      $type: 'shadow',
      $value: { kind: 'value', value: layers },
      $extensions: { 'design-sync.figmaSourceType': 'style' },
    };
  }

  // Variables (semantic/neutral/surface/size/etc. collections) layer on top
  // of styles — colors merge in alongside paint-style colors; dimension,
  // string, and boolean variables merge in alongside their hand-entered
  // Custom Tokens tab counterparts.
  const custom = readCustomTokens();
  const variables = await readFigmaVariables();
  tokens.color = { ...tokens.color, ...variables.color };
  tokens.dimension = { ...custom.dimension, ...variables.dimension };
  tokens.string = { ...custom.string, ...variables.string };
  tokens.boolean = { ...custom.boolean, ...variables.boolean };

  return tokens;
}

async function applyColorToken(name: string, value: string, existing: PaintStyle | undefined) {
  const rgba = hexToRgba(value);
  const paint: SolidPaint = { type: 'SOLID', color: { r: rgba.r, g: rgba.g, b: rgba.b }, opacity: rgba.a };
  const style = existing ?? figma.createPaintStyle();
  style.name = name;
  style.paints = [paint];
}

async function applyTypographyToken(name: string, value: TypographyValue, existing: TextStyle | undefined) {
  const fontName: FontName = { family: value.fontFamily, style: value.fontStyle };
  await figma.loadFontAsync(fontName);
  const style = existing ?? figma.createTextStyle();
  style.name = name;
  style.fontName = fontName;
  style.fontSize = value.fontSize;
  style.lineHeight =
    value.lineHeight.unit === 'AUTO' ? { unit: 'AUTO' } : { unit: value.lineHeight.unit, value: value.lineHeight.value };
  style.letterSpacing = { unit: value.letterSpacing.unit, value: value.letterSpacing.value };
}

async function applyShadowToken(name: string, value: ShadowLayer[], existing: EffectStyle | undefined) {
  const effects: Effect[] = value.map((layer) => {
    const rgba = hexToRgba(layer.color);
    return {
      type: layer.type,
      color: rgba,
      offset: { x: layer.offsetX, y: layer.offsetY },
      radius: layer.blur,
      spread: layer.spread,
      visible: true,
      blendMode: 'NORMAL',
    } as Effect;
  });
  const style = existing ?? figma.createEffectStyle();
  style.name = name;
  style.effects = effects;
}

async function applyTokensToFigma(tokens: TokenSet): Promise<void> {
  const [paintStyles, textStyles, effectStyles] = await Promise.all([
    figma.getLocalPaintStylesAsync(),
    figma.getLocalTextStylesAsync(),
    figma.getLocalEffectStylesAsync(),
  ]);
  const paintByName = new Map(paintStyles.map((s) => [s.name, s]));
  const textByName = new Map(textStyles.map((s) => [s.name, s]));
  const effectByName = new Map(effectStyles.map((s) => [s.name, s]));

  // Styles have no alias concept, so every value here must already be
  // concrete ({ kind: 'value' }) by the time it reaches code.ts — ui.ts
  // resolves any reference against the full merged token set before
  // sending. Skip defensively rather than crash if one somehow arrives
  // unresolved (Phase 2 will add a real Variable write-back path for these).
  for (const [name, token] of Object.entries(tokens.color)) {
    if (token.$value.kind !== 'value') continue;
    await applyColorToken(name, token.$value.value, paintByName.get(name));
  }
  for (const [name, token] of Object.entries(tokens.typography)) {
    if (token.$value.kind !== 'value') continue;
    await applyTypographyToken(name, token.$value.value, textByName.get(name));
  }
  for (const [name, token] of Object.entries(tokens.shadow)) {
    if (token.$value.kind !== 'value') continue;
    await applyShadowToken(name, token.$value.value, effectByName.get(name));
  }

  // Only the hand-entered "Custom Tokens" tab entries need persisting here —
  // variable-derived dimension/string/boolean tokens are always re-read
  // live from Figma's Variables on the next readFigmaTokens() call, so
  // duplicating them into plugin data is both unnecessary and, at scale
  // (thousands of variables), exactly what blows past Figma's
  // 100kB-per-entry pluginData limit.
  const variables = await readFigmaVariables();
  const custom: CustomTokens = emptyCustomTokens();
  for (const [key, value] of Object.entries(tokens.dimension)) {
    if (!(key in variables.dimension)) custom.dimension[key] = value;
  }
  for (const [key, value] of Object.entries(tokens.string)) {
    if (!(key in variables.string)) custom.string[key] = value;
  }
  for (const [key, value] of Object.entries(tokens.boolean)) {
    if (!(key in variables.boolean)) custom.boolean[key] = value;
  }
  const serialized = JSON.stringify(custom);
  const byteLength = utf8ByteLength(serialized);
  const MAX_PLUGIN_DATA_BYTES = 90_000; // Figma's cap is 100kB per entry; leave headroom
  if (byteLength > MAX_PLUGIN_DATA_BYTES) {
    throw new Error(
      `Custom tokens are ${Math.round(byteLength / 1024)}kB, over Figma's ~100kB plugin-data limit — trim some entries in the Custom Tokens tab.`,
    );
  }
  figma.root.setSharedPluginData(PLUGIN_DATA_NAMESPACE, CUSTOM_TOKENS_KEY, serialized);
}

async function loadSettings(): Promise<GithubSettings | null> {
  return (await figma.clientStorage.getAsync(SETTINGS_KEY)) ?? null;
}

async function loadHistory(): Promise<SyncHistoryEntry[]> {
  return (await figma.clientStorage.getAsync(HISTORY_KEY)) ?? [];
}

async function init() {
  const [settings, history] = await Promise.all([loadSettings(), loadHistory()]);
  figma.ui.postMessage({ type: 'init', settings, history });
}

figma.ui.onmessage = async (msg: UIToPluginMessage) => {
  switch (msg.type) {
    case 'ui-ready':
      await init();
      break;

    case 'save-settings':
      await figma.clientStorage.setAsync(SETTINGS_KEY, msg.settings);
      break;

    case 'request-figma-tokens': {
      try {
        const tokens = await readFigmaTokens();
        figma.ui.postMessage({ type: 'figma-tokens', tokens });
      } catch (err) {
        // Without this, an exception here left ui.ts's requestFigmaTokens()
        // promise waiting forever for a reply that would never come —
        // exactly what "Comparing Figma styles with GitHub…" hanging
        // indefinitely looked like.
        figma.ui.postMessage({
          type: 'figma-tokens-error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'save-custom-tokens':
      figma.root.setSharedPluginData(
        PLUGIN_DATA_NAMESPACE,
        CUSTOM_TOKENS_KEY,
        JSON.stringify({ dimension: msg.dimension, string: msg.string, boolean: msg.boolean } satisfies CustomTokens),
      );
      break;

    case 'apply-tokens': {
      try {
        await applyTokensToFigma(msg.tokens);
        figma.ui.postMessage({ type: 'apply-tokens-result', success: true });
      } catch (err) {
        figma.ui.postMessage({
          type: 'apply-tokens-result',
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'save-history': {
      const history = await loadHistory();
      history.unshift(msg.entry);
      await figma.clientStorage.setAsync(HISTORY_KEY, history.slice(0, 20));
      break;
    }

    case 'open-external':
      if (msg.url.startsWith('https://') || msg.url.startsWith('http://localhost:')) figma.openExternal(msg.url);
      break;
  }
};
