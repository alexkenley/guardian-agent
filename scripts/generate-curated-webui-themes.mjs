import { promises as fs } from 'node:fs';
import path from 'node:path';

const SOURCE_ROOT = process.env.AWESOME_DESIGN_MD_ROOT || '/mnt/s/Development/awesome-design-md/design-md';
const OUTPUT_FILE = path.resolve('web/public/js/curated-theme-seeds.js');

const THEME_OVERRIDES = {
  airbnb: { name: 'Hearth Coral', fontPresetId: 'rounded-sans', geometry: 'soft' },
  airtable: { name: 'Grid Current', fontPresetId: 'precision-sans', geometry: 'crisp' },
  apple: { name: 'Silver Orchard', fontPresetId: 'apple-sans', geometry: 'crisp' },
  bmw: { name: 'Autobahn Blue', fontPresetId: 'precision-sans', geometry: 'crisp' },
  cal: { name: 'Clockwork', fontPresetId: 'precision-sans', geometry: 'crisp' },
  claude: { name: 'Terracotta Letter', fontPresetId: 'editorial-warm', geometry: 'soft' },
  clay: { name: 'Studio Bloom', fontPresetId: 'editorial-warm', geometry: 'soft' },
  clickhouse: { name: 'Canary Query', fontPresetId: 'mono-sans', geometry: 'sharp' },
  cohere: { name: 'Cluster Weave', fontPresetId: 'precision-sans', geometry: 'soft' },
  coinbase: { name: 'Ledger Blue', fontPresetId: 'precision-sans', geometry: 'crisp' },
  composio: { name: 'Connector Night', fontPresetId: 'signal-sans', geometry: 'soft' },
  cursor: { name: 'Prism Draft', fontPresetId: 'precision-sans', geometry: 'soft' },
  elevenlabs: { name: 'Echo Cinema', fontPresetId: 'premium-sans', geometry: 'soft' },
  expo: { name: 'Native Midnight', fontPresetId: 'mono-sans', geometry: 'sharp' },
  ferrari: { name: 'Rosso Velocity', fontPresetId: 'premium-sans', geometry: 'crisp' },
  figma: { name: 'Primary Playground', fontPresetId: 'precision-sans', geometry: 'soft' },
  framer: { name: 'Motion Signal', fontPresetId: 'precision-sans', geometry: 'sharp' },
  hashicorp: { name: 'Infra Slate', fontPresetId: 'carbon-sans', geometry: 'crisp' },
  ibm: { name: 'Carbon Grid', fontPresetId: 'carbon-sans', geometry: 'crisp' },
  intercom: { name: 'Conversational Sky', fontPresetId: 'rounded-sans', geometry: 'soft' },
  kraken: { name: 'Deep Exchange', fontPresetId: 'precision-sans', geometry: 'crisp' },
  lamborghini: { name: 'Gold Cathedral', fontPresetId: 'premium-sans', geometry: 'crisp' },
  'linear.app': { name: 'Indigo Vector', fontPresetId: 'precision-sans', geometry: 'sharp' },
  lovable: { name: 'Soft Aurora', fontPresetId: 'rounded-sans', geometry: 'soft' },
  minimax: { name: 'Reactor Bloom', fontPresetId: 'signal-sans', geometry: 'soft' },
  mintlify: { name: 'Mint Reference', fontPresetId: 'precision-sans', geometry: 'crisp' },
  miro: { name: 'Boardlight Yellow', fontPresetId: 'rounded-sans', geometry: 'soft' },
  'mistral.ai': { name: 'Alpine Ember', fontPresetId: 'precision-sans', geometry: 'soft' },
  mongodb: { name: 'Evergreen Atlas', fontPresetId: 'carbon-sans', geometry: 'crisp' },
  notion: { name: 'Paper Ledger', fontPresetId: 'editorial-warm', geometry: 'soft' },
  nvidia: { name: 'Compute Green', fontPresetId: 'signal-sans', geometry: 'crisp' },
  ollama: { name: 'Quiet Mono', fontPresetId: 'rounded-sans', geometry: 'round' },
  'opencode.ai': { name: 'Forge Terminal', fontPresetId: 'mono-sans', geometry: 'sharp' },
  pinterest: { name: 'Mason Scarlet', fontPresetId: 'rounded-sans', geometry: 'soft' },
  posthog: { name: 'Hedge Ember', fontPresetId: 'precision-sans', geometry: 'soft' },
  raycast: { name: 'Command Prism', fontPresetId: 'precision-sans', geometry: 'sharp' },
  renault: { name: 'Aurora Circuit', fontPresetId: 'precision-sans', geometry: 'crisp' },
  replicate: { name: 'Model Canvas', fontPresetId: 'precision-sans', geometry: 'crisp' },
  resend: { name: 'Mail Mono', fontPresetId: 'mono-sans', geometry: 'crisp' },
  revolut: { name: 'Velocity Finance', fontPresetId: 'premium-sans', geometry: 'soft' },
  runwayml: { name: 'Cinema Render', fontPresetId: 'premium-sans', geometry: 'soft' },
  sanity: { name: 'Editorial Redline', fontPresetId: 'precision-sans', geometry: 'crisp' },
  sentry: { name: 'Signal Orchid', fontPresetId: 'precision-sans', geometry: 'crisp' },
  spacex: { name: 'Orbital Black', fontPresetId: 'precision-sans', geometry: 'sharp' },
  spotify: { name: 'Pulse Green', fontPresetId: 'precision-sans', geometry: 'soft' },
  stripe: { name: 'Ledger Violet', fontPresetId: 'premium-sans', geometry: 'crisp' },
  supabase: { name: 'Open Emerald', fontPresetId: 'signal-sans', geometry: 'crisp' },
  superhuman: { name: 'Velocity Glow', fontPresetId: 'premium-sans', geometry: 'soft' },
  tesla: { name: 'Minimal Drive', fontPresetId: 'precision-sans', geometry: 'crisp' },
  'together.ai': { name: 'Blueprint Fusion', fontPresetId: 'precision-sans', geometry: 'crisp' },
  uber: { name: 'Metro Mono', fontPresetId: 'precision-sans', geometry: 'sharp' },
  vercel: { name: 'Zero Gravity', fontPresetId: 'precision-sans', geometry: 'sharp' },
  voltagent: { name: 'Signal Forge', fontPresetId: 'signal-sans', geometry: 'crisp' },
  warp: { name: 'Campfire Terminal', fontPresetId: 'matter-sans', geometry: 'soft' },
  webflow: { name: 'Flow Electric', fontPresetId: 'precision-sans', geometry: 'soft' },
  wise: { name: 'Transfer Lime', fontPresetId: 'rounded-sans', geometry: 'soft' },
  'x.ai': { name: 'Monolith X', fontPresetId: 'precision-sans', geometry: 'sharp' },
  zapier: { name: 'Automation Ember', fontPresetId: 'rounded-sans', geometry: 'soft' },
};

const FALLBACK_SEMANTICS = {
  success: '#10b981',
  warning: '#f59e0b',
  error: '#ef4444',
  info: '#3b82f6',
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function titleCase(value) {
  return value
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeHex(hex) {
  return String(hex || '').trim().toLowerCase();
}

function hexToRgb(hex) {
  const value = normalizeHex(hex).replace('#', '');
  const normalized = value.length === 3
    ? value.split('').map((char) => char + char).join('')
    : value;
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

function rgbToHsl({ r, g, b }) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  switch (max) {
    case rn:
      h = (gn - bn) / d + (gn < bn ? 6 : 0);
      break;
    case gn:
      h = (bn - rn) / d + 2;
      break;
    default:
      h = (rn - gn) / d + 4;
      break;
  }
  return { h: h * 60, s, l };
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

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [lighter, darker] = la >= lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
}

function saturation(hex) {
  return rgbToHsl(hexToRgb(hex)).s;
}

function hue(hex) {
  return rgbToHsl(hexToRgb(hex)).h;
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

function chooseText(colors, background) {
  return [...colors]
    .sort((a, b) => contrast(b, background) - contrast(a, background))[0] || (luminance(background) > 0.5 ? '#111111' : '#f5f5f5');
}

function chooseAccent(colors, background, text) {
  const candidates = [...colors].filter((hex) => normalizeHex(hex) !== normalizeHex(background) && normalizeHex(hex) !== normalizeHex(text));
  const scored = candidates
    .map((hex) => ({
      hex,
      score: (saturation(hex) * 2.5) + (contrast(hex, background) * 0.35),
    }))
    .sort((a, b) => b.score - a.score);
  return scored[0]?.hex || (luminance(background) > 0.5 ? '#2563eb' : '#60a5fa');
}

function chooseByHue(colors, ranges) {
  const matches = colors.filter((hex) => {
    const h = hue(hex);
    return ranges.some(([min, max]) => {
      if (min <= max) return h >= min && h <= max;
      return h >= min || h <= max;
    });
  });
  return matches.sort((a, b) => saturation(b) - saturation(a))[0] || null;
}

function slugToId(slug) {
  return `curated-${slug.replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase()}`;
}

async function main() {
  const entries = await fs.readdir(SOURCE_ROOT, { withFileTypes: true });
  const slugs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const seeds = [];

  for (const slug of slugs) {
    const designPath = path.join(SOURCE_ROOT, slug, 'DESIGN.md');
    const text = await fs.readFile(designPath, 'utf8');
    const colors = [...new Set([...text.matchAll(/#[0-9a-fA-F]{6}/g)].map((match) => normalizeHex(match[0])))];
    if (colors.length === 0) continue;

    const background = colors[0];
    const textPrimary = chooseText(colors, background);
    const accent = chooseAccent(colors, background, textPrimary);
    const success = chooseByHue(colors, [[90, 170]]) || FALLBACK_SEMANTICS.success;
    const warning = chooseByHue(colors, [[30, 75]]) || FALLBACK_SEMANTICS.warning;
    const error = chooseByHue(colors, [[345, 360], [0, 20]]) || FALLBACK_SEMANTICS.error;
    const info = chooseByHue(colors, [[180, 260]]) || accent || FALLBACK_SEMANTICS.info;
    const override = THEME_OVERRIDES[slug] || {
      name: titleCase(slug),
      fontPresetId: 'precision-sans',
      geometry: 'crisp',
    };

    seeds.push({
      id: slugToId(slug),
      name: override.name,
      description: `Curated bundle inspired by ${titleCase(slug)} from awesome-design-md.`,
      category: luminance(background) > 0.72 ? 'light' : 'dark',
      collection: 'curated',
      sourceSlug: slug,
      sourceName: titleCase(slug),
      fontPresetId: override.fontPresetId,
      geometry: override.geometry,
      colors: {
        bgPrimary: background,
        textPrimary,
        accent,
        success,
        warning,
        error,
        info,
      },
      palette: colors.slice(0, 10),
      searchTerms: [...new Set([
        slug,
        titleCase(slug).toLowerCase(),
        override.name.toLowerCase(),
      ])],
    });
  }

  const file = `/**\n * Generated by scripts/generate-curated-webui-themes.mjs\n * Source: awesome-design-md\n */\n\nexport const CURATED_THEME_SEEDS = ${JSON.stringify(seeds, null, 2)};\n`;
  await fs.writeFile(OUTPUT_FILE, file, 'utf8');
  console.log(`Wrote ${seeds.length} curated theme seeds to ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
