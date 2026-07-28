// Design Sync — Figma plugin main thread.
//
// Reads/writes design tokens using Figma primitives that are available on
// every plan (Paint/Text/Effect styles). Figma's Variables API requires an
// Enterprise org, which this workspace doesn't have, so "dimension" tokens
// (spacing, radii, etc. — anything without a native style type) are stored
// as a custom JSON blob in the file's shared plugin data instead.
//
// All GitHub network calls happen in ui.ts (the sandboxed main thread here
// has no network access); this file only talks to the Figma document and to
// figma.clientStorage, relaying results to/from the UI via postMessage.

import type {
  ColorTokenValue,
  DimensionTokenValue,
  GithubSettings,
  ShadowLayer,
  SyncHistoryEntry,
  TokenSet,
  TypographyTokenValue,
  UIToPluginMessage,
} from './shared/tokens';
import { emptyTokenSet } from './shared/tokens';

type EffectShadow = DropShadowEffect | InnerShadowEffect;

const SETTINGS_KEY = 'design-sync:github-settings';
const HISTORY_KEY = 'design-sync:sync-history';
const DIMENSION_PLUGIN_DATA_KEY = 'design-sync:dimension-tokens';
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

// Follows VARIABLE_ALIAS chains (a variable's value can point at another
// variable, possibly in a different collection with different mode ids) to
// a concrete value. `visited` guards against alias cycles.
async function resolveVariableValue(
  variable: Variable,
  modeId: string,
  visited: Set<string>,
): Promise<VariableValue | undefined> {
  if (visited.has(variable.id)) return undefined;
  visited.add(variable.id);

  let raw: VariableValue | undefined = variable.valuesByMode[modeId];
  if (raw === undefined) {
    // This variable doesn't define a value for the requested mode id (e.g.
    // an alias into a collection with different modes) — fall back to its
    // own collection's default mode.
    const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
    if (collection) raw = variable.valuesByMode[collection.defaultModeId];
  }

  if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'VARIABLE_ALIAS') {
    const next = await figma.variables.getVariableByIdAsync(raw.id);
    if (!next) return undefined;
    return resolveVariableValue(next, modeId, visited);
  }
  return raw;
}

// Figma Variables (semantic/neutral/surface/etc. collections) — unlike
// Paint/Text/Effect styles, these need an Enterprise-gated feature to
// *publish* as a shared library, but reading local variables via the
// plugin API works on whatever plan the file itself was created under.
// Falls back to nothing (not an error) if the API rejects, so files
// without variables still sync fine via styles alone.
async function readFigmaVariables(): Promise<{
  color: Record<string, ColorTokenValue>;
  dimension: Record<string, DimensionTokenValue>;
}> {
  const color: Record<string, ColorTokenValue> = {};
  const dimension: Record<string, DimensionTokenValue> = {};

  let collections: VariableCollection[];
  let variables: Variable[];
  try {
    [collections, variables] = await Promise.all([
      figma.variables.getLocalVariableCollectionsAsync(),
      figma.variables.getLocalVariablesAsync(),
    ]);
  } catch {
    return { color, dimension };
  }

  const collectionsById = new Map(collections.map((c) => [c.id, c]));

  for (const variable of variables) {
    if (variable.resolvedType !== 'COLOR' && variable.resolvedType !== 'FLOAT') continue; // skip STRING/BOOLEAN in this MVP
    const collection = collectionsById.get(variable.variableCollectionId);
    if (!collection) continue;
    const multiMode = collection.modes.length > 1;

    for (const mode of collection.modes) {
      const raw = await resolveVariableValue(variable, mode.modeId, new Set());
      if (raw === undefined) continue;
      const name = `${collection.name}/${multiMode ? `${mode.name}/` : ''}${variable.name}`;

      if (variable.resolvedType === 'COLOR' && raw && typeof raw === 'object' && 'r' in raw && 'g' in raw && 'b' in raw) {
        const rgba = raw as RGBA;
        color[name] = { $type: 'color', $value: rgbaToHex({ r: rgba.r, g: rgba.g, b: rgba.b, a: 'a' in rgba ? rgba.a : 1 }) };
      } else if (variable.resolvedType === 'FLOAT' && typeof raw === 'number') {
        dimension[name] = { $type: 'dimension', $value: `${raw}px` };
      }
    }
  }

  return { color, dimension };
}

async function readFigmaTokens(): Promise<TokenSet> {
  const tokens = emptyTokenSet();

  const paintStyles = await figma.getLocalPaintStylesAsync();
  for (const style of paintStyles) {
    const hex = style.paints.length === 1 ? paintToHex(style.paints[0]) : null;
    if (!hex) continue; // skip gradients/images/multi-fill styles in this MVP
    tokens.color[style.name] = { $type: 'color', $value: hex };
  }

  const textStyles = await figma.getLocalTextStylesAsync();
  for (const style of textStyles) {
    const lineHeight =
      style.lineHeight.unit === 'AUTO'
        ? { value: 0, unit: 'AUTO' as const }
        : { value: style.lineHeight.value, unit: style.lineHeight.unit };
    const letterSpacing = { value: style.letterSpacing.value, unit: style.letterSpacing.unit };
    const value: TypographyTokenValue['$value'] = {
      fontFamily: style.fontName.family,
      fontStyle: style.fontName.style,
      fontSize: style.fontSize,
      lineHeight,
      letterSpacing,
    };
    tokens.typography[style.name] = { $type: 'typography', $value: value };
  }

  const effectStyles = await figma.getLocalEffectStylesAsync();
  for (const style of effectStyles) {
    const layers = style.effects.map(figmaEffectToShadow).filter((s): s is ShadowLayer => s !== null);
    if (layers.length === 0) continue; // skip blur-only styles in this MVP
    tokens.shadow[style.name] = { $type: 'shadow', $value: layers };
  }

  const rawDimension = figma.root.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DIMENSION_PLUGIN_DATA_KEY);
  let customDimension: Record<string, DimensionTokenValue> = {};
  if (rawDimension) {
    try {
      customDimension = JSON.parse(rawDimension) as Record<string, DimensionTokenValue>;
    } catch {
      // corrupt/empty — ignore and start fresh
    }
  }

  // Variables (semantic/neutral/surface/size/etc. collections) layer on top
  // of styles — colors merge in alongside paint-style colors, and floats
  // become dimension tokens alongside the manually-entered custom ones.
  const variables = await readFigmaVariables();
  tokens.color = { ...tokens.color, ...variables.color };
  tokens.dimension = { ...customDimension, ...variables.dimension };

  return tokens;
}

async function applyColorToken(name: string, value: ColorTokenValue['$value'], existing: PaintStyle | undefined) {
  const rgba = hexToRgba(value);
  const paint: SolidPaint = { type: 'SOLID', color: { r: rgba.r, g: rgba.g, b: rgba.b }, opacity: rgba.a };
  const style = existing ?? figma.createPaintStyle();
  style.name = name;
  style.paints = [paint];
}

async function applyTypographyToken(
  name: string,
  value: TypographyTokenValue['$value'],
  existing: TextStyle | undefined,
) {
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

  for (const [name, token] of Object.entries(tokens.color)) {
    await applyColorToken(name, token.$value, paintByName.get(name));
  }
  for (const [name, token] of Object.entries(tokens.typography)) {
    await applyTypographyToken(name, token.$value, textByName.get(name));
  }
  for (const [name, token] of Object.entries(tokens.shadow)) {
    await applyShadowToken(name, token.$value, effectByName.get(name));
  }

  // Only the hand-entered "Custom Tokens" tab entries need persisting here —
  // variable-derived dimension tokens are always re-read live from Figma's
  // Variables on the next readFigmaTokens() call, so duplicating them into
  // plugin data is both unnecessary and, at scale (thousands of variables),
  // exactly what blows past Figma's 100kB-per-entry pluginData limit.
  const { dimension: variableDimension } = await readFigmaVariables();
  const customDimension: Record<string, DimensionTokenValue> = {};
  for (const [key, value] of Object.entries(tokens.dimension)) {
    if (!(key in variableDimension)) customDimension[key] = value;
  }
  const serialized = JSON.stringify(customDimension);
  const byteLength = utf8ByteLength(serialized);
  const MAX_PLUGIN_DATA_BYTES = 90_000; // Figma's cap is 100kB per entry; leave headroom
  if (byteLength > MAX_PLUGIN_DATA_BYTES) {
    throw new Error(
      `Custom dimension tokens are ${Math.round(byteLength / 1024)}kB, over Figma's ~100kB plugin-data limit — trim some entries in the Custom Tokens tab.`,
    );
  }
  figma.root.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DIMENSION_PLUGIN_DATA_KEY, serialized);
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
      const tokens = await readFigmaTokens();
      figma.ui.postMessage({ type: 'figma-tokens', tokens });
      break;
    }

    case 'save-dimension-tokens':
      figma.root.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DIMENSION_PLUGIN_DATA_KEY, JSON.stringify(msg.dimension));
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
  }
};
