/**
 * The full text of an update approval card: every reinstall, where it is, from
 * which version to which, and everything its new version would run.
 *
 * A person approving an update approves new code: hook commands that run in
 * their sessions, scheduled jobs, and MCP servers that start in every session a
 * global plugin loads in. So this is the card's `detail`, the one field a
 * person reads in full, and every value is written out whole and escaped
 * (`JSON.stringify`) rather than shortened the way the summary sentence is: a
 * command cut at 80 characters is a command nobody read. When the whole list
 * cannot fit on a card, the caller refuses rather than cut it
 * ({@link UPDATE_DETAIL_MAX_LENGTH}).
 *
 * @module services/marketplace-mcp/update-approval-detail
 */
import { APPROVAL_DETAIL_MAX_LENGTH } from '@dorkos/shared/approval-schemas';
import {
  describeHookEvent,
  describeProgramLine,
  describeScheduleArrival,
  describeSchedulePermissionMode,
  revealHiddenCharacters,
} from '@dorkos/shared/marketplace-schemas';
import type { ApprovableUpdate } from '../marketplace/flows/update-installed.js';

/** The longest detail a card stores; a longer list is refused, never cut. */
export const UPDATE_DETAIL_MAX_LENGTH = APPROVAL_DETAIL_MAX_LENGTH;

/**
 * A value written out whole, quoted and escaped, with every hidden or
 * direction-changing character shown, so it cannot forge the text around it.
 */
const whole = (value: string): string => revealHiddenCharacters(JSON.stringify(value));

/** Where one installation is, in words. */
function placeOf(update: ApprovableUpdate): string {
  if (update.scope === 'global' || update.projectPath === undefined) return 'installed globally';
  const agent = update.agentName ? ` for ${whole(update.agentName)}` : '';
  return `installed in ${whole(update.projectPath)}${agent}`;
}

/**
 * When a plugin's own programs start, for this installation: a global plugin is
 * loaded into every session (`plugin-activation.ts`); a project's copy is
 * projected as files, and its MCP and language servers, monitors and `bin/`
 * commands are not among them.
 */
function whenProgramsStart(update: ApprovableUpdate): string {
  return update.scope === 'global'
    ? 'in every session'
    : 'declared, but not started for a project install';
}

/** Every line saying what one new version would run. */
function effectsOf(update: ApprovableUpdate): string[] {
  const effects = update.disclosed;
  if (!effects) return ['  runs nothing on its own'];
  const where = whenProgramsStart(update);
  const lines = [
    ...effects.hooks.map(
      (hook) =>
        `  runs ${whole(hook.command)} ${describeHookEvent(hook.event, hook.matcher ?? undefined)}` +
        (hook.source ? `, while the skill in ${whole(hook.source)} is in use` : '')
    ),
    ...effects.skillTools.map(
      (entry) =>
        `  skill ${whole(entry.skill)} (${whole(entry.source)}) may use without asking: ${entry.tools.map(whole).join(', ')}`
    ),
    ...effects.schedules.map(
      (job) =>
        `  scheduled job ${whole(job.name)}: ${job.cron ? `runs on ${whole(job.cron)}` : 'runs only when asked'}, ` +
        `${describeSchedulePermissionMode(job.permissionMode)}, ${describeScheduleArrival(job.startsEnabled)}`
    ),
    ...effects.mcpServers.map((server) =>
      server.command !== null
        ? `  MCP server ${whole(server.name)} (${where}): ${describeProgramLine(server.command, server.args)}`
        : `  remote MCP server ${whole(server.name)} (${where}) at ${whole(server.url ?? '')}`
    ),
    ...effects.lspServers.map(
      (server) =>
        `  language server ${whole(server.name)} (${where}): ${describeProgramLine(server.command, server.args)}`
    ),
    ...effects.monitors.map(
      (monitor) =>
        `  background monitor ${whole(monitor.name)} (${where}${monitor.when ? `, ${whole(monitor.when)}` : ''}): ${describeProgramLine(monitor.command)}`
    ),
    ...effects.executables.map(
      (name) => `  adds the command ${whole(name)} to the agent's PATH (${where})`
    ),
  ];
  return lines.length > 0 ? lines : ['  runs nothing on its own'];
}

/**
 * Every reinstall, one block each, in the order given.
 *
 * @param updates - The reinstalls a person is asked to approve.
 * @returns The card's detail text. May exceed {@link UPDATE_DETAIL_MAX_LENGTH};
 *   the caller refuses rather than store a cut list.
 */
export function describeUpdatesInFull(updates: readonly ApprovableUpdate[]): string {
  return updates
    .map((update) =>
      [
        `${whole(update.packageName)} (${update.type}, ${placeOf(update)}): ${whole(update.installedVersion)} → ${whole(update.latestVersion)}`,
        `  at ${whole(update.installPath)}`,
        ...effectsOf(update),
      ].join('\n')
    )
    .join('\n\n');
}
