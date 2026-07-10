/**
 * Project-skill → slash-command projection for the Codex runtime.
 *
 * Codex's built-in TUI commands cannot run under `codex exec`, and the SDK
 * exposes no command-discovery API, so DorkOS does not fake Codex's own
 * commands. Instead it surfaces the project's authored skills (`.agents/skills`)
 * as slash commands — the same skills Claude's SDK exposes from `.claude/skills`
 * — giving Codex sessions a real, project-scoped command palette.
 *
 * @module services/runtimes/codex/scan-skill-commands
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanSkillDirs, AGENTS_SKILLS_DIR } from '@dorkos/harness/scan';
import { SkillFrontmatterSchema, SKILL_FILENAME } from '@dorkos/skills';
import { parseSkillFile } from '@dorkos/skills/parser';
import type { CommandEntry } from '@dorkos/shared/types';
import { logger } from '../../../lib/logger.js';

/**
 * Enumerate the project's authored skills under `<cwd>/.agents/skills` and map
 * each to a {@link CommandEntry} (`/<name>`, described by the skill's SKILL.md
 * frontmatter). A skill whose SKILL.md is unreadable or has invalid frontmatter
 * is skipped rather than failing the whole scan; a missing skills directory
 * yields an empty list. Results are sorted by command for a deterministic palette.
 *
 * @param cwd - Absolute project directory whose `.agents/skills` is scanned.
 */
export function scanSkillCommands(cwd: string): CommandEntry[] {
  const skillsRoot = join(cwd, AGENTS_SKILLS_DIR);
  const commands: CommandEntry[] = [];

  for (const skill of scanSkillDirs(skillsRoot, AGENTS_SKILLS_DIR)) {
    const filePath = join(skillsRoot, skill.name, SKILL_FILENAME);
    try {
      const content = readFileSync(filePath, 'utf-8');
      // Consumption path: `.agents/skills` includes harness-projected plugin
      // skills whose directories are namespaced `<pkg>__<name>`, so the
      // frontmatter name can never match the directory — and third-party CC
      // skills legitimately diverge anyway (DOR-263). The directory name is
      // the command identity; the frontmatter only supplies the description.
      const parsed = parseSkillFile(filePath, content, SkillFrontmatterSchema, {
        requireNameMatch: false,
      });
      if (!parsed.ok) {
        logger.debug('[CodexRuntime] skipping unparseable skill', {
          skill: skill.name,
          error: parsed.error,
        });
        continue;
      }
      commands.push({
        command: skill.name,
        fullCommand: `/${skill.name}`,
        description: parsed.definition.meta.description,
      });
    } catch (err) {
      logger.debug('[CodexRuntime] skipping unreadable skill', { skill: skill.name, err });
    }
  }

  commands.sort((a, b) => a.fullCommand.localeCompare(b.fullCommand));
  return commands;
}
