import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createLogger } from '../util/logging.js';
import type { LoadedSkill, SkillManifest } from './types.js';

const log = createLogger('skills:registry');

export class SkillRegistry {
  private readonly skills = new Map<string, LoadedSkill>();

  list(): LoadedSkill[] {
    return [...this.skills.values()];
  }

  get(id: string): LoadedSkill | undefined {
    return this.skills.get(id);
  }

  async loadFromRoots(roots: readonly string[], disabledSkillIds: readonly string[] = []): Promise<void> {
    this.skills.clear();
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
        if (disabled.has(skill.manifest.id)) continue;
        if (this.skills.has(skill.manifest.id)) {
          log.warn({ id: skill.manifest.id, root: skillDir }, 'Duplicate skill id ignored');
          continue;
        }
        this.skills.set(skill.manifest.id, skill);
      }
    }
  }
}

async function loadSkill(skillDir: string): Promise<LoadedSkill | null> {
  const manifestPath = join(skillDir, 'skill.json');
  const instructionPath = join(skillDir, 'SKILL.md');

  try {
    const [manifestRaw, instruction] = await Promise.all([
      readFile(manifestPath, 'utf-8'),
      readFile(instructionPath, 'utf-8'),
    ]);
    const manifest = JSON.parse(manifestRaw) as SkillManifest;
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
