/**
 * Bring DorkOS's own starter text up to date in agent files nobody has edited.
 *
 * DorkBot's `AGENTS.md` and every agent's `SOUL.md` are written once, when the
 * agent is created, and never regenerated (ADR-0302). That is right for a file
 * a person has made their own and wrong for one they never touched: an install
 * from before 2026-10 still tells its agents they are "a coding assistant" and
 * DorkOS is "the operating system for autonomous AI agents", while every turn's
 * context block says they are co-workers on a team. Two stories, and the stale
 * one is the one the agent reads as its own identity (DOR-2779).
 *
 * The exception ADR-0302 records for this is deliberately narrow: a file is
 * rewritten only when it is BYTE-IDENTICAL to text a released version of DorkOS
 * wrote there. One changed character, one trailing newline an editor added, and
 * the file is the person's and is left exactly as it is. For `SOUL.md` the
 * comparison covers only the prose below the trait fence; the fenced trait
 * block is DorkOS-owned and re-rendered on every turn anyway, so a person who
 * moved a personality slider still counts as untouched.
 *
 * Runs on every boot and needs no "done" flag: once a file holds the current
 * template it no longer matches any old one, so the second boot finds nothing to
 * do. Same boundary as the skill backfill beside it in `index.ts`: only agent
 * homes under `<dorkHome>/agents/`, because a registered agent can live in a
 * person's own repository and a boot is not permission to write there.
 *
 * @module services/mesh/refresh-untouched-templates
 */
import fs from 'fs/promises';
import path from 'path';
import { withFileLock } from '@dorkos/shared/atomic-write';
import {
  CONVENTION_FILES,
  TRAIT_SECTION_END,
  TRAIT_SECTION_START,
  defaultSoulTemplate,
  extractCustomProse,
} from '@dorkos/shared/convention-files';
import { MANIFEST_DIR, readManifest } from '@dorkos/shared/manifest';
import { dorkbotClaudeMdTemplate } from '@dorkos/shared/dorkbot-templates';
import { isAgentHome } from '../harness/project-agent-workspace.js';
import { logger, logError } from '../../lib/logger.js';
import { DORKBOT_AGENT_NAME } from './ensure-dorkbot.js';

/** Stands in for the agent's name in a {@link PREVIOUS_SOUL_PROSE} entry. */
const NAME_SLOT = '{{name}}';

/**
 * Every `dorkbotClaudeMdTemplate()` output a released DorkOS wrote, oldest
 * first, recovered from git history. Frozen: never edit an entry, because an
 * entry that no longer matches what is on disk silently stops refreshing it.
 * When the current template changes, append the outgoing one here.
 */
export const PREVIOUS_DORKBOT_AGENTS_MD: readonly string[] = [
  // 2026-03 to 2026-06. Written to `.dork/AGENTS.md`, which nothing reads, so
  // this one is listed for completeness rather than because a root file holds it.
  [
    '# DorkBot',
    '',
    'You are DorkBot, the default AI assistant in DorkOS.',
    '',
    '## About DorkOS',
    '',
    'DorkOS is the operating system for autonomous AI agents.',
    'For full documentation: https://dorkos.ai/llms.txt',
    '',
    '## Your Role',
    '',
    'Help the user with their development workflow. You have access to DorkOS tools',
    'for scheduling (Pulse), messaging (Relay), and agent discovery (Mesh).',
  ].join('\n'),
  // 2026-06-30 (root AGENTS.md from here on) to 2026-08-26.
  [
    '# DorkBot',
    '',
    'You are DorkBot, the default AI assistant in DorkOS.',
    '',
    '## About DorkOS',
    '',
    'DorkOS is the operating system for autonomous AI agents.',
    'For full documentation: https://dorkos.ai/llms.txt',
    '',
    '## Your Role',
    '',
    'Help the user with their development workflow. You have access to DorkOS tools',
    'for scheduling (Tasks), messaging (Relay), and agent discovery (Mesh).',
  ].join('\n'),
  // 2026-08-26 (DOR-1490) to 2026-10-07 (DOR-2736).
  [
    '# DorkBot',
    '',
    'You are DorkBot, the default AI assistant in DorkOS.',
    '',
    '## About DorkOS',
    '',
    'DorkOS is the operating system for autonomous AI agents.',
    'For full documentation: https://dorkos.ai/llms.txt',
    '',
    '## Your Role',
    '',
    'Help the user with their development workflow. You have access to DorkOS tools',
    'for scheduled tasks, messaging (Relay), and agent discovery (Mesh).',
  ].join('\n'),
];

/**
 * Every prose half of a `defaultSoulTemplate()` a released DorkOS wrote, with
 * the agent's name as {@link NAME_SLOT}. Frozen, like the list above.
 */
export const PREVIOUS_SOUL_PROSE: readonly string[] = [
  // 2026-03 to 2026-10-07 (DOR-2736).
  [
    '## Identity',
    '',
    `You are ${NAME_SLOT}, a coding assistant.`,
    '',
    '## Values',
    '',
    '- Write clean, maintainable code',
    '- Respect existing patterns and conventions',
    '- Communicate clearly about trade-offs',
  ].join('\n'),
];

/**
 * The agent name an untouched old SOUL prose was written with, or `null` when
 * the prose is not exactly one of {@link PREVIOUS_SOUL_PROSE}.
 *
 * The slot must hold one of `names`, exactly. Without that, a person who wrote
 * "You are Ada, our release reviewer, a coding assistant." would read as
 * untouched with the name "Ada, our release reviewer". The cost runs the safe
 * way: an agent renamed since its file was written is left alone.
 *
 * @param prose - Everything after the trait fence's end marker, untrimmed.
 * @param names - The agent's current names: its display name and its slug.
 */
export function matchPreviousSoulProse(prose: string, names: readonly string[]): string | null {
  for (const template of PREVIOUS_SOUL_PROSE) {
    const parts = template.split(NAME_SLOT);
    if (parts.length !== 2) continue;
    const [before, after] = parts as [string, string];
    // `buildSoulContent` puts exactly one blank line between fence and prose.
    const head = `\n\n${before}`;
    if (prose.length <= head.length + after.length) continue;
    if (!prose.startsWith(head) || !prose.endsWith(after)) continue;
    const name = prose.slice(head.length, prose.length - after.length);
    if (names.includes(name)) return name;
  }
  return null;
}

/**
 * `SOUL.md` with its prose half replaced by today's template, or `null` when the
 * file is not an untouched old one.
 *
 * Untouched means: the file opens with the trait fence (nothing typed above it),
 * and everything after the fence's end is byte-for-byte an old template's prose.
 * The fence itself is kept as it is.
 *
 * @param content - The whole `SOUL.md`.
 * @param names - The agent's current names, see {@link matchPreviousSoulProse}.
 */
export function refreshSoulContent(content: string, names: readonly string[]): string | null {
  if (!content.startsWith(TRAIT_SECTION_START)) return null;
  const endsAt = content.indexOf(TRAIT_SECTION_END, TRAIT_SECTION_START.length);
  if (endsAt === -1) return null;
  const fenceEnd = endsAt + TRAIT_SECTION_END.length;
  const name = matchPreviousSoulProse(content.slice(fenceEnd), names);
  if (name === null) return null;
  const prose = extractCustomProse(defaultSoulTemplate(name, ''));
  return `${content.slice(0, fenceEnd)}\n\n${prose}`;
}

/**
 * DorkBot's `AGENTS.md` as today's template, or `null` when the file is not
 * byte-identical to an old one.
 *
 * @param content - The whole `AGENTS.md`.
 */
export function refreshDorkbotAgentsMd(content: string): string | null {
  return PREVIOUS_DORKBOT_AGENTS_MD.includes(content) ? dorkbotClaudeMdTemplate() : null;
}

/**
 * Rewrite one file when `refresh` says it is an untouched old template.
 *
 * Read, compare and write happen inside one {@link withFileLock} critical
 * section, so an edit saved through DorkOS in the same moment is never lost: it
 * either lands first and no longer matches, or lands after and wins.
 *
 * @returns Whether the file was rewritten.
 */
async function refreshFile(
  filePath: string,
  refresh: (content: string) => string | null
): Promise<boolean> {
  return withFileLock(filePath, async (write) => {
    let content: string;
    try {
      // A symlink is somebody's arrangement; the atomic rename would replace it.
      if (!(await fs.lstat(filePath)).isFile()) return false;
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      return false;
    }
    const next = refresh(content);
    if (next === null) return false;
    await write(next);
    return true;
  });
}

/** What one {@link refreshUntouchedTemplates} pass changed. */
export interface TemplateRefreshSummary {
  /** `SOUL.md` files whose prose was brought up to date. */
  souls: number;
  /** Whether DorkBot's `AGENTS.md` was brought up to date. */
  dorkbotAgentsMd: boolean;
}

/**
 * Refresh untouched starter text in every agent home DorkOS owns.
 *
 * Best-effort per file: one unreadable home is logged and skipped, never thrown,
 * so a boot is never held up by this pass.
 *
 * @param workspaces - Absolute paths to every registered agent workspace.
 * @param dorkHome - Resolved DorkOS data directory (see `lib/dork-home.ts`).
 */
export async function refreshUntouchedTemplates(
  workspaces: readonly string[],
  dorkHome: string
): Promise<TemplateRefreshSummary> {
  const summary: TemplateRefreshSummary = { souls: 0, dorkbotAgentsMd: false };

  for (const agentDir of workspaces) {
    if (!isAgentHome(agentDir, dorkHome)) continue;
    const soulPath = path.join(agentDir, MANIFEST_DIR, CONVENTION_FILES.soul);
    try {
      // A `.dork` that is a link points somewhere a boot has no business writing.
      if ((await fs.lstat(path.dirname(soulPath))).isSymbolicLink()) continue;
      const manifest = await readManifest(agentDir, logger);
      if (!manifest) continue;
      const names = [manifest.displayName, manifest.name].filter((n): n is string => !!n);
      if (await refreshFile(soulPath, (content) => refreshSoulContent(content, names))) {
        summary.souls += 1;
      }
    } catch (err) {
      logger.warn('[Mesh] Could not refresh SOUL.md', { agentDir, ...logError(err) });
    }
  }

  const dorkbotAgentsMd = path.join(dorkHome, 'agents', DORKBOT_AGENT_NAME, 'AGENTS.md');
  try {
    summary.dorkbotAgentsMd = await refreshFile(dorkbotAgentsMd, refreshDorkbotAgentsMd);
  } catch (err) {
    logger.warn("[Mesh] Could not refresh DorkBot's AGENTS.md", logError(err));
  }

  if (summary.souls > 0 || summary.dorkbotAgentsMd) {
    logger.info(
      '[Mesh] Updated untouched starter text: %d SOUL.md file(s)%s',
      summary.souls,
      summary.dorkbotAgentsMd ? " and DorkBot's AGENTS.md" : ''
    );
  }
  return summary;
}
