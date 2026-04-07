import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import yaml from 'js-yaml';
import { createLogger } from '../util/logging.js';
import type {
  SkillArtifactReference,
  LoadedSkill,
  SkillManifest,
  SkillMaterialLoad,
  SkillMaterialLoadOptions,
  SkillPromptMaterialCache,
  SkillResourceEntry,
  SkillStatus,
} from './types.js';

const log = createLogger('skills:registry');

export class SkillRegistry {
  private readonly skills = new Map<string, LoadedSkill>();
  private readonly runtimeDisabled = new Set<string>();

  list(): LoadedSkill[] {
    return [...this.skills.values()].filter((skill) => !this.runtimeDisabled.has(skill.manifest.id));
  }

  listStatus(): SkillStatus[] {
    return [...this.skills.values()]
      .map((skill) => ({
        id: skill.manifest.id,
        name: skill.manifest.name,
        version: skill.manifest.version,
        description: skill.manifest.description,
        role: skill.manifest.role,
        tags: [...(skill.manifest.tags ?? [])],
        enabled: !this.runtimeDisabled.has(skill.manifest.id),
        rootDir: skill.rootDir,
        sourcePath: skill.instructionPath,
        risk: skill.manifest.risk ?? 'informational',
        tools: [...(skill.manifest.tools ?? [])],
        requiredCapabilities: [...(skill.manifest.requiredCapabilities ?? [])],
        requiredManagedProvider: skill.manifest.requiredManagedProvider,
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  get(id: string): LoadedSkill | undefined {
    return this.skills.get(id);
  }

  isEnabled(id: string): boolean {
    return this.skills.has(id) && !this.runtimeDisabled.has(id);
  }

  enable(id: string): boolean {
    if (!this.skills.has(id)) return false;
    this.runtimeDisabled.delete(id);
    return true;
  }

  disable(id: string): boolean {
    if (!this.skills.has(id)) return false;
    this.runtimeDisabled.add(id);
    return true;
  }

  loadPromptMaterial(
    skillIds: readonly string[],
    options: SkillMaterialLoadOptions = {},
    cache?: SkillPromptMaterialCache,
  ): SkillMaterialLoad[] {
    const maxInstructionChars = Math.max(400, options.maxInstructionChars ?? 2400);
    const maxResourceChars = Math.max(200, options.maxResourceChars ?? 1600);
    const maxResources = Math.max(0, options.maxResources ?? 2);
    const seen = new Set<string>();
    const loads: SkillMaterialLoad[] = [];

    for (const skillId of skillIds) {
      const normalizedId = skillId.trim();
      if (!normalizedId || seen.has(normalizedId) || !this.isEnabled(normalizedId)) continue;
      seen.add(normalizedId);
      const skill = this.skills.get(normalizedId);
      if (!skill) continue;

      const cacheHits: string[] = [];
      const instructionCacheKey = `${normalizedId}:instruction`;
      const cachedInstruction = cache?.get(instructionCacheKey);
      const instructionSource = cachedInstruction ?? skill.instruction;
      if (cachedInstruction) cacheHits.push(instructionCacheKey);
      else cache?.set(instructionCacheKey, skill.instruction);

      const resources = skill.resources.slice(0, maxResources).map((resource) => {
        const resourceCacheKey = `${normalizedId}:resource:${resource.path}`;
        const cachedResource = cache?.get(resourceCacheKey);
        const content = cachedResource ?? readSkillResourceSync(skill.rootDir, resource.path);
        if (cachedResource) cacheHits.push(resourceCacheKey);
        else cache?.set(resourceCacheKey, content);
        const truncated = truncateContent(content, maxResourceChars);
        return {
          path: resource.path,
          kind: resource.kind,
          content: truncated.content,
          truncated: truncated.truncated,
        };
      });

      const truncatedInstruction = truncateContent(instructionSource, maxInstructionChars);
      loads.push({
        skillId: normalizedId,
        instruction: {
          path: relative(skill.rootDir, skill.instructionPath) || 'SKILL.md',
          content: truncatedInstruction.content,
          truncated: truncatedInstruction.truncated,
        },
        resources,
        cacheHits,
      });
    }

    return loads;
  }

  async loadFromRoots(roots: readonly string[], disabledSkillIds: readonly string[] = []): Promise<void> {
    this.skills.clear();
    this.runtimeDisabled.clear();
    const disabled = new Set(disabledSkillIds.map((value) => value.trim()).filter(Boolean));
    for (const root of roots) {
      const resolvedRoot = resolve(root);
      let entries;
      try {
        entries = await readdir(resolvedRoot, { withFileTypes: true });
      } catch (err) {
        log.warn({ root: resolvedRoot, err: err instanceof Error ? err.message : String(err) }, 'Failed to read skills root');
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillDir = join(resolvedRoot, entry.name);
        const skill = await loadSkill(skillDir);
        if (!skill) continue;
        if (this.skills.has(skill.manifest.id)) {
          log.warn({ id: skill.manifest.id, root: skillDir }, 'Duplicate skill id ignored');
          continue;
        }
        this.skills.set(skill.manifest.id, skill);
        if (skill.manifest.enabled === false) {
          this.runtimeDisabled.add(skill.manifest.id);
        }
      }
    }
    for (const id of disabled) {
      if (this.skills.has(id)) this.runtimeDisabled.add(id);
    }
  }
}

function truncateContent(content: string, maxChars: number): { content: string; truncated: boolean } {
  const normalized = content.trim();
  if (normalized.length <= maxChars) return { content: normalized, truncated: false };
  return {
    content: `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`,
    truncated: true,
  };
}

function readSkillResourceSync(rootDir: string, resourcePath: string): string {
  const absolutePath = join(rootDir, resourcePath);
  return readFileSync(absolutePath, 'utf-8').trim();
}

function collectSkillResources(skillDir: string): SkillResourceEntry[] {
  const resourceDirs: Array<{ dir: string; kind: SkillResourceEntry['kind'] }> = [
    { dir: 'references', kind: 'reference' },
    { dir: 'templates', kind: 'template' },
    { dir: 'examples', kind: 'example' },
    { dir: 'assets', kind: 'asset' },
    { dir: 'scripts', kind: 'script' },
  ];
  const entries: SkillResourceEntry[] = [];
  for (const { dir, kind } of resourceDirs) {
    const absoluteDir = join(skillDir, dir);
    if (!existsSync(absoluteDir)) continue;
    const names = readdirSync(absoluteDir, { withFileTypes: true });
    for (const entry of names) {
      if (!entry.isFile()) continue;
      entries.push({ path: `${dir}/${entry.name}`, kind });
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function chooseDefaultSkillResources(instruction: string, resources: SkillResourceEntry[]): SkillResourceEntry[] {
  const normalizedInstruction = instruction.toLowerCase();
  const referenced = resources.filter((resource) => normalizedInstruction.includes(resource.path.toLowerCase()));
  return referenced.length > 0 ? referenced : resources;
}

async function loadSkill(skillDir: string): Promise<LoadedSkill | null> {
  const manifestPath = join(skillDir, 'skill.json');
  const instructionPath = join(skillDir, 'SKILL.md');

  try {
    const instructionRaw = await readFile(instructionPath, 'utf-8');
    const nativeManifestRaw = await readFile(manifestPath, 'utf-8').catch((err: NodeJS.ErrnoException) => {
      if (err?.code === 'ENOENT') return null;
      throw err;
    });
    const loaded = nativeManifestRaw
      ? loadNativeSkill(nativeManifestRaw, instructionRaw)
      : loadFrontmatterSkill(instructionRaw);
    if (!loaded) {
      log.warn({ skillDir }, 'Skipping skill with invalid manifest or frontmatter');
      return null;
    }
    const { manifest, instruction } = loaded;
    if (!manifest.id?.trim() || !manifest.name?.trim()) {
      log.warn({ skillDir }, 'Skipping skill with missing id or name');
      return null;
    }
    const normalizedInstruction = instruction.trim();
    if (!normalizedInstruction) {
      log.warn({ skillDir, id: manifest.id }, 'Skipping skill with empty SKILL.md');
      return null;
    }
    const resources = chooseDefaultSkillResources(normalizedInstruction, collectSkillResources(skillDir));
    return {
      manifest,
      rootDir: skillDir,
      instructionPath,
      instruction: normalizedInstruction,
      summary: summarizeSkill(normalizedInstruction, 700),
      resources,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return null;
    }
    log.warn({ skillDir, err: err instanceof Error ? err.message : String(err) }, 'Failed to load skill');
    return null;
  }
}

function summarizeSkill(text: string, maxChars: number): string {
  const lines = text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  let out = '';
  for (const line of lines) {
    const next = out ? `${out}\n${line}` : line;
    if (next.length > maxChars) break;
    out = next;
  }
  return out || text.slice(0, maxChars);
}

function loadNativeSkill(manifestRaw: string, instructionRaw: string): { manifest: SkillManifest; instruction: string } | null {
  const manifest = normalizeManifest(JSON.parse(manifestRaw) as SkillManifest);
  const instruction = stripFrontmatter(instructionRaw).trim();
  return { manifest, instruction };
}

function loadFrontmatterSkill(instructionRaw: string): { manifest: SkillManifest; instruction: string } | null {
  const parsed = parseFrontmatter(instructionRaw);
  if (!parsed) return null;
  const id = normalizeIdentifier(parsed.data.name);
  const description = typeof parsed.data.description === 'string' ? parsed.data.description.trim() : '';
  if (!id || !description) return null;
  const instruction = parsed.body.trim();
  const heading = extractFirstHeading(instruction);
  return {
    manifest: normalizeManifest({
      id,
      name: heading || humanizeIdentifier(id),
      version: '0.0.0-compat',
      description,
      enabled: true,
      risk: 'informational',
      appliesTo: {
        requestTypes: ['chat'],
      },
    }),
    instruction,
  };
}

function normalizeManifest(manifest: SkillManifest): SkillManifest {
  const artifactReferences = normalizeArtifactReferences((manifest as { artifactReferences?: unknown }).artifactReferences);
  return {
    ...manifest,
    ...(artifactReferences.length > 0 ? { artifactReferences } : {}),
  };
}

function normalizeArtifactReferences(value: unknown): SkillArtifactReference[] {
  if (!Array.isArray(value)) return [];
  const refs: SkillArtifactReference[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const slug = entry.trim();
      if (!slug) continue;
      refs.push({ slug, scope: 'global' });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const slug = typeof entry.slug === 'string' ? entry.slug.trim() : '';
    if (!slug) continue;
    refs.push({
      slug,
      ...(entry.scope === 'coding_session' ? { scope: 'coding_session' } : { scope: 'global' }),
      ...(typeof entry.title === 'string' && entry.title.trim() ? { title: entry.title.trim() } : {}),
    });
  }
  return refs;
}

function parseFrontmatter(instructionRaw: string): { data: Record<string, unknown>; body: string } | null {
  const match = instructionRaw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return null;
  const data = yaml.load(match[1], { schema: yaml.JSON_SCHEMA });
  if (!data || typeof data !== 'object') return null;
  return {
    data: data as Record<string, unknown>,
    body: instructionRaw.slice(match[0].length),
  };
}

function stripFrontmatter(instructionRaw: string): string {
  return parseFrontmatter(instructionRaw)?.body ?? instructionRaw;
}

function extractFirstHeading(instruction: string): string {
  for (const line of instruction.split(/\r?\n/g)) {
    const match = line.match(/^#\s+(.+?)\s*$/);
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function normalizeIdentifier(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function humanizeIdentifier(id: string): string {
  return id
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
