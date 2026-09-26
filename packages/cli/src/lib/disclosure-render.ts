/**
 * Terminal lines for what a package's new version runs on its own, as an
 * update check discloses it (DOR-2306): each command and when it runs (a hook,
 * or a skill's text, DOR-2327), each
 * program and where it starts, each skill allowed to use tools without asking,
 * and each scheduled job. Values are written out whole, with hidden characters
 * shown, the same way `dorkos install` prints a preview, because the person
 * approves exactly what is printed: `dorkos update --apply` sends it back and
 * the server installs only a version that still runs exactly this.
 *
 * @module lib/disclosure-render
 */
import {
  describeHookEvent,
  describeProgramLine,
  describeScheduleArrival,
  describeSchedulePermissionMode,
  revealHiddenCharacters,
  skillCommandKind,
  type DisclosedEffects,
} from '@dorkos/shared/marketplace-schemas';

/**
 * Where an installation is, which decides whether its own programs start.
 * `agent` is a new agent's own folder, created from a template (DOR-2325):
 * what it brings runs in that agent's sessions only.
 */
export type DisclosureScope = 'global' | 'project' | 'agent';

/** When a package's own programs start, by where it is installed. */
const PROGRAMS_START: Record<DisclosureScope, string> = {
  global: 'starts in every session',
  project: 'declared, not started for a project install',
  agent: "starts in the new agent's sessions",
};

/**
 * Every line saying what one new version runs, indented under its package.
 *
 * @param effects - What the new version runs, or `null` / absent when nothing was previewed.
 * @param scope - Where the installation is.
 * @returns One or more lines; one line saying so when it runs nothing.
 */
export function renderDisclosureLines(
  effects: DisclosedEffects | null | undefined,
  scope: DisclosureScope
): string[] {
  if (!effects) return ['    runs nothing on its own'];
  const where = PROGRAMS_START[scope];
  const quoted = (value: string) => revealHiddenCharacters(JSON.stringify(value));
  const lines = [
    ...effects.hooks.flatMap((hook) => [
      `    runs ${describeHookEvent(hook.event, hook.matcher ?? undefined)}` +
        (hook.source ? `, while ${revealHiddenCharacters(hook.source)} is in use` : '') +
        ':',
      `      ${revealHiddenCharacters(hook.command)}`,
    ]),
    // Written into a skill's or command's text: run as it loads (DOR-2327).
    // `?? []`: a server older than DOR-2327 sends none.
    ...(effects.skillCommands ?? []).flatMap((entry) => [
      `    runs when the ${skillCommandKind(entry.source)} ${quoted(entry.skill)} is used` +
        (entry.usesArguments ? ', using the text typed after it:' : ':'),
      ...revealHiddenCharacters(entry.command)
        .split('\n')
        .map((line) => `      ${line}`),
    ]),
    ...effects.mcpServers.map((server) =>
      server.command !== null
        ? `    MCP server ${quoted(server.name)} (${where}): ${describeProgramLine(server.command, server.args)}`
        : `    remote MCP server ${quoted(server.name)} (${where}) at ${quoted(server.url ?? '')}`
    ),
    ...effects.lspServers.map(
      (server) =>
        `    language server ${quoted(server.name)} (${where}): ${describeProgramLine(server.command, server.args)}`
    ),
    ...effects.monitors.map(
      (monitor) =>
        `    background monitor ${quoted(monitor.name)} (${where}${monitor.when ? `, ${monitor.when}` : ''}): ${describeProgramLine(monitor.command)}`
    ),
    ...effects.executables.map((name) => `    adds the command ${quoted(name)} (${where})`),
    ...effects.skillTools.map(
      (entry) =>
        `    skill ${quoted(entry.skill)} may use without asking: ${entry.tools.map(quoted).join(', ')}`
    ),
    ...effects.schedules.map(
      (job) =>
        `    scheduled job ${quoted(job.name)}: ${job.cron ? `runs on ${quoted(job.cron)}` : 'runs only when asked'}, ` +
        `${describeSchedulePermissionMode(job.permissionMode)}, ${describeScheduleArrival(job.startsEnabled)}`
    ),
  ];
  return lines.length > 0 ? lines : ['    runs nothing on its own'];
}
