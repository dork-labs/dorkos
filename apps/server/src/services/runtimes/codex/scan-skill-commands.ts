/**
 * Project-skill → slash-command projection for the Codex runtime.
 *
 * Codex's built-in TUI commands cannot run under `codex exec`, and the SDK
 * exposes no command-discovery API, so DorkOS does not fake Codex's own
 * commands. Instead it surfaces the project's skills (`.agents/skills`) as slash
 * commands — the same skills Claude's SDK exposes from `.claude/skills` — giving
 * Codex sessions a real, project-scoped command palette.
 *
 * This is a READER, not a planner: its job is to show what a bare `codex` run in
 * the same repo would show, so it enumerates `.agents/skills` the way Codex does
 * — following symlinks, and including the `<pkg>__<name>` links Harness Sync
 * projected there for an installed marketplace plugin
 * (`includeManagedProjections`). Without that it listed authored skills only,
 * and a plugin's `/acme__publish` worked in the terminal but was missing from
 * the palette — the exact inversion of ADR 260706-192819's parity promise
 * (DOR-1844).
 *
 * The palette honors the same invocation frontmatter Claude Code enforces
 * natively, so one SKILL.md means one thing on every runtime: `user-invocable:
 * false` keeps a skill out of the menu.
 *
 * @module services/runtimes/codex/scan-skill-commands
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanSkillDirs, AGENTS_SKILLS_DIR } from '@dorkos/harness/scan';
import { SkillFrontmatterSchema, SKILL_FILENAME, isUserInvocable } from '@dorkos/skills';
import { parseSkillFile } from '@dorkos/skills/parser';
import type { CommandEntry } from '@dorkos/shared/types';
import { logger } from '../../../lib/logger.js';

/**
 * Enumerate every skill Codex can see under `<cwd>/.agents/skills` — authored
 * dirs, linked-in sources, and the `<pkg>__<name>` projections of installed
 * plugins alike — and map each to a {@link CommandEntry} (`/<name>`, described
 * by the skill's SKILL.md frontmatter). A skill whose SKILL.md is unreadable or
 * has invalid frontmatter is skipped rather than failing the whole scan; a
 * missing skills directory yields an empty list. Results are sorted by command
 * for a deterministic palette.
 *
 * @param cwd - Absolute project directory whose `.agents/skills` is scanned.
 */
export function scanSkillCommands(cwd: string): CommandEntry[] {
  const skillsRoot = join(cwd, AGENTS_SKILLS_DIR);
  const commands: CommandEntry[] = [];

  // A reader mirrors the directory; it does not re-plan it. See the module doc.
  for (const skill of scanSkillDirs(skillsRoot, AGENTS_SKILLS_DIR, {
    includeManagedProjections: true,
  })) {
    const filePath = join(skillsRoot, skill.name, SKILL_FILENAME);
    try {
      const content = readFileSync(filePath, 'utf-8');
      // Consumption path, so a frontmatter name that differs from the directory
      // is tolerated rather than fatal. It differs by construction for every
      // projected plugin skill: the projection namespaces the DIRECTORY to
      // `<pkg>__<name>` and cannot rewrite the package's own `SKILL.md`, so
      // `acme__publish` holds `name: publish` and could never match. Third-party
      // CC skills diverge for their own reasons too (DOR-263). The directory
      // name is the command identity here; the frontmatter only supplies the
      // description. (Codex itself keys a skill by the frontmatter name — see
      // contributing/harness-sync.md §4, "Skill identity differs per harness" —
      // which is why the projector warns about frontmatter-name collisions
      // instead of this scan trying to resolve them.)
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
      // `user-invocable: false` marks a skill the model may load but a person
      // should never see in a `/` menu — Claude Code honors it natively, and
      // this palette is the same promise for Codex. `disable-model-invocation`
      // is deliberately NOT filtered here: person-only is exactly what a slash
      // palette is for.
      if (!isUserInvocable(parsed.definition.meta)) continue;
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
