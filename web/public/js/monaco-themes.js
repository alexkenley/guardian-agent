import { DEFAULT_THEME_ID, getSavedTheme, resolveThemeId, themes } from './theme.js';

export const FOLLOW_APP_EDITOR_THEME_ID = 'follow-app';

const LEGACY_EDITOR_THEME_ALIASES = {
  'guardian-agent': DEFAULT_THEME_ID,
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeHex(value, fallback = '#000000') {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (!normalized.startsWith('#')) return fallback;
  if (normalized.length === 4) {
    const [hash, r, g, b] = normalized;
    return `${hash}${r}${r}${g}${g}${b}${b}`;
  }
  return normalized;
}

function withAlpha(hex, opacity) {
  const normalized = normalizeHex(hex);
  return `${normalized}${Math.round(clamp(opacity, 0, 1) * 255).toString(16).padStart(2, '0')}`;
}

function stripHash(hex) {
  return normalizeHex(hex).replace('#', '');
}

function overviewRulerColors(accentHex, bg, { error, warning, info }) {
  const hex = (opacity) => withAlpha(accentHex, opacity);
  return {
    'editorOverviewRuler.border': withAlpha(bg, 0),
    'editorOverviewRuler.background': bg,
    'editorOverviewRuler.currentContentForeground': hex(0.3),
    'editorOverviewRuler.incomingContentForeground': hex(0.3),
    'editorOverviewRuler.commonContentForeground': hex(0.2),
    'editorOverviewRuler.findMatchForeground': hex(0.4),
    'editorOverviewRuler.selectionHighlightForeground': hex(0.2),
    'editorOverviewRuler.bracketMatchForeground': hex(0.3),
    'editorOverviewRuler.wordHighlightForeground': hex(0.25),
    'editorOverviewRuler.wordHighlightStrongForeground': hex(0.35),
    'editorOverviewRuler.wordHighlightTextForeground': hex(0.25),
    'editorOverviewRuler.rangeHighlightForeground': hex(0.15),
    'editorOverviewRuler.errorForeground': withAlpha(error, 0.6),
    'editorOverviewRuler.warningForeground': withAlpha(warning, 0.6),
    'editorOverviewRuler.infoForeground': withAlpha(info, 0.6),
    'minimapSlider.background': hex(0.08),
    'minimapSlider.hoverBackground': hex(0.14),
    'minimapSlider.activeBackground': hex(0.18),
    'minimap.errorHighlight': withAlpha(error, 0.38),
    'minimap.warningHighlight': withAlpha(warning, 0.38),
    'minimap.infoHighlight': withAlpha(info, 0.38),
    'minimap.findMatchHighlight': hex(0.4),
    'minimap.selectionHighlight': hex(0.2),
    'minimap.selectionOccurrenceHighlight': hex(0.15),
    'minimap.foregroundOpacity': '#000000ff',
  };
}

function buildTokenRules(theme) {
  const vars = theme.vars || {};
  return [
    { token: '', foreground: stripHash(vars['--text-primary']), background: stripHash(vars['--code-surface'] || vars['--bg-primary']) },
    { token: 'comment', foreground: stripHash(vars['--code-comment']), fontStyle: 'italic' },
    { token: 'keyword', foreground: stripHash(vars['--code-keyword']) },
    { token: 'keyword.control', foreground: stripHash(vars['--code-keyword']) },
    { token: 'keyword.operator', foreground: stripHash(vars['--code-keyword']) },
    { token: 'storage', foreground: stripHash(vars['--code-keyword']) },
    { token: 'storage.type', foreground: stripHash(vars['--code-keyword']) },
    { token: 'type', foreground: stripHash(vars['--code-type']) },
    { token: 'type.identifier', foreground: stripHash(vars['--code-type']) },
    { token: 'support.type', foreground: stripHash(vars['--code-type']) },
    { token: 'string', foreground: stripHash(vars['--code-string']) },
    { token: 'string.escape', foreground: stripHash(vars['--code-string']) },
    { token: 'string.regexp', foreground: stripHash(vars['--code-number']) },
    { token: 'number', foreground: stripHash(vars['--code-number']) },
    { token: 'number.hex', foreground: stripHash(vars['--code-number']) },
    { token: 'constant', foreground: stripHash(vars['--code-number']) },
    { token: 'constant.language', foreground: stripHash(vars['--code-number']) },
    { token: 'variable', foreground: stripHash(vars['--code-variable']) },
    { token: 'variable.predefined', foreground: stripHash(vars['--code-variable']) },
    { token: 'variable.parameter', foreground: stripHash(vars['--text-primary']) },
    { token: 'identifier', foreground: stripHash(vars['--text-primary']) },
    { token: 'attribute.name', foreground: stripHash(vars['--code-property']) },
    { token: 'attribute.value', foreground: stripHash(vars['--code-string']) },
    { token: 'tag', foreground: stripHash(vars['--code-keyword']) },
    { token: 'metatag', foreground: stripHash(vars['--code-keyword']) },
    { token: 'metatag.content', foreground: stripHash(vars['--code-string']) },
    { token: 'delimiter', foreground: stripHash(vars['--text-secondary']) },
    { token: 'delimiter.bracket', foreground: stripHash(vars['--text-secondary']) },
    { token: 'delimiter.parenthesis', foreground: stripHash(vars['--text-secondary']) },
    { token: 'operator', foreground: stripHash(vars['--text-secondary']) },
    { token: 'predefined', foreground: stripHash(vars['--code-function']) },
    { token: 'annotation', foreground: stripHash(vars['--code-variable']) },
    { token: 'invalid', foreground: stripHash(vars['--error']) },
    { token: 'key', foreground: stripHash(vars['--code-property']) },
    { token: 'string.key.json', foreground: stripHash(vars['--code-property']) },
    { token: 'string.value.json', foreground: stripHash(vars['--code-string']) },
    { token: 'keyword.json', foreground: stripHash(vars['--code-number']) },
    { token: 'meta.tag', foreground: stripHash(vars['--code-keyword']) },
    { token: 'attribute.name.html', foreground: stripHash(vars['--code-property']) },
    { token: 'attribute.value.html', foreground: stripHash(vars['--code-string']) },
    { token: 'attribute.name.css', foreground: stripHash(vars['--code-property']) },
    { token: 'attribute.value.css', foreground: stripHash(vars['--code-string']) },
    { token: 'attribute.value.number.css', foreground: stripHash(vars['--code-number']) },
    { token: 'attribute.value.unit.css', foreground: stripHash(vars['--code-number']) },
    { token: 'attribute.value.hex.css', foreground: stripHash(vars['--code-number']) },
    { token: 'markup.heading', foreground: stripHash(vars['--code-keyword']), fontStyle: 'bold' },
    { token: 'markup.bold', fontStyle: 'bold' },
    { token: 'markup.italic', fontStyle: 'italic' },
    { token: 'markup.inline.raw', foreground: stripHash(vars['--code-string']) },
  ];
}

function buildMonacoTheme(theme) {
  const vars = theme.vars || {};
  const dark = theme.category !== 'light';
  const background = normalizeHex(vars['--code-surface'] || vars['--bg-primary']);
  const elevated = normalizeHex(vars['--code-surface-elevated'] || vars['--bg-elevated']);
  const accent = normalizeHex(vars['--accent']);
  const textPrimary = normalizeHex(vars['--text-primary']);
  const textSecondary = normalizeHex(vars['--text-secondary']);
  const textMuted = normalizeHex(vars['--text-muted']);
  const border = normalizeHex(vars['--border']);
  const hover = normalizeHex(vars['--bg-hover'] || vars['--bg-elevated']);
  const input = normalizeHex(vars['--bg-input']);
  const error = normalizeHex(vars['--error']);
  const warning = normalizeHex(vars['--warning']);
  const info = normalizeHex(vars['--info']);
  const success = normalizeHex(vars['--success']);
  return {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: buildTokenRules(theme),
    colors: {
      'editor.background': background,
      'editor.foreground': textPrimary,
      'editor.selectionBackground': normalizeHex(vars['--code-selection'] || withAlpha(accent, dark ? 0.2 : 0.16)),
      'editor.inactiveSelectionBackground': withAlpha(accent, dark ? 0.12 : 0.08),
      'editor.lineHighlightBackground': elevated,
      'editor.lineHighlightBorder': withAlpha(border, 0),
      'editorCursor.foreground': accent,
      'editorLineNumber.foreground': textMuted,
      'editorLineNumber.activeForeground': textSecondary,
      'editorIndentGuide.background': withAlpha(border, dark ? 0.66 : 0.45),
      'editorIndentGuide.activeBackground': border,
      'editorBracketMatch.background': withAlpha(accent, dark ? 0.14 : 0.12),
      'editorBracketMatch.border': withAlpha(accent, dark ? 0.38 : 0.28),
      'editorWidget.background': normalizeHex(vars['--bg-elevated']),
      'editorWidget.border': border,
      'editorSuggestWidget.background': normalizeHex(vars['--bg-elevated']),
      'editorSuggestWidget.border': border,
      'editorSuggestWidget.selectedBackground': hover,
      'editorSuggestWidget.highlightForeground': accent,
      'editorHoverWidget.background': normalizeHex(vars['--bg-elevated']),
      'editorHoverWidget.border': border,
      'editorGutter.background': background,
      'editorGroup.border': border,
      'scrollbarSlider.background': withAlpha(accent, dark ? 0.08 : 0.12),
      'scrollbarSlider.hoverBackground': withAlpha(accent, dark ? 0.14 : 0.18),
      'scrollbarSlider.activeBackground': withAlpha(accent, dark ? 0.2 : 0.24),
      'minimap.background': background,
      'input.background': input,
      'input.border': border,
      'input.foreground': textPrimary,
      'focusBorder': withAlpha(accent, dark ? 0.4 : 0.28),
      'list.activeSelectionBackground': hover,
      'list.hoverBackground': normalizeHex(vars['--bg-panel']),
      'list.focusBackground': hover,
      'diffEditor.insertedTextBackground': normalizeHex(vars['--code-diff-add-bg']),
      'diffEditor.removedTextBackground': normalizeHex(vars['--code-diff-remove-bg']),
      'diffEditor.insertedLineBackground': withAlpha(success, dark ? 0.12 : 0.1),
      'diffEditor.removedLineBackground': withAlpha(error, dark ? 0.1 : 0.08),
      'peekView.border': withAlpha(accent, dark ? 0.3 : 0.22),
      'peekViewEditor.background': normalizeHex(vars['--bg-surface']),
      'peekViewResult.background': normalizeHex(vars['--bg-surface']),
      'peekViewTitle.background': normalizeHex(vars['--bg-elevated']),
      ...overviewRulerColors(accent, background, { error, warning, info }),
    },
  };
}

export const THEME_REGISTRY = themes.map((theme) => ({
  id: theme.id,
  name: theme.name,
  category: theme.category,
  collection: theme.collection || 'built-in',
  theme: buildMonacoTheme(theme),
}));

export const EDITOR_THEME_OPTIONS = [
  {
    id: FOLLOW_APP_EDITOR_THEME_ID,
    name: 'Follow App Theme',
    category: 'system',
    collection: 'system',
  },
  ...THEME_REGISTRY.map(({ id, name, category, collection }) => ({
    id,
    name,
    category,
    collection,
  })),
];

export function normalizeEditorThemePreference(themeId) {
  const candidate = String(themeId || '').trim();
  if (!candidate || candidate === FOLLOW_APP_EDITOR_THEME_ID) {
    return FOLLOW_APP_EDITOR_THEME_ID;
  }
  const resolved = LEGACY_EDITOR_THEME_ALIASES[candidate] || resolveThemeId(candidate);
  return THEME_REGISTRY.some((entry) => entry.id === resolved) ? resolved : FOLLOW_APP_EDITOR_THEME_ID;
}

export function resolveEditorThemeId(themeId, fallbackThemeId = null) {
  const normalized = normalizeEditorThemePreference(themeId);
  if (normalized !== FOLLOW_APP_EDITOR_THEME_ID) {
    return normalized;
  }
  return resolveThemeId(fallbackThemeId || document.documentElement?.dataset?.theme || getSavedTheme() || DEFAULT_THEME_ID);
}

export function registerAllThemes(monaco) {
  for (const entry of THEME_REGISTRY) {
    monaco.editor.defineTheme(entry.id, entry.theme);
  }
}
