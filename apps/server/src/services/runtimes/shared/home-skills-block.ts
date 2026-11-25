/**
 * The agent's own skills, listed in its context when it works outside its home
 * (DOR-3941).
 *
 * Every runtime finds skills from the working folder: Codex in
 * `<cwd>/.agents/skills`, Claude Code in the project and `~/.claude`. An agent
 * sent to work in a project folder lost the skills in its own home. This block
 * names them, with the path of each `SKILL.md`, so the agent can read one when
 * it applies. It is the same for every runtime because it rides the shared
 * context builder. Nothing is copied into the working folder: that would write
 * into the person's repository.
 *
 * Only the agent's registered home is read, never the working folder, whose
 * skills the runtime already loads (spec `agent-home-desk` I1, I11).
 *
 * @module services/runtimes/shared/home-skills-block
 */
import fs from 'node:fs';
import path from 'node:path';
import { scanSkillDirs, AGENTS_SKILLS_DIR } from '@dorkos/harness/scan';
import { SkillFrontmatterSchema, SKILL_FILENAME } from '@dorkos/skills';
import { parseSkillFile } from '@dorkos/skills/parser';
import type { AgentHome } from '../../core/agent-identity/index.js';

/** At most this many skills are listed, so a large home can't crowd the context. */
export const HOME_SKILLS_LIMIT = 40;
/** A description is cut to this many characters. */
const DESCRIPTION_LIMIT = 200;

/** The folder as the file system sees it, so two spellings of one folder match. */
function realFolder(folder: string): string {
  try {
    return fs.realpathSync(folder);
  } catch {
    return path.resolve(folder);
  }
}

/**
 * Whether `cwd` is the home or a folder inside it, where the runtime already
 * finds the home's skills.
 *
 * @param home - The agent's home.
 * @param cwd - The session's working folder.
 */
export function isInsideHome(home: string, cwd: string): boolean {
  const relative = path.relative(realFolder(home), realFolder(cwd));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** One line of agent-written text, with nothing that could close the block. */
function oneLine(text: string, limit: number): string {
  const flat = text.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/**
 * Build the `<agent_skills>` block, or `''` when the session works inside the
 * home or the home has no skills. It never throws: a skill that can't be read
 * is left out, so a turn always runs.
 *
 * @param home - The agent's registered home.
 * @param cwd - The session's working folder.
 */
export function buildHomeSkillsBlock(home: AgentHome, cwd: string): string {
  if (isInsideHome(home, cwd)) return '';
  const root = path.join(home, AGENTS_SKILLS_DIR);
  const lines: string[] = [];
  const skills = scanSkillDirs(root, AGENTS_SKILLS_DIR, { includeManagedProjections: true });
  for (const skill of skills) {
    if (lines.length === HOME_SKILLS_LIMIT) break;
    const file = path.join(root, skill.name, SKILL_FILENAME);
    try {
      const parsed = parseSkillFile(file, fs.readFileSync(file, 'utf-8'), SkillFrontmatterSchema, {
        requireNameMatch: false,
      });
      if (!parsed.ok) continue;
      const description = oneLine(parsed.definition.meta.description, DESCRIPTION_LIMIT);
      lines.push(`- ${oneLine(skill.name, 80)}: ${description} (${file})`);
    } catch {
      // An unreadable skill is left out; the rest still help.
    }
  }
  if (lines.length === 0) return '';
  if (skills.length > HOME_SKILLS_LIMIT) {
    lines.push(`(${skills.length - HOME_SKILLS_LIMIT} more in ${root})`);
  }
  return [
    '<agent_skills>',
    'You are working outside your home, so your own skills are not loaded here. When one applies, read its SKILL.md first and follow it.',
    ...lines,
    '</agent_skills>',
  ].join('\n');
}
