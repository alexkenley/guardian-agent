import type { ResolvedSkill } from './types.js';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatAvailableSkillsPrompt(
  skills: readonly ResolvedSkill[],
  readToolName: string = 'fs_read',
): string {
  if (skills.length === 0) return '';

  const lines = [
    '## Skills (mandatory)',
    'Before any reply, clarifying question, or tool call: scan the <available_skills> entries.',
    `- If a listed skill is relevant, read its SKILL.md at <location> with \`${readToolName}\` before acting.`,
    '- If both a process skill and a domain skill are clearly relevant, read the process skill first, then the domain skill if still needed.',
    '- If multiple skills of the same role could apply, choose the most specific one.',
    '- If none clearly apply: do not read any SKILL.md.',
    '- Never rely on skill metadata alone when a listed skill is clearly relevant; read the SKILL.md first.',
    '- Read at most two SKILL.md files up front: one process skill and one domain skill. Load referenced files only when needed.',
    '<available_skills>',
  ];

  for (const skill of skills) {
    lines.push('  <skill>');
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    if (skill.role) lines.push(`    <role>${escapeXml(skill.role)}</role>`);
    lines.push(`    <location>${escapeXml(skill.sourcePath)}</location>`);
    lines.push('  </skill>');
  }

  lines.push('</available_skills>');
  return lines.join('\n');
}
