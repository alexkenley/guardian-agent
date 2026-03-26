/**
 * Theme manager — global CSS variable theming with 18 built-in themes.
 * Persists selection to localStorage. Applies to :root on load.
 */

const STORAGE_KEY = 'guardianagent_theme';
const FONT_SCALE_STORAGE_KEY = 'guardianagent_font_scale';
const FONT_PRESET_STORAGE_KEY = 'guardianagent_font_preset';
const REDUCE_MOTION_STORAGE_KEY = 'guardianagent_reduce_motion';

export const fontPresets = [
  {
    id: 'guardian-default',
    name: 'Guardian Default',
    description: 'Current Guardian typography stack with Cascadia Code and Inter.',
    vars: {
      '--font-mono': "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace",
      '--font-sans': "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      '--font-display': "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    },
  },
  {
    id: 'system-sans',
    name: 'System Sans',
    description: 'Neutral system UI stack with broad platform coverage.',
    vars: {
      '--font-mono': "'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif",
      '--font-sans': "'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif",
      '--font-display': "'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif",
    },
  },
  {
    id: 'readable-sans',
    name: 'Readable Sans',
    description: 'Accessibility-first sans serif stack with strong fallback coverage.',
    vars: {
      '--font-mono': "'Atkinson Hyperlegible', 'Lexend', 'Segoe UI', sans-serif",
      '--font-sans': "'Atkinson Hyperlegible', 'Lexend', 'Segoe UI', sans-serif",
      '--font-display': "'Atkinson Hyperlegible', 'Lexend', 'Segoe UI', sans-serif",
    },
  },
  {
    id: 'verdana-clear',
    name: 'Verdana Clear',
    description: 'Wider letterforms and familiar Windows readability.',
    vars: {
      '--font-mono': "Verdana, Geneva, sans-serif",
      '--font-sans': "Verdana, Geneva, sans-serif",
      '--font-display': "Verdana, Geneva, sans-serif",
    },
  },
  {
    id: 'georgia-serif',
    name: 'Georgia Serif',
    description: 'Serif reading mode for longer-form text and softer contrast.',
    vars: {
      '--font-mono': "Georgia, 'Times New Roman', serif",
      '--font-sans': "Georgia, 'Times New Roman', serif",
      '--font-display': "Georgia, 'Times New Roman', serif",
    },
  },
];

export const themes = [
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
      '--radius': '6px',
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
      '--radius': '6px',
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
      '--radius': '6px',
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
      '--radius': '6px',
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
      '--radius': '6px',
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
      '--radius': '6px',
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
      '--radius': '6px',
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
      '--radius': '6px',
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
      '--radius': '6px',
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
      '--radius': '6px',
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
      '--radius': '2px',
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
      '--radius': '4px',
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
      '--radius': '4px',
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
      '--radius': '6px',
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
      '--radius': '8px',
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
      '--radius': '4px',
      '--shadow': '0 2px 8px rgba(0,0,0,0.3)',
      '--accent-glow': 'rgba(97, 175, 239, 0.1)',
      '--guardian-halo': '0 0 20px rgba(97, 175, 239, 0.08)',
      '--guardian-border': 'rgba(97, 175, 239, 0.2)',
      '--celestial-gradient': 'linear-gradient(135deg, rgba(97,175,239,0.04), rgba(152,195,121,0.03))',
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
      '--radius': '4px',
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
      '--radius': '6px',
      '--shadow': '0 0 15px rgba(255, 126, 219, 0.08)',
      '--accent-glow': 'rgba(255, 126, 219, 0.12)',
      '--guardian-halo': '0 0 25px rgba(255, 126, 219, 0.1)',
      '--guardian-border': 'rgba(255, 126, 219, 0.25)',
      '--celestial-gradient': 'linear-gradient(135deg, rgba(255,126,219,0.05), rgba(54,249,246,0.03))',
    },
  },
];

/** Get saved theme ID or default */
export function getSavedTheme() {
  return localStorage.getItem(STORAGE_KEY) || 'guardian-angel';
}

export function getSavedFontScale() {
  const raw = Number(localStorage.getItem(FONT_SCALE_STORAGE_KEY) || '1.05');
  if (!Number.isFinite(raw)) return 1.05;
  return Math.min(1.4, Math.max(0.9, raw));
}

export function getSavedFontPreset() {
  const saved = localStorage.getItem(FONT_PRESET_STORAGE_KEY) || 'guardian-default';
  return fontPresets.some((preset) => preset.id === saved) ? saved : 'guardian-default';
}

export function getSavedReduceMotion() {
  return localStorage.getItem(REDUCE_MOTION_STORAGE_KEY) === 'true';
}

/** Apply a theme by ID to the document */
export function applyTheme(themeId) {
  const theme = themes.find(t => t.id === themeId);
  if (!theme) return;

  const root = document.documentElement;
  for (const [prop, value] of Object.entries(theme.vars)) {
    root.style.setProperty(prop, value);
  }

  localStorage.setItem(STORAGE_KEY, themeId);
  document.documentElement.dataset.theme = themeId;
}

export function applyFontScale(scale) {
  const normalized = Math.min(1.4, Math.max(0.9, Number(scale) || 1));
  document.documentElement.style.setProperty('--font-scale', String(normalized));
  localStorage.setItem(FONT_SCALE_STORAGE_KEY, String(normalized));
}

export function applyFontPreset(presetId) {
  const preset = fontPresets.find((entry) => entry.id === presetId) || fontPresets[0];
  const root = document.documentElement;
  for (const [prop, value] of Object.entries(preset.vars)) {
    root.style.setProperty(prop, value);
  }
  root.dataset.fontPreset = preset.id;
  localStorage.setItem(FONT_PRESET_STORAGE_KEY, preset.id);
}

export function applyReduceMotion(enabled) {
  const next = enabled === true;
  document.documentElement.dataset.reduceMotion = next ? 'true' : 'false';
  localStorage.setItem(REDUCE_MOTION_STORAGE_KEY, next ? 'true' : 'false');
}

export function resetAppearancePreferences() {
  applyTheme('guardian-angel');
  applyFontPreset('guardian-default');
  applyFontScale(1.05);
  applyReduceMotion(false);
}

/** Initialize — apply saved theme on page load */
export function initTheme() {
  applyTheme(getSavedTheme());
  applyFontPreset(getSavedFontPreset());
  applyFontScale(getSavedFontScale());
  applyReduceMotion(getSavedReduceMotion());
}
