/**
 * Theme manager — global CSS variable theming with built-in and curated bundles.
 * Persists selection to localStorage. Applies to :root on load.
 */

import { CURATED_THEME_SEEDS } from './curated-theme-seeds.js';

const STORAGE_KEY = 'guardianagent_theme';
const FONT_SCALE_STORAGE_KEY = 'guardianagent_font_scale';
const FONT_PRESET_STORAGE_KEY = 'guardianagent_font_preset';
const REDUCE_MOTION_STORAGE_KEY = 'guardianagent_reduce_motion';
const APPEARANCE_VERSION_STORAGE_KEY = 'guardianagent_appearance_version';
const APPEARANCE_VERSION = '2';

export const DEFAULT_THEME_ID = 'guardian-angel';
export const DEFAULT_FONT_SCALE = 1.05;
export const FOLLOW_THEME_FONT_PRESET_ID = 'theme-default';

const THEME_ID_ALIASES = {
  'guardian-agent': DEFAULT_THEME_ID,
};

const GEOMETRY_PRESETS = {
  sharp: {
    '--radius': '0px',
    '--radius-xs': '0px',
    '--radius-sm': '0px',
    '--radius-md': '0px',
    '--radius-lg': '0px',
    '--radius-xl': '0px',
    '--radius-pill': '999px',
  },
  crisp: {
    '--radius': '4px',
    '--radius-xs': '2px',
    '--radius-sm': '4px',
    '--radius-md': '6px',
    '--radius-lg': '10px',
    '--radius-xl': '14px',
    '--radius-pill': '999px',
  },
  soft: {
    '--radius': '10px',
    '--radius-xs': '6px',
    '--radius-sm': '10px',
    '--radius-md': '14px',
    '--radius-lg': '18px',
    '--radius-xl': '24px',
    '--radius-pill': '999px',
  },
  round: {
    '--radius': '14px',
    '--radius-xs': '10px',
    '--radius-sm': '14px',
    '--radius-md': '18px',
    '--radius-lg': '22px',
    '--radius-xl': '28px',
    '--radius-pill': '999px',
  },
};

function fontVars({
  mono,
  sans,
  display,
  bodyTracking = '0em',
  displayTracking = '0.01em',
  buttonTracking = '0.02em',
  navTracking = '0.03em',
  labelTracking = '0.05em',
  navTransform = 'none',
  labelTransform = 'uppercase',
  headingWeight = '700',
  uiWeight = '600',
}) {
  return {
    '--font-mono': mono,
    '--font-sans': sans,
    '--font-display': display,
    '--font-body-tracking': bodyTracking,
    '--font-display-tracking': displayTracking,
    '--font-button-tracking': buttonTracking,
    '--font-nav-tracking': navTracking,
    '--font-label-tracking': labelTracking,
    '--font-nav-transform': navTransform,
    '--font-label-transform': labelTransform,
    '--font-heading-weight': headingWeight,
    '--font-ui-weight': uiWeight,
  };
}

export const fontPresets = [
  {
    id: FOLLOW_THEME_FONT_PRESET_ID,
    name: 'Match Theme',
    description: 'Use the typography bundle paired with the current theme.',
    vars: {},
  },
  {
    id: 'guardian-default',
    name: 'Guardian Default',
    description: 'Current Guardian typography stack with Cascadia Code and Inter.',
    vars: fontVars({
      mono: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace",
      sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      display: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      navTracking: '0.045em',
      labelTracking: '0.055em',
    }),
  },
  {
    id: 'precision-sans',
    name: 'Precision Sans',
    description: 'Tight modern sans pairing for operational dashboards.',
    vars: fontVars({
      mono: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
      sans: "Tahoma, 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif",
      display: "'Inter', Tahoma, 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif",
      displayTracking: '0.005em',
      buttonTracking: '0.05em',
      navTracking: '0.08em',
      labelTracking: '0.08em',
      labelTransform: 'uppercase',
    }),
  },
  {
    id: 'rounded-sans',
    name: 'Rounded Sans',
    description: 'Softer approachable UI stack with rounded letterforms.',
    vars: fontVars({
      mono: "'DM Mono', 'Cascadia Code', 'Fira Code', monospace",
      sans: "'Trebuchet MS', 'Segoe UI', 'Helvetica Neue', sans-serif",
      display: "'Trebuchet MS', 'Segoe UI', 'Helvetica Neue', sans-serif",
      bodyTracking: '0.01em',
      displayTracking: '0.012em',
      buttonTracking: '0.015em',
      navTracking: '0.012em',
      labelTracking: '0.018em',
      navTransform: 'none',
      labelTransform: 'none',
    }),
  },
  {
    id: 'apple-sans',
    name: 'Apple Sans',
    description: 'Minimal system-forward Apple-style typography.',
    vars: fontVars({
      mono: "'SF Mono', 'Menlo', 'Monaco', 'Cascadia Code', monospace",
      sans: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif",
      display: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', sans-serif",
      displayTracking: '-0.01em',
      buttonTracking: '0.01em',
      navTracking: '0em',
      labelTracking: '0.015em',
      navTransform: 'none',
      labelTransform: 'none',
      headingWeight: '650',
    }),
  },
  {
    id: 'editorial-warm',
    name: 'Editorial Warm',
    description: 'Soft serif-forward reading stack for calmer presentation.',
    vars: fontVars({
      mono: "'IBM Plex Mono', 'Cascadia Code', monospace",
      sans: "'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Georgia, serif",
      display: "'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Georgia, serif",
      bodyTracking: '0.005em',
      displayTracking: '0em',
      buttonTracking: '0.035em',
      navTracking: '0.01em',
      labelTracking: '0.025em',
      navTransform: 'none',
      labelTransform: 'none',
      headingWeight: '600',
      uiWeight: '500',
    }),
  },
  {
    id: 'mono-sans',
    name: 'Mono Sans',
    description: 'Technical sans stack with IBM Plex styling.',
    vars: fontVars({
      mono: "'IBM Plex Mono', 'JetBrains Mono', 'Cascadia Code', monospace",
      sans: "'Segoe UI', Tahoma, sans-serif",
      display: "'Segoe UI', Tahoma, sans-serif",
      displayTracking: '0.008em',
      buttonTracking: '0.06em',
      navTracking: '0.085em',
      labelTracking: '0.09em',
    }),
  },
  {
    id: 'signal-sans',
    name: 'Signal Sans',
    description: 'High-energy geometric sans pairing for product surfaces.',
    vars: fontVars({
      mono: "'Space Mono', 'DM Mono', 'Cascadia Code', monospace",
      sans: "'Franklin Gothic Medium', 'Arial Narrow', 'Segoe UI', sans-serif",
      display: "'Franklin Gothic Medium', 'Arial Narrow', 'Segoe UI', sans-serif",
      displayTracking: '0.015em',
      buttonTracking: '0.08em',
      navTracking: '0.12em',
      labelTracking: '0.11em',
    }),
  },
  {
    id: 'premium-sans',
    name: 'Premium Sans',
    description: 'High-contrast contemporary sans stack with clean spacing.',
    vars: fontVars({
      mono: "'JetBrains Mono', 'Cascadia Code', monospace",
      sans: "'Helvetica Neue', Arial, 'Segoe UI', sans-serif",
      display: "'Helvetica Neue', Arial, 'Segoe UI', sans-serif",
      displayTracking: '0em',
      buttonTracking: '0.025em',
      navTracking: '0.02em',
      labelTracking: '0.04em',
      navTransform: 'none',
      labelTransform: 'uppercase',
    }),
  },
  {
    id: 'carbon-sans',
    name: 'Carbon Sans',
    description: 'IBM-influenced enterprise typography with technical mono support.',
    vars: fontVars({
      mono: "'IBM Plex Mono', 'Cascadia Code', monospace",
      sans: "'Segoe UI', 'Helvetica Neue', sans-serif",
      display: "'Segoe UI', 'Helvetica Neue', sans-serif",
      displayTracking: '0.01em',
      buttonTracking: '0.05em',
      navTracking: '0.06em',
      labelTracking: '0.07em',
    }),
  },
  {
    id: 'matter-sans',
    name: 'Matter Sans',
    description: 'Friendly product sans pairing with wider spacing.',
    vars: fontVars({
      mono: "'JetBrains Mono', 'IBM Plex Mono', monospace",
      sans: "'Gill Sans', 'Trebuchet MS', 'Segoe UI', sans-serif",
      display: "'Gill Sans', 'Trebuchet MS', 'Segoe UI', sans-serif",
      displayTracking: '0.014em',
      buttonTracking: '0.03em',
      navTracking: '0.03em',
      labelTracking: '0.025em',
      navTransform: 'none',
      labelTransform: 'none',
    }),
  },
  {
    id: 'system-sans',
    name: 'System Sans',
    description: 'Neutral system UI stack with broad platform coverage.',
    vars: fontVars({
      mono: "'SF Mono', 'Cascadia Code', 'Consolas', monospace",
      sans: "'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif",
      display: "'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif",
      buttonTracking: '0.02em',
      navTracking: '0.02em',
      labelTracking: '0.045em',
      navTransform: 'none',
    }),
  },
  {
    id: 'readable-sans',
    name: 'Readable Sans',
    description: 'Accessibility-first sans serif stack with strong fallback coverage.',
    vars: fontVars({
      mono: "'Atkinson Hyperlegible Mono', 'Cascadia Code', monospace",
      sans: "'Atkinson Hyperlegible', 'Lexend', 'Segoe UI', sans-serif",
      display: "'Atkinson Hyperlegible', 'Lexend', 'Segoe UI', sans-serif",
      bodyTracking: '0.01em',
      buttonTracking: '0.015em',
      navTracking: '0.01em',
      labelTracking: '0.02em',
      navTransform: 'none',
      labelTransform: 'none',
      headingWeight: '650',
    }),
  },
  {
    id: 'verdana-clear',
    name: 'Verdana Clear',
    description: 'Wider letterforms and familiar Windows readability.',
    vars: fontVars({
      mono: "Verdana, Geneva, sans-serif",
      sans: "Verdana, Geneva, sans-serif",
      display: "Verdana, Geneva, sans-serif",
      bodyTracking: '0.01em',
      displayTracking: '0.01em',
      buttonTracking: '0.03em',
      navTracking: '0.03em',
      labelTracking: '0.05em',
    }),
  },
  {
    id: 'georgia-serif',
    name: 'Georgia Serif',
    description: 'Serif reading mode for longer-form text and softer contrast.',
    vars: fontVars({
      mono: "Georgia, 'Times New Roman', serif",
      sans: "Georgia, 'Times New Roman', serif",
      display: "Georgia, 'Times New Roman', serif",
      bodyTracking: '0.005em',
      displayTracking: '0em',
      buttonTracking: '0.03em',
      navTracking: '0.01em',
      labelTracking: '0.02em',
      navTransform: 'none',
      labelTransform: 'none',
      headingWeight: '600',
      uiWeight: '500',
    }),
  },
];

const BUILT_IN_THEME_OVERRIDES = {
  'guardian-angel': { geometry: 'sharp', fontPresetId: 'guardian-default' },
  'standard-dark': { geometry: 'crisp', fontPresetId: 'precision-sans' },
  'standard-light': { geometry: 'crisp', fontPresetId: 'precision-sans' },
  'github-dark': { geometry: 'crisp', fontPresetId: 'system-sans' },
  'github-light': { geometry: 'crisp', fontPresetId: 'system-sans' },
  dracula: { geometry: 'soft', fontPresetId: 'precision-sans' },
  monokai: { geometry: 'crisp', fontPresetId: 'mono-sans' },
  'solarized-dark': { geometry: 'crisp', fontPresetId: 'precision-sans' },
  'solarized-light': { geometry: 'crisp', fontPresetId: 'precision-sans' },
  nord: { geometry: 'crisp', fontPresetId: 'precision-sans' },
  cyberpunk: { geometry: 'sharp', fontPresetId: 'signal-sans' },
  'gruvbox-dark': { geometry: 'crisp', fontPresetId: 'editorial-warm' },
  'gruvbox-light': { geometry: 'crisp', fontPresetId: 'editorial-warm' },
  'tokyo-night': { geometry: 'crisp', fontPresetId: 'precision-sans' },
  'catppuccin-mocha': { geometry: 'soft', fontPresetId: 'rounded-sans' },
  'one-dark': { geometry: 'crisp', fontPresetId: 'precision-sans' },
  'night-owl': { geometry: 'soft', fontPresetId: 'precision-sans' },
  'threat-vector': { geometry: 'sharp', fontPresetId: 'signal-sans' },
  synthwave: { geometry: 'soft', fontPresetId: 'signal-sans' },
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeHex(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized.startsWith('#')) return normalized;
  if (normalized.length === 4) {
    const [hash, r, g, b] = normalized;
    return `${hash}${r}${r}${g}${g}${b}${b}`;
  }
  return normalized;
}

function hexToRgb(hex) {
  const normalized = normalizeHex(hex).replace('#', '');
  const int = Number.parseInt(normalized, 16);
  return {
    r: (int >> 16) & 255,
    g: (int >> 8) & 255,
    b: int & 255,
  };
}

function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map((channel) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, '0')).join('')}`;
}

function mix(a, b, amount) {
  const colorA = hexToRgb(a);
  const colorB = hexToRgb(b);
  const ratio = clamp(amount, 0, 1);
  return rgbToHex({
    r: colorA.r + (colorB.r - colorA.r) * ratio,
    g: colorA.g + (colorB.g - colorA.g) * ratio,
    b: colorA.b + (colorB.b - colorA.b) * ratio,
  });
}

function withAlpha(hex, opacity) {
  const normalized = normalizeHex(hex);
  if (!normalized.startsWith('#')) return normalized;
  return `${normalized}${Math.round(clamp(opacity, 0, 1) * 255).toString(16).padStart(2, '0')}`;
}

function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const transform = (channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const [rs, gs, bs] = [transform(r), transform(g), transform(b)];
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function chooseAccentText(accent) {
  return luminance(accent) > 0.42 ? '#101418' : '#ffffff';
}

function uniqueColors(values = []) {
  return [...new Set(values.map(normalizeHex).filter((value) => value.startsWith('#')))];
}

function uniqueTerms(values = []) {
  return [...new Set(values.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
}

function buildCodeVars(theme) {
  const vars = theme.vars || {};
  const dark = theme.category !== 'light';
  const bgPrimary = vars['--bg-primary'];
  const bgElevated = vars['--bg-elevated'];
  const accent = vars['--accent'];
  const info = vars['--info'];
  const success = vars['--success'];
  const warning = vars['--warning'];
  const error = vars['--error'];
  const textPrimary = vars['--text-primary'];
  const textMuted = vars['--text-muted'];
  const codeSurface = vars['--code-surface'] || mix(bgPrimary, dark ? '#000000' : '#ffffff', dark ? 0.22 : 0.35);
  return {
    '--code-surface': codeSurface,
    '--code-surface-elevated': vars['--code-surface-elevated'] || mix(codeSurface, bgElevated, 0.42),
    '--code-selection': vars['--code-selection'] || withAlpha(accent, dark ? 0.22 : 0.16),
    '--code-keyword': vars['--code-keyword'] || accent,
    '--code-property': vars['--code-property'] || info,
    '--code-type': vars['--code-type'] || mix(success, textPrimary, dark ? 0.18 : 0.12),
    '--code-function': vars['--code-function'] || warning,
    '--code-variable': vars['--code-variable'] || mix(error, warning, 0.4),
    '--code-string': vars['--code-string'] || success,
    '--code-number': vars['--code-number'] || warning,
    '--code-comment': vars['--code-comment'] || mix(textMuted, bgPrimary, dark ? 0.08 : 0.16),
    '--code-diff-add-bg': vars['--code-diff-add-bg'] || withAlpha(success, dark ? 0.14 : 0.16),
    '--code-diff-add-fg': vars['--code-diff-add-fg'] || mix(success, textPrimary, dark ? 0.2 : 0.12),
    '--code-diff-remove-bg': vars['--code-diff-remove-bg'] || withAlpha(error, dark ? 0.14 : 0.12),
    '--code-diff-remove-fg': vars['--code-diff-remove-fg'] || mix(error, textPrimary, dark ? 0.16 : 0.1),
    '--code-diff-hunk-bg': vars['--code-diff-hunk-bg'] || withAlpha(info, dark ? 0.12 : 0.1),
    '--code-diff-hunk-fg': vars['--code-diff-hunk-fg'] || mix(info, textPrimary, dark ? 0.18 : 0.1),
    '--code-diff-meta-bg': vars['--code-diff-meta-bg'] || withAlpha(textPrimary, dark ? 0.08 : 0.06),
    '--code-diff-meta-fg': vars['--code-diff-meta-fg'] || mix(textPrimary, bgPrimary, dark ? 0.2 : 0.36),
  };
}

function normalizeTheme(theme) {
  const dark = theme.category !== 'light';
  const vars = theme.vars || {};
  const bgPrimary = vars['--bg-primary'] || (dark ? '#0f172a' : '#ffffff');
  const textPrimary = vars['--text-primary'] || (dark ? '#e5edf8' : '#172033');
  const accent = vars['--accent'] || (dark ? '#4facfe' : '#2563eb');
  const info = vars['--info'] || accent;
  const success = vars['--success'] || '#10b981';
  const warning = vars['--warning'] || '#f59e0b';
  const error = vars['--error'] || '#ef4444';
  const accentWash = vars['--accent-wash'] || mix(bgPrimary, accent, dark ? 0.08 : 0.075);
  const accentWashStrong = vars['--accent-wash-strong'] || mix(bgPrimary, accent, dark ? 0.14 : 0.14);
  const bgSurface = vars['--bg-surface'] || mix(accentWash, textPrimary, dark ? 0.04 : 0.015);
  const bgElevated = vars['--bg-elevated'] || mix(accentWashStrong, textPrimary, dark ? 0.08 : 0.025);
  const bgInput = vars['--bg-input'] || mix(accentWash, dark ? '#000000' : '#ffffff', dark ? 0.18 : 0.22);
  const textSecondary = vars['--text-secondary'] || mix(textPrimary, bgPrimary, dark ? 0.34 : 0.54);
  const textMuted = vars['--text-muted'] || mix(textPrimary, bgPrimary, dark ? 0.62 : 0.72);
  const border = vars['--border'] || mix(dark ? accentWashStrong : accentWash, textPrimary, dark ? 0.34 : 0.24);
  const accentHover = vars['--accent-hover'] || mix(accent, dark ? '#ffffff' : '#000000', dark ? 0.16 : 0.12);
  const geometry = GEOMETRY_PRESETS[theme.geometry] || GEOMETRY_PRESETS.sharp;
  const shadow = vars['--shadow'] || (dark ? '0 10px 28px rgba(0,0,0,0.34)' : '0 12px 28px rgba(15,23,42,0.08)');
  const panelHeaderBg = vars['--panel-header-bg'] || mix(bgSurface, accent, dark ? 0.08 : 0.07);
  const navHoverBg = vars['--nav-hover-bg'] || mix(bgSurface, accent, dark ? 0.1 : 0.08);
  const navActiveBg = vars['--nav-active-bg'] || mix(bgSurface, accent, dark ? 0.18 : 0.16);
  const controlSurface = vars['--control-surface'] || mix(bgInput, accent, dark ? 0.05 : 0.06);
  const normalized = {
    ...theme,
    vars: {
      '--bg-primary': bgPrimary,
      '--bg-surface': bgSurface,
      '--bg-elevated': bgElevated,
      '--bg-input': bgInput,
      '--accent-wash': accentWash,
      '--accent-wash-strong': accentWashStrong,
      '--bg-secondary': vars['--bg-secondary'] || bgSurface,
      '--bg-tertiary': vars['--bg-tertiary'] || bgElevated,
      '--bg-panel': vars['--bg-panel'] || bgSurface,
      '--bg-hover': vars['--bg-hover'] || mix(bgElevated, accent, dark ? 0.08 : 0.05),
      '--panel-header-bg': panelHeaderBg,
      '--nav-hover-bg': navHoverBg,
      '--nav-active-bg': navActiveBg,
      '--control-surface': controlSurface,
      '--accent': accent,
      '--accent-hover': accentHover,
      '--accent-text': vars['--accent-text'] || chooseAccentText(accent),
      '--text-primary': textPrimary,
      '--text-secondary': textSecondary,
      '--text-muted': textMuted,
      '--text': vars['--text'] || textPrimary,
      '--border': border,
      '--border-color': vars['--border-color'] || border,
      '--border-strong': vars['--border-strong'] || mix(border, textPrimary, dark ? 0.18 : 0.28),
      '--success': success,
      '--warning': warning,
      '--error': error,
      '--info': info,
      '--shadow': shadow,
      '--panel-shadow': vars['--panel-shadow'] || shadow,
      '--button-shadow': vars['--button-shadow'] || (dark ? '0 1px 0 rgba(255,255,255,0.04)' : '0 1px 0 rgba(255,255,255,0.72)'),
      '--accent-glow': vars['--accent-glow'] || withAlpha(accent, dark ? 0.16 : 0.1),
      '--guardian-halo': vars['--guardian-halo'] || `0 0 24px ${withAlpha(accent, dark ? 0.12 : 0.08)}`,
      '--guardian-border': vars['--guardian-border'] || withAlpha(accent, dark ? 0.24 : 0.14),
      '--celestial-gradient': vars['--celestial-gradient'] || `linear-gradient(135deg, ${withAlpha(accent, dark ? 0.08 : 0.05)}, ${withAlpha(info, dark ? 0.05 : 0.04)})`,
      '--focus-ring': vars['--focus-ring'] || `0 0 0 1px ${withAlpha(accent, dark ? 0.36 : 0.22)}, 0 0 0 4px ${withAlpha(accent, dark ? 0.14 : 0.1)}`,
      '--layout-chat-column': vars['--layout-chat-column'] || '460px',
      '--layout-chat-column-wide': vars['--layout-chat-column-wide'] || vars['--layout-chat-column'] || '460px',
      '--code-side-panel-width': vars['--code-side-panel-width'] || 'clamp(372px, 24vw, 408px)',
      '--code-side-panel-width-wide': vars['--code-side-panel-width-wide'] || 'clamp(392px, 27vw, 448px)',
      '--sidebar-width': vars['--sidebar-width'] || '220px',
      ...geometry,
      ...buildCodeVars({
        ...theme,
        vars: {
          ...vars,
          '--bg-primary': bgPrimary,
          '--bg-elevated': bgElevated,
          '--accent': accent,
          '--info': info,
          '--success': success,
          '--warning': warning,
          '--error': error,
          '--text-primary': textPrimary,
          '--text-muted': textMuted,
        },
      }),
    },
    geometry: theme.geometry || 'sharp',
    fontPresetId: theme.fontPresetId || 'guardian-default',
    collection: theme.collection || 'built-in',
    searchTerms: uniqueTerms([...(theme.searchTerms || []), theme.name, theme.id, theme.collection || 'built-in']),
  };
  return normalized;
}

function createCuratedTheme(seed) {
  const dark = seed.category !== 'light';
  const bgPrimary = normalizeHex(seed.colors.bgPrimary);
  const textPrimary = normalizeHex(seed.colors.textPrimary);
  const accent = normalizeHex(seed.colors.accent);
  const info = normalizeHex(seed.colors.info);
  const success = normalizeHex(seed.colors.success);
  const warning = normalizeHex(seed.colors.warning);
  const error = normalizeHex(seed.colors.error);
  return normalizeTheme({
    id: seed.id,
    name: seed.name,
    description: seed.description,
    category: seed.category,
    collection: seed.collection,
    sourceSlug: seed.sourceSlug,
    sourceName: seed.sourceName,
    fontPresetId: seed.fontPresetId || 'precision-sans',
    geometry: seed.geometry || 'crisp',
    palette: seed.palette,
    searchTerms: [...(seed.searchTerms || []), seed.sourceSlug, seed.sourceName],
    vars: {
      '--bg-primary': bgPrimary,
      '--accent-wash': mix(bgPrimary, accent, dark ? 0.09 : 0.08),
      '--accent-wash-strong': mix(bgPrimary, accent, dark ? 0.16 : 0.14),
      '--bg-surface': mix(mix(bgPrimary, accent, dark ? 0.09 : 0.08), textPrimary, dark ? 0.04 : 0.015),
      '--bg-elevated': mix(mix(bgPrimary, accent, dark ? 0.16 : 0.14), textPrimary, dark ? 0.08 : 0.025),
      '--bg-input': mix(mix(bgPrimary, accent, dark ? 0.09 : 0.08), dark ? '#000000' : '#ffffff', dark ? 0.18 : 0.18),
      '--accent': accent,
      '--accent-hover': mix(accent, dark ? '#ffffff' : '#000000', dark ? 0.18 : 0.12),
      '--accent-text': chooseAccentText(accent),
      '--text-primary': textPrimary,
      '--text-secondary': mix(textPrimary, bgPrimary, dark ? 0.36 : 0.54),
      '--text-muted': mix(textPrimary, bgPrimary, dark ? 0.64 : 0.72),
      '--border': mix(mix(bgPrimary, accent, dark ? 0.16 : 0.14), textPrimary, dark ? 0.34 : 0.26),
      '--border-strong': mix(mix(bgPrimary, accent, dark ? 0.2 : 0.18), textPrimary, dark ? 0.42 : 0.38),
      '--panel-header-bg': mix(mix(bgPrimary, accent, dark ? 0.09 : 0.08), accent, dark ? 0.08 : 0.07),
      '--nav-hover-bg': mix(mix(bgPrimary, accent, dark ? 0.09 : 0.08), accent, dark ? 0.12 : 0.1),
      '--nav-active-bg': mix(mix(bgPrimary, accent, dark ? 0.16 : 0.14), accent, dark ? 0.2 : 0.16),
      '--control-surface': mix(mix(bgPrimary, accent, dark ? 0.09 : 0.08), accent, dark ? 0.05 : 0.06),
      '--success': success,
      '--warning': warning,
      '--error': error,
      '--info': info,
      '--shadow': dark ? '0 10px 30px rgba(0,0,0,0.34)' : '0 12px 28px rgba(15,23,42,0.08)',
      '--accent-glow': withAlpha(accent, dark ? 0.18 : 0.1),
      '--guardian-halo': `0 0 24px ${withAlpha(accent, dark ? 0.12 : 0.08)}`,
      '--guardian-border': withAlpha(accent, dark ? 0.24 : 0.14),
      '--celestial-gradient': `linear-gradient(135deg, ${withAlpha(accent, dark ? 0.08 : 0.05)}, ${withAlpha(info, dark ? 0.05 : 0.04)})`,
    },
  });
}

const builtInThemes = [
  {
    id: 'guardian-angel',
    name: 'Guardian Agent',
    description: 'Blue gradient with cyan & green accents',
    category: 'dark',
    vars: {
      '--bg-primary': '#080c14',
      '--bg-surface': '#0d1220',
      '--bg-elevated': '#131a2c',
      '--bg-input': '#060a10',
      '--accent': '#4facfe',
      '--accent-hover': '#79c0ff',
      '--accent-text': '#ffffff',
      '--text-primary': '#e2e8f0',
      '--text-secondary': '#8892a8',
      '--text-muted': '#4a5568',
      '--border': '#1a2540',
      '--success': '#34d399',
      '--warning': '#fbbf24',
      '--error': '#f87171',
      '--info': '#38bdf8',
      '--radius': '0',
      '--shadow': '0 2px 12px rgba(0,0,0,0.4)',
      '--accent-glow': 'rgba(79, 172, 254, 0.12)',
      '--guardian-halo': '0 0 20px rgba(79, 172, 254, 0.1)',
      '--guardian-border': 'rgba(79, 172, 254, 0.2)',
      '--celestial-gradient': 'linear-gradient(135deg, rgba(79,172,254,0.05), rgba(52,211,153,0.03))',
    },
  },
  {
    id: 'standard-dark',
    name: 'Standard Dark',
    description: 'Clean neutral dark theme',
    category: 'dark',
    vars: {
      '--bg-primary': '#1a1a1a',
      '--bg-surface': '#242424',
      '--bg-elevated': '#2e2e2e',
      '--bg-input': '#141414',
      '--accent': '#6b9fff',
      '--accent-hover': '#8bb4ff',
      '--accent-text': '#ffffff',
      '--text-primary': '#e0e0e0',
      '--text-secondary': '#999999',
      '--text-muted': '#666666',
      '--border': '#3a3a3a',
      '--success': '#4caf50',
      '--warning': '#ff9800',
      '--error': '#ef5350',
      '--info': '#42a5f5',
      '--radius': '0',
      '--shadow': '0 2px 8px rgba(0,0,0,0.4)',
      '--accent-glow': 'rgba(107, 159, 255, 0.12)',
      '--guardian-halo': '0 0 20px rgba(107, 159, 255, 0.1)',
      '--guardian-border': 'rgba(107, 159, 255, 0.2)',
      '--celestial-gradient': 'linear-gradient(135deg, rgba(107,159,255,0.04), rgba(66,165,245,0.03))',
    },
  },
  {
    id: 'standard-light',
    name: 'Standard Light',
    description: 'Clean neutral light theme',
    category: 'light',
    vars: {
      '--bg-primary': '#f5f5f5',
      '--bg-surface': '#ffffff',
      '--bg-elevated': '#e8e8e8',
      '--bg-input': '#f0f0f0',
      '--accent': '#1a73e8',
      '--accent-hover': '#1565c0',
      '--accent-text': '#ffffff',
      '--text-primary': '#1a1a1a',
      '--text-secondary': '#555555',
      '--text-muted': '#888888',
      '--border': '#d0d0d0',
      '--success': '#2e7d32',
      '--warning': '#e65100',
      '--error': '#c62828',
      '--info': '#1565c0',
      '--radius': '0',
      '--shadow': '0 2px 8px rgba(0,0,0,0.08)',
      '--accent-glow': 'rgba(26, 115, 232, 0.08)',
      '--guardian-halo': '0 0 20px rgba(26, 115, 232, 0.06)',
      '--guardian-border': 'rgba(26, 115, 232, 0.15)',
      '--celestial-gradient': 'linear-gradient(135deg, rgba(26,115,232,0.03), rgba(66,165,245,0.02))',
    },
  },
  {
    id: 'github-dark',
    name: 'GitHub Dark',
    description: 'GitHub dark mode colors',
    category: 'dark',
    vars: {
      '--bg-primary': '#0d1117',
      '--bg-surface': '#161b22',
      '--bg-elevated': '#21262d',
      '--bg-input': '#0d1117',
      '--accent': '#58a6ff',
      '--accent-hover': '#79c0ff',
      '--accent-text': '#ffffff',
      '--text-primary': '#c9d1d9',
      '--text-secondary': '#8b949e',
      '--text-muted': '#484f58',
      '--border': '#30363d',
      '--success': '#3fb950',
      '--warning': '#d29922',
      '--error': '#f85149',
      '--info': '#58a6ff',
      '--radius': '0',
      '--shadow': '0 1px 3px rgba(0,0,0,0.3)',
      '--accent-glow': 'rgba(88, 166, 255, 0.1)',
      '--guardian-halo': '0 0 20px rgba(88, 166, 255, 0.08)',
      '--guardian-border': 'rgba(88, 166, 255, 0.2)',
      '--celestial-gradient': 'linear-gradient(135deg, rgba(88,166,255,0.03), rgba(63,185,80,0.02))',
    },
  },
  {
    id: 'github-light',
    name: 'GitHub Light',
    description: 'GitHub light mode colors',
    category: 'light',
    vars: {
      '--bg-primary': '#f6f8fa',
      '--bg-surface': '#ffffff',
      '--bg-elevated': '#f0f2f5',
      '--bg-input': '#f6f8fa',
      '--accent': '#0969da',
      '--accent-hover': '#0550ae',
      '--accent-text': '#ffffff',
      '--text-primary': '#1f2328',
      '--text-secondary': '#656d76',
      '--text-muted': '#8c959f',
      '--border': '#d0d7de',
      '--success': '#1a7f37',
      '--warning': '#9a6700',
      '--error': '#cf222e',
      '--info': '#0969da',
      '--radius': '0',
      '--shadow': '0 1px 3px rgba(31,35,40,0.04)',
      '--accent-glow': 'rgba(9, 105, 218, 0.06)',
      '--guardian-halo': '0 0 20px rgba(9, 105, 218, 0.05)',
      '--guardian-border': 'rgba(9, 105, 218, 0.15)',
      '--celestial-gradient': 'linear-gradient(135deg, rgba(9,105,218,0.02), rgba(26,127,55,0.02))',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    description: 'Popular dark theme with purple accent',
    category: 'dark',
    vars: {
      '--bg-primary': '#282a36',
      '--bg-surface': '#2d2f3d',
      '--bg-elevated': '#343746',
      '--bg-input': '#21222c',
      '--accent': '#bd93f9',
      '--accent-hover': '#caa8fc',
      '--accent-text': '#1a1a2e',
      '--text-primary': '#f8f8f2',
      '--text-secondary': '#bfbfbf',
      '--text-muted': '#6272a4',
      '--border': '#44475a',
      '--success': '#50fa7b',
      '--warning': '#ffb86c',
      '--error': '#ff5555',
      '--info': '#8be9fd',
      '--radius': '0',
      '--shadow': '0 2px 8px rgba(0,0,0,0.35)',
      '--accent-glow': 'rgba(189, 147, 249, 0.12)',
      '--guardian-halo': '0 0 20px rgba(189, 147, 249, 0.1)',
      '--guardian-border': 'rgba(189, 147, 249, 0.2)',
      '--celestial-gradient': 'linear-gradient(135deg, rgba(189,147,249,0.05), rgba(139,233,253,0.03))',
    },
  },
  {
    id: 'monokai',
    name: 'Monokai Pro',
    description: 'Classic Monokai warm tones',
    category: 'dark',
    vars: {
      '--bg-primary': '#2d2a2e',
      '--bg-surface': '#353236',
      '--bg-elevated': '#403e41',
      '--bg-input': '#262427',
      '--accent': '#ffd866',
      '--accent-hover': '#ffe48a',
      '--accent-text': '#2d2a2e',
      '--text-primary': '#fcfcfa',
      '--text-secondary': '#c1c0c0',
      '--text-muted': '#727072',
      '--border': '#4a474d',
      '--success': '#a9dc76',
      '--warning': '#fc9867',
      '--error': '#ff6188',
      '--info': '#78dce8',
      '--radius': '0',
      '--shadow': '0 2px 8px rgba(0,0,0,0.35)',
      '--accent-glow': 'rgba(255, 216, 102, 0.1)',
      '--guardian-halo': '0 0 20px rgba(255, 216, 102, 0.08)',
      '--guardian-border': 'rgba(255, 216, 102, 0.2)',
      '--celestial-gradient': 'linear-gradient(135deg, rgba(255,216,102,0.04), rgba(120,220,232,0.03))',
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    description: 'Ethan Schoonover\'s precision dark theme',
    category: 'dark',
    vars: {
      '--bg-primary': '#002b36',
      '--bg-surface': '#073642',
      '--bg-elevated': '#0a4050',
      '--bg-input': '#00212b',
      '--accent': '#b58900',
      '--accent-hover': '#d4a017',
      '--accent-text': '#ffffff',
      '--text-primary': '#fdf6e3',
      '--text-secondary': '#93a1a1',
      '--text-muted': '#586e75',
      '--border': '#0f4d5a',
      '--success': '#859900',
      '--warning': '#cb4b16',
      '--error': '#dc322f',
      '--info': '#268bd2',
      '--radius': '0',
      '--shadow': '0 2px 8px rgba(0,0,0,0.3)',
      '--accent-glow': 'rgba(181, 137, 0, 0.12)',
      '--guardian-halo': '0 0 20px rgba(181, 137, 0, 0.1)',
      '--guardian-border': 'rgba(181, 137, 0, 0.2)',
      '--celestial-gradient': 'linear-gradient(135deg, rgba(181,137,0,0.04), rgba(38,139,210,0.03))',
    },
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    description: 'Ethan Schoonover\'s precision light theme',
    category: 'light',
    vars: {
      '--bg-primary': '#fdf6e3',
      '--bg-surface': '#eee8d5',
      '--bg-elevated': '#ddd6c1',
      '--bg-input': '#fdf6e3',
      '--accent': '#268bd2',
      '--accent-hover': '#1a6fb5',
      '--accent-text': '#ffffff',
      '--text-primary': '#002b36',
      '--text-secondary': '#586e75',
      '--text-muted': '#93a1a1',
      '--border': '#c9c2ab',
      '--success': '#859900',
      '--warning': '#cb4b16',
      '--error': '#dc322f',
      '--info': '#268bd2',
      '--radius': '0',
      '--shadow': '0 2px 8px rgba(0,0,0,0.06)',
      '--accent-glow': 'rgba(38, 139, 210, 0.08)',
      '--guardian-halo': '0 0 20px rgba(38, 139, 210, 0.06)',
      '--guardian-border': 'rgba(38, 139, 210, 0.15)',
      '--celestial-gradient': 'linear-gradient(135deg, rgba(38,139,210,0.04), rgba(133,153,0,0.03))',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    description: 'Arctic, north-bluish color palette',
    category: 'dark',
    vars: {
      '--bg-primary': '#2e3440',
      '--bg-surface': '#3b4252',
      '--bg-elevated': '#434c5e',
      '--bg-input': '#272c36',
      '--accent': '#88c0d0',
      '--accent-hover': '#8fbcbb',
      '--accent-text': '#2e3440',
      '--text-primary': '#eceff4',
      '--text-secondary': '#d8dee9',
      '--text-muted': '#616e88',
      '--border': '#4c566a',
      '--success': '#a3be8c',
      '--warning': '#ebcb8b',
      '--error': '#bf616a',
      '--info': '#81a1c1',
      '--radius': '0',
      '--shadow': '0 2px 8px rgba(0,0,0,0.25)',
      '--accent-glow': 'rgba(136, 192, 208, 0.1)',
      '--guardian-halo': '0 0 20px rgba(136, 192, 208, 0.08)',
      '--guardian-border': 'rgba(136, 192, 208, 0.2)',
      '--celestial-gradient': 'linear-gradient(135deg, rgba(136,192,208,0.04), rgba(163,190,140,0.03))',
    },
  },
  {
    id: 'cyberpunk',
    name: 'Cyberpunk 2077',
    description: 'Neon yellow on black, high contrast',
    category: 'dark',
    vars: {
      '--bg-primary': '#0a0a0f',
      '--bg-surface': '#12121a',
      '--bg-elevated': '#1a1a28',
      '--bg-input': '#06060a',
      '--accent': '#fcee09',
      '--accent-hover': '#fff44f',
      '--accent-text': '#0a0a0f',
      '--text-primary': '#e0f0ff',
      '--text-secondary': '#8899aa',
      '--text-muted': '#4a5568',
      '--border': '#1f2937',
      '--success': '#00ff9f',
      '--warning': '#ff6b00',
      '--error': '#ff003c',
      '--info': '#00d4ff',
      '--radius': '0',
      '--shadow': '0 0 15px rgba(252, 238, 9, 0.08)',
      '--accent-glow': 'rgba(252, 238, 9, 0.12)',
      '--guardian-halo': '0 0 25px rgba(252, 238, 9, 0.1)',
      '--guardian-border': 'rgba(252, 238, 9, 0.25)',
      '--celestial-gradient': 'linear-gradient(135deg, rgba(252,238,9,0.04), rgba(0,212,255,0.03))',
    },
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    description: 'Retro groove warm dark theme',
    category: 'dark',
    vars: {
      '--bg-primary': '#282828',
      '--bg-surface': '#32302f',
      '--bg-elevated': '#3c3836',
      '--bg-input': '#1d2021',
      '--accent': '#fe8019',
      '--accent-hover': '#fabd2f',
      '--accent-text': '#1d2021',
      '--text-primary': '#ebdbb2',
      '--text-secondary': '#bdae93',
      '--text-muted': '#7c6f64',
      '--border': '#504945',
      '--success': '#b8bb26',
      '--warning': '#fabd2f',
      '--error': '#fb4934',
      '--info': '#83a598',
      '--radius': '0',
      '--shadow': '0 2px 8px rgba(0,0,0,0.3)',
      '--accent-glow': 'rgba(254, 128, 25, 0.12)',
      '--guardian-halo': '0 0 20px rgba(254, 128, 25, 0.1)',
      '--guardian-border': 'rgba(254, 128, 25, 0.2)',
      '--celestial-gradient': 'linear-gradient(135deg, rgba(254,128,25,0.04), rgba(131,165,152,0.03))',
    },
  },
  {
    id: 'gruvbox-light',
    name: 'Gruvbox Light',
    description: 'Retro groove warm light theme',
    category: 'light',
    vars: {
      '--bg-primary': '#fbf1c7',
      '--bg-surface': '#f2e5bc',
      '--bg-elevated': '#ebdbb2',
      '--bg-input': '#fbf1c7',
      '--accent': '#af3a03',
      '--accent-hover': '#d65d0e',
      '--accent-text': '#fbf1c7',
      '--text-primary': '#3c3836',
      '--text-secondary': '#665c54',
      '--text-muted': '#928374',
      '--border': '#d5c4a1',
      '--success': '#79740e',
      '--warning': '#b57614',
      '--error': '#cc241d',
      '--info': '#076678',
      '--radius': '0',
      '--shadow': '0 2px 8px rgba(0,0,0,0.06)',
      '--accent-glow': 'rgba(175, 58, 3, 0.08)',
      '--guardian-halo': '0 0 20px rgba(175, 58, 3, 0.06)',
      '--guardian-border': 'rgba(175, 58, 3, 0.15)',
      '--celestial-gradient': 'linear-gradient(135deg, rgba(175,58,3,0.04), rgba(7,102,120,0.03))',
    },
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    description: 'Inspired by Tokyo city lights',
    category: 'dark',
    vars: {
      '--bg-primary': '#1a1b26',
      '--bg-surface': '#1f2335',
      '--bg-elevated': '#292e42',
      '--bg-input': '#15161e',
      '--accent': '#7aa2f7',
      '--accent-hover': '#89b4fa',
      '--accent-text': '#ffffff',
      '--text-primary': '#c0caf5',
      '--text-secondary': '#a9b1d6',
      '--text-muted': '#565f89',
      '--border': '#33384f',
      '--success': '#9ece6a',
      '--warning': '#e0af68',
      '--error': '#f7768e',
      '--info': '#7dcfff',
      '--radius': '0',
      '--shadow': '0 2px 8px rgba(0,0,0,0.3)',
      '--accent-glow': 'rgba(122, 162, 247, 0.1)',
      '--guardian-halo': '0 0 20px rgba(122, 162, 247, 0.08)',
      '--guardian-border': 'rgba(122, 162, 247, 0.2)',
      '--celestial-gradient': 'linear-gradient(135deg, rgba(122,162,247,0.04), rgba(125,207,255,0.03))',
    },
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    description: 'Soothing pastel dark theme',
    category: 'dark',
    vars: {
      '--bg-primary': '#1e1e2e',
      '--bg-surface': '#25253a',
      '--bg-elevated': '#313244',
      '--bg-input': '#181825',
      '--accent': '#cba6f7',
      '--accent-hover': '#d4b8fa',
      '--accent-text': '#1e1e2e',
      '--text-primary': '#cdd6f4',
      '--text-secondary': '#a6adc8',
      '--text-muted': '#585b70',
      '--border': '#45475a',
      '--success': '#a6e3a1',
      '--warning': '#f9e2af',
      '--error': '#f38ba8',
      '--info': '#89b4fa',
      '--radius': '0',
      '--shadow': '0 2px 8px rgba(0,0,0,0.25)',
      '--accent-glow': 'rgba(203, 166, 247, 0.1)',
      '--guardian-halo': '0 0 20px rgba(203, 166, 247, 0.08)',
      '--guardian-border': 'rgba(203, 166, 247, 0.2)',
      '--celestial-gradient': 'linear-gradient(135deg, rgba(203,166,247,0.04), rgba(137,180,250,0.03))',
    },
  },
  {
    id: 'one-dark',
    name: 'One Dark Pro',
    description: 'Atom\'s iconic dark theme',
    category: 'dark',
    vars: {
      '--bg-primary': '#282c34',
      '--bg-surface': '#2c313a',
      '--bg-elevated': '#353b45',
      '--bg-input': '#21252b',
      '--accent': '#61afef',
      '--accent-hover': '#79bef5',
      '--accent-text': '#ffffff',
      '--text-primary': '#abb2bf',
      '--text-secondary': '#848b98',
      '--text-muted': '#5c6370',
      '--border': '#3e4452',
      '--success': '#98c379',
      '--warning': '#e5c07b',
      '--error': '#e06c75',
      '--info': '#61afef',
      '--radius': '0',
      '--shadow': '0 2px 8px rgba(0,0,0,0.3)',
      '--accent-glow': 'rgba(97, 175, 239, 0.1)',
      '--guardian-halo': '0 0 20px rgba(97, 175, 239, 0.08)',
      '--guardian-border': 'rgba(97, 175, 239, 0.2)',
      '--celestial-gradient': 'linear-gradient(135deg, rgba(97,175,239,0.04), rgba(152,195,121,0.03))',
    },
  },
  {
    id: 'night-owl',
    name: 'Night Owl',
    description: 'Deep blue editorial dark theme with neon accents',
    category: 'dark',
    vars: {
      '--bg-primary': '#011627',
      '--bg-surface': '#0b1f33',
      '--bg-elevated': '#10263d',
      '--bg-input': '#01111f',
      '--accent': '#82aaff',
      '--accent-hover': '#9cbcff',
      '--accent-text': '#011627',
      '--text-primary': '#d6deeb',
      '--text-secondary': '#9bb0c7',
      '--text-muted': '#637777',
      '--border': '#1d3b53',
      '--success': '#addb67',
      '--warning': '#ffcb8b',
      '--error': '#ef5350',
      '--info': '#7fdbca',
      '--radius': '0',
      '--shadow': '0 2px 10px rgba(0,0,0,0.34)',
      '--accent-glow': 'rgba(130, 170, 255, 0.14)',
      '--guardian-halo': '0 0 20px rgba(130, 170, 255, 0.1)',
      '--guardian-border': 'rgba(130, 170, 255, 0.24)',
      '--celestial-gradient': 'linear-gradient(135deg, rgba(130,170,255,0.05), rgba(127,219,202,0.03))',
    },
  },
  {
    id: 'threat-vector',
    name: 'Threat Vector Security',
    description: 'Neon cyan on black, cybersec ops',
    category: 'dark',
    vars: {
      '--bg-primary': '#000000',
      '--bg-surface': '#0a0a0f',
      '--bg-elevated': '#111118',
      '--bg-input': '#050508',
      '--accent': '#22d3ee',
      '--accent-hover': '#67e8f9',
      '--accent-text': '#050508',
      '--text-primary': '#e0f2fe',
      '--text-secondary': '#94a3b8',
      '--text-muted': '#475569',
      '--border': '#0e3a4a',
      '--success': '#34d399',
      '--warning': '#fbbf24',
      '--error': '#f87171',
      '--info': '#22d3ee',
      '--radius': '0',
      '--shadow': '0 0 12px rgba(34, 211, 238, 0.06)',
      '--accent-glow': 'rgba(34, 211, 238, 0.12)',
      '--guardian-halo': '0 0 25px rgba(34, 211, 238, 0.1)',
      '--guardian-border': 'rgba(34, 211, 238, 0.3)',
      '--celestial-gradient': 'linear-gradient(135deg, rgba(34,211,238,0.05), rgba(52,211,153,0.03))',
    },
  },
  {
    id: 'synthwave',
    name: 'Synthwave \'84',
    description: 'Retro neon pink & purple',
    category: 'dark',
    vars: {
      '--bg-primary': '#1a1028',
      '--bg-surface': '#211834',
      '--bg-elevated': '#2a1f40',
      '--bg-input': '#140c20',
      '--accent': '#ff7edb',
      '--accent-hover': '#ff9de4',
      '--accent-text': '#1a1028',
      '--text-primary': '#f0e0ff',
      '--text-secondary': '#b09ac0',
      '--text-muted': '#6a5a7a',
      '--border': '#3a2a50',
      '--success': '#72f1b8',
      '--warning': '#fede5d',
      '--error': '#fe4450',
      '--info': '#36f9f6',
      '--radius': '0',
      '--shadow': '0 0 15px rgba(255, 126, 219, 0.08)',
      '--accent-glow': 'rgba(255, 126, 219, 0.12)',
      '--guardian-halo': '0 0 25px rgba(255, 126, 219, 0.1)',
      '--guardian-border': 'rgba(255, 126, 219, 0.25)',
      '--celestial-gradient': 'linear-gradient(135deg, rgba(255,126,219,0.05), rgba(54,249,246,0.03))',
    },
  },
];

export const themes = [
  ...builtInThemes.map((theme) => normalizeTheme({
    ...theme,
    collection: 'built-in',
    ...(BUILT_IN_THEME_OVERRIDES[theme.id] || {}),
  })),
  ...CURATED_THEME_SEEDS.map(createCuratedTheme),
];

export function resolveThemeId(themeId) {
  const candidate = THEME_ID_ALIASES[String(themeId || '').trim()] || String(themeId || '').trim();
  return themes.some((theme) => theme.id === candidate) ? candidate : DEFAULT_THEME_ID;
}

export function getThemeDefinition(themeId) {
  const resolvedId = resolveThemeId(themeId);
  return themes.find((theme) => theme.id === resolvedId) || themes[0];
}

function resolveFontPresetId(presetId) {
  const candidate = String(presetId || '').trim() || FOLLOW_THEME_FONT_PRESET_ID;
  return fontPresets.some((preset) => preset.id === candidate) ? candidate : FOLLOW_THEME_FONT_PRESET_ID;
}

function getAppliedThemeId() {
  return document.documentElement?.dataset?.theme || getSavedTheme();
}

function getResolvedFontPreset(themeId, presetId) {
  const requestedId = resolveFontPresetId(presetId);
  if (requestedId === FOLLOW_THEME_FONT_PRESET_ID) {
    const theme = getThemeDefinition(themeId);
    return fontPresets.find((preset) => preset.id === theme.fontPresetId) || fontPresets.find((preset) => preset.id === 'guardian-default');
  }
  return fontPresets.find((preset) => preset.id === requestedId) || fontPresets.find((preset) => preset.id === 'guardian-default');
}

function migrateAppearancePreferences() {
  if (localStorage.getItem(APPEARANCE_VERSION_STORAGE_KEY) === APPEARANCE_VERSION) {
    return;
  }
  const savedFontPreset = localStorage.getItem(FONT_PRESET_STORAGE_KEY);
  if (!savedFontPreset || savedFontPreset === 'guardian-default') {
    localStorage.setItem(FONT_PRESET_STORAGE_KEY, FOLLOW_THEME_FONT_PRESET_ID);
  }
  localStorage.setItem(APPEARANCE_VERSION_STORAGE_KEY, APPEARANCE_VERSION);
}

/** Get saved theme ID or default */
export function getSavedTheme() {
  return resolveThemeId(localStorage.getItem(STORAGE_KEY) || DEFAULT_THEME_ID);
}

export function getSavedFontScale() {
  const raw = Number(localStorage.getItem(FONT_SCALE_STORAGE_KEY) || String(DEFAULT_FONT_SCALE));
  if (!Number.isFinite(raw)) return DEFAULT_FONT_SCALE;
  return Math.min(1.4, Math.max(0.9, raw));
}

export function getSavedFontPreset() {
  return resolveFontPresetId(localStorage.getItem(FONT_PRESET_STORAGE_KEY) || FOLLOW_THEME_FONT_PRESET_ID);
}

export function getSavedReduceMotion() {
  return localStorage.getItem(REDUCE_MOTION_STORAGE_KEY) === 'true';
}

/** Apply a theme by ID to the document */
export function applyTheme(themeId) {
  const theme = getThemeDefinition(themeId);
  const root = document.documentElement;
  for (const [prop, value] of Object.entries(theme.vars)) {
    root.style.setProperty(prop, value);
  }

  localStorage.setItem(STORAGE_KEY, theme.id);
  root.dataset.theme = theme.id;
  root.dataset.themeCategory = theme.category;
  root.dataset.themeCollection = theme.collection || 'built-in';
  root.dataset.themeSource = theme.sourceSlug || theme.id;

  if (!root.dataset.fontPreset || getSavedFontPreset() === FOLLOW_THEME_FONT_PRESET_ID) {
    applyFontPreset(getSavedFontPreset(), { persist: false, themeId: theme.id });
  }

  window.dispatchEvent(new CustomEvent('guardian:appearance-theme-changed', {
    detail: {
      themeId: theme.id,
      category: theme.category,
      collection: theme.collection || 'built-in',
    },
  }));
}

export function applyFontScale(scale) {
  const normalized = Math.min(1.4, Math.max(0.9, Number(scale) || 1));
  document.documentElement.style.setProperty('--font-scale', String(normalized));
  localStorage.setItem(FONT_SCALE_STORAGE_KEY, String(normalized));
}

export function applyFontPreset(presetId, options = {}) {
  const requestedId = resolveFontPresetId(presetId);
  const resolvedPreset = getResolvedFontPreset(options.themeId || getAppliedThemeId(), requestedId);
  const root = document.documentElement;
  for (const [prop, value] of Object.entries(resolvedPreset?.vars || {})) {
    root.style.setProperty(prop, value);
  }
  root.dataset.fontPreset = requestedId;
  root.dataset.fontPresetResolved = resolvedPreset?.id || 'guardian-default';
  if (options.persist !== false) {
    localStorage.setItem(FONT_PRESET_STORAGE_KEY, requestedId);
  }
}

export function applyReduceMotion(enabled) {
  const next = enabled === true;
  document.documentElement.dataset.reduceMotion = next ? 'true' : 'false';
  localStorage.setItem(REDUCE_MOTION_STORAGE_KEY, next ? 'true' : 'false');
}

export function resetAppearancePreferences() {
  applyTheme(DEFAULT_THEME_ID);
  applyFontPreset(FOLLOW_THEME_FONT_PRESET_ID);
  applyFontScale(DEFAULT_FONT_SCALE);
  applyReduceMotion(false);
}

/** Initialize — apply saved theme on page load */
export function initTheme() {
  migrateAppearancePreferences();
  applyTheme(getSavedTheme());
  applyFontPreset(getSavedFontPreset(), { themeId: getSavedTheme() });
  applyFontScale(getSavedFontScale());
  applyReduceMotion(getSavedReduceMotion());
}
