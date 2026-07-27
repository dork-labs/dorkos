/**
 * Default task templates seeded on first server run.
 *
 * Templates are SKILL.md files in `{dorkHome}/tasks/templates/{name}/SKILL.md`.
 * Users can edit, add, or delete template directories.
 *
 * @module services/tasks/task-templates
 */
import path from 'node:path';
import { writeSkillFile } from '@dorkos/skills/writer';
import { scanSkillDirectory } from '@dorkos/skills/scanner';
import { TaskFrontmatterSchema } from '@dorkos/skills/task-schema';
import { logger } from '../../lib/logger.js';

/**
 * Name of the templates container inside a tasks directory.
 *
 * This directory holds template directories, so it is never a task itself and
 * has no SKILL.md of its own. Anything scanning a tasks directory for tasks
 * must skip it — see {@link RESERVED_TASK_DIRNAMES}.
 */
export const TASK_TEMPLATES_DIRNAME = 'templates';

/**
 * Directory names inside a tasks directory that are containers, not tasks.
 *
 * The task reconciler passes this to the skill scanner so a container is
 * never mistaken for a task directory that forgot its SKILL.md.
 */
export const RESERVED_TASK_DIRNAMES: readonly string[] = [TASK_TEMPLATES_DIRNAME];

/**
 * Resolve the task-templates directory for a data directory.
 *
 * @param dorkHome - Resolved data directory path
 */
function resolveTemplatesDir(dorkHome: string): string {
  return path.join(dorkHome, 'tasks', TASK_TEMPLATES_DIRNAME);
}

interface TemplateDefinition {
  slug: string;
  frontmatter: Record<string, unknown>;
  prompt: string;
}

/** Built-in task templates seeded on first run. */
const DEFAULT_TEMPLATES: TemplateDefinition[] = [
  {
    slug: 'daily-health-check',
    frontmatter: {
      name: 'daily-health-check',
      'display-name': 'Daily Health Check',
      description: 'Run lint, test, and typecheck across the project',
      cron: '0 9 * * 1-5',
      timezone: 'UTC',
      enabled: true,
      permissions: 'acceptEdits',
    },
    prompt: `Run the following checks and report results:

1. \`pnpm lint\` — Report any linting errors
2. \`pnpm typecheck\` — Report any type errors
3. \`pnpm test -- --run\` — Report any test failures

Summarize the results concisely. If everything passes, say so. If anything fails, list the failures with file paths and line numbers.`,
  },
  {
    slug: 'weekly-dependency-audit',
    frontmatter: {
      name: 'weekly-dependency-audit',
      'display-name': 'Weekly Dependency Audit',
      description: 'Check for outdated or vulnerable dependencies',
      cron: '0 10 * * 1',
      timezone: 'UTC',
      enabled: true,
      permissions: 'acceptEdits',
    },
    prompt: `Audit project dependencies:

1. Run \`pnpm outdated\` and list packages with major version bumps available
2. Check for known security vulnerabilities
3. Identify any deprecated packages

Provide a prioritized list of recommended updates with risk assessment (safe, moderate, breaking).`,
  },
  {
    slug: 'activity-summary',
    frontmatter: {
      name: 'activity-summary',
      'display-name': 'Activity Summary',
      description: 'Summarize recent agent activity across all sessions',
      cron: '0 18 * * 1-5',
      timezone: 'UTC',
      enabled: true,
      permissions: 'acceptEdits',
    },
    prompt: `Summarize today's agent activity:

1. List sessions that were active today
2. Note any errors or failures
3. Highlight completed tasks and their outcomes
4. Flag anything that needs human attention

Keep the summary concise — aim for a quick daily digest.`,
  },
  {
    slug: 'code-review-digest',
    frontmatter: {
      name: 'code-review-digest',
      'display-name': 'Code Review Digest',
      description: 'Review recent commits for quality and patterns',
      cron: '0 11 * * 5',
      timezone: 'UTC',
      enabled: true,
      permissions: 'acceptEdits',
    },
    prompt: `Review commits from the past week:

1. Run \`git log --oneline --since="7 days ago"\`
2. Identify any concerning patterns (large commits, missing tests, style inconsistencies)
3. Note any TODO comments that were added
4. Highlight exemplary commits worth learning from

Provide a brief weekly code quality report.`,
  },
];

/**
 * Seed default task templates if the templates directory is empty.
 *
 * @param dorkHome - Resolved data directory path
 */
export async function ensureDefaultTemplates(dorkHome: string): Promise<void> {
  const templatesDir = resolveTemplatesDir(dorkHome);

  try {
    const results = await scanSkillDirectory(templatesDir, TaskFrontmatterSchema);
    if (results.length > 0) return; // Already seeded
  } catch {
    // Directory didn't exist, that's fine
  }

  for (const template of DEFAULT_TEMPLATES) {
    await writeSkillFile(templatesDir, template.slug, template.frontmatter, template.prompt);
  }

  logger.info(`[Tasks] Seeded ${DEFAULT_TEMPLATES.length} default templates`);
}

/**
 * Load task templates from the templates directory.
 *
 * @param dorkHome - Resolved data directory path
 * @returns Array of parsed templates
 */
export async function loadTemplates(dorkHome: string): Promise<
  Array<{
    id: string;
    name: string;
    displayName?: string;
    description: string;
    prompt: string;
    cron: string;
  }>
> {
  const templatesDir = resolveTemplatesDir(dorkHome);

  try {
    const results = await scanSkillDirectory(templatesDir, TaskFrontmatterSchema);
    const templates = [];

    for (const result of results) {
      if (!result.ok) continue;
      const def = result.definition;
      templates.push({
        id: def.name,
        name: def.name,
        displayName: def.meta['display-name'],
        description: def.meta.description ?? '',
        prompt: def.body,
        cron: def.meta.cron ?? '',
      });
    }

    return templates;
  } catch {
    return [];
  }
}
