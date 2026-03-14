import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { createLogger } from '../util/logging.js';
import type { LoadedSkill, SkillManifest, SkillStatus } from './types.js';

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
      }
    }
    for (const id of disabled) {
      if (this.skills.has(id)) this.runtimeDisabled.add(id);
    }
  }
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
    if (manifest.enabled === false) {
      return null;
    }
    const normalizedInstruction = instruction.trim();
    if (!normalizedInstruction) {
      log.warn({ skillDir, id: manifest.id }, 'Skipping skill with empty SKILL.md');
      return null;
    }
    return {
      manifest,
      rootDir: skillDir,
      instructionPath,
      instruction: normalizedInstruction,
      summary: summarizeSkill(normalizedInstruction, 700),
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
  const manifest = JSON.parse(manifestRaw) as SkillManifest;
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
    manifest: {
      id,
      name: heading || humanizeIdentifier(id),
      version: '0.0.0-compat',
      description,
      enabled: true,
      risk: 'informational',
      appliesTo: {
        requestTypes: ['chat'],
      },
    },
    instruction,
  };
}

function parseFrontmatter(instructionRaw: string): { data: Record<string, unknown>; body: string } | null {
  const match = instructionRaw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return null;
  const data = yaml.load(match[1]);
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
