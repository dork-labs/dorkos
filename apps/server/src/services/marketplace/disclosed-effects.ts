/**
 * The executable content an install approval attests to (DOR-647).
 *
 * A marketplace approval is bound to `(capability, inputs)` — the package, the
 * marketplace, the project, the purge flag. That was the whole of what a person's
 * yes was about while the preview was file counts and destination paths: a fresh
 * resolve producing a slightly different file list is not something anybody
 * consented to one way or the other.
 *
 * DOR-635 changed what the preview says. Its headline disclosure is now a
 * **verbatim shell command** and a **scheduled job with its permission mode named
 * in plain words** — exactly the facts a yes IS about. With those outside the
 * binding, a re-resolve between the card and the install could run a command
 * nobody read, and nothing would notice. So this module names the subset of the
 * preview an approval has to cover, and {@link disclosedEffectsOf} is what
 * `bindingOf` hashes.
 *
 * ## What is in
 *
 * Every hook command string (with the event and matcher that decide WHEN it
 * runs), every scheduled job (with the cron and permission mode that decide
 * when it fires and how much it may do unattended), and every program the
 * package starts on its own (DOR-2195): MCP servers (the command and arguments,
 * or the address), language servers, background monitors, and the names of the
 * commands it puts on the agent's `PATH` (a `bin/git` runs whenever the agent
 * runs git). These are the parts of the preview that execute on their own: a
 * global plugin is loaded into every session, and they start with it.
 *
 * Skills and commands are IN for what their frontmatter makes run: the model
 * invokes a skill by its description, not only by name, and Claude Code
 * registers a skill's frontmatter `hooks` while it is in use (no exclusion for
 * plugin skills), so those hooks are bound with the plugin's own, each tagged
 * with its `source`, and each skill's `allowed-tools` (the tools it may use
 * without a prompt) is bound as `skillTools`. The skill's body is prose and is
 * out, like any file, EXCEPT the shell commands written into it: Claude Code
 * runs `` !`cmd` `` and a ```` ```! ```` block while it loads the skill, before
 * the model sees it (and OpenCode runs the inline form in the command wrappers
 * Harness Sync writes for it). Those are bound as `skillCommands` (DOR-2327,
 * `@dorkos/skills/shell-commands`).
 *
 * Agents are out with evidence: Claude Code ignores `hooks`, `mcpServers` and
 * `permissionMode` in a plugin agent's frontmatter (plugins reference, "not
 * supported in plugins"), so a plugin agent adds no program and no permission
 * of its own. Workflows run only when invoked by name.
 *
 * A known leftover: an output style marked `force-for-plugin` changes the
 * instructions every session gets. That is not a program and is not bound here.
 *
 * ## What is out, and the DIFFERENT reason for each group
 *
 * These are three separate arguments, and collapsing them into one ("the preview
 * is derived") is how somebody later relaxes the wrong thing.
 *
 * 1. **`fileChanges`, `conflicts`, `requires` — genuinely renumbering.** A fresh
 *    resolve can legitimately produce a different file list, a conflict against
 *    state that moved, or a requirement that became satisfied. None of it runs.
 *    Re-asking because a package gained a README would train a person to click
 *    through the card that matters, which is the one real cost of a strict
 *    binding.
 * 2. **`extensions`, `secrets`, `externalHosts` — a SECOND person-approval stands
 *    between them and any code running.** A marketplace extension defaults OFF
 *    (`defaultsOn` in `services/extensions/extension-enable-resolution.ts` returns
 *    false for anything that is not a bundled core extension), and running one
 *    inside the server process additionally requires its id in
 *    `config.extensions.approvedToRun` — a separate, explicit yes (DOR-516,
 *    `extension-load-policy.ts`). `secrets` and `externalHosts` are read off those
 *    same extension manifests, so they are downstream of that gate too. Nothing
 *    here can execute on the strength of the install approval alone.
 * 3. **`npmDependencies` — cannot execute at install time at all.** The install
 *    fetches them with `npm install --ignore-scripts`, which is pinned by a test
 *    that ships a package declaring `ignore-scripts=false` in its own `.npmrc` and
 *    asserts the postinstall still does not run
 *    (`lib/__tests__/npm-dependencies.test.ts`). A changed dependency is a changed
 *    library the package may later import — which is real, and is the residual
 *    this binding does not cover — but it is not code the install itself runs.
 *
 * `unreadableHooks` is out for a fourth, narrower reason: a declaration that
 * became readable, or stopped being readable, changes the hook list itself, so the
 * binding already moves without it.
 *
 * `unreadableDeclarations` is out of the hash for the same reason as
 * `unreadableHooks`; an update refuses to offer a version that has any
 * (`update.ts`), so nobody approves what could not be shown.
 *
 * ## Order: semantic for hooks, not for schedules or MCP servers
 *
 * Hooks are hashed in declaration order, because hooks on one event RUN in that
 * order — a reordering changes what executes. Schedules are sorted before hashing,
 * because they do not: each fires on its own clock, and the preview's order is
 * partly `readdir` order over `.dork/tasks/` (`readTaskSkills` in
 * `permission-preview.ts`), which the filesystem does not promise to keep stable.
 * MCP servers are keyed by name and start independently, so they are sorted too.
 * A spurious re-ask is not a harmless false positive here — it is the thing that
 * teaches an operator to stop reading the card.
 *
 * @module services/marketplace/disclosed-effects
 */
import { z } from 'zod';
import { stableStringify } from '@dorkos/shared/capabilities';
import {
  describeHookEvent,
  describeProgramLine,
  describeScheduleArrival,
  describeSchedulePermissionMode,
  revealHiddenCharacters,
  skillCommandKind,
} from '@dorkos/shared/marketplace-schemas';
import { quoteSummaryValue } from '../core/approvals/index.js';
import type {
  DisclosedEffects,
  DisclosedHook,
  DisclosedMcpServer,
  DisclosedProgram,
  DisclosedSchedule,
  DisclosedSkillCommand,
} from '@dorkos/shared/marketplace-schemas';
import type { PermissionPreview } from './types.js';

export type {
  DisclosedEffects,
  DisclosedHook,
  DisclosedMcpServer,
  DisclosedProgram,
  DisclosedSchedule,
  DisclosedSkillCommand,
  DisclosedSkillTools,
} from '@dorkos/shared/marketplace-schemas';

/** A named program and how it is started, as {@link DisclosedEffectsSchema} accepts it. */
const DisclosedProgramSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  when: z.string().nullable(),
});

/**
 * The wire form of a disclosure a caller sends back as what it was shown
 * (DOR-2306): `InstallOptions.approvedDisclosure` and each update target's
 * `disclosed`. It only has to parse; whether it is the TRUE disclosure is
 * decided by comparing it with the version resolved now, so a value an HTTP
 * caller invents is refused rather than trusted.
 */
export const DisclosedEffectsSchema = z.object({
  hooks: z.array(
    z.object({
      event: z.string(),
      matcher: z.string().nullable(),
      command: z.string(),
      source: z.string().nullable(),
    })
  ),
  schedules: z.array(
    z.object({
      name: z.string(),
      cron: z.string().nullable(),
      permissionMode: z.string(),
      startsEnabled: z.boolean(),
    })
  ),
  mcpServers: z.array(
    z.object({
      name: z.string(),
      transport: z.string(),
      command: z.string().nullable(),
      args: z.array(z.string()),
      url: z.string().nullable(),
    })
  ),
  lspServers: z.array(DisclosedProgramSchema),
  monitors: z.array(DisclosedProgramSchema),
  executables: z.array(z.string()),
  skillTools: z.array(
    z.object({ source: z.string(), skill: z.string(), tools: z.array(z.string()) })
  ),
  skillCommands: z.array(
    z.object({
      source: z.string(),
      skill: z.string(),
      form: z.enum(['inline', 'block']),
      command: z.string(),
    })
  ),
}) satisfies z.ZodType<DisclosedEffects>;

/**
 * The parts of a preview a disclosure is read from. A whole
 * {@link PermissionPreview} is one; so is what global activation reads off an
 * installed package (`global-plugin-consent.ts`), which has no file list or
 * conflicts to report.
 */
export type DisclosureSource = Pick<
  PermissionPreview,
  | 'hooks'
  | 'schedules'
  | 'mcpServers'
  | 'lspServers'
  | 'monitors'
  | 'executables'
  | 'skillTools'
  | 'skillCommands'
>;

/**
 * Total order over schedules, so the binding does not move when `readdir` does.
 *
 * Every field participates, in a fixed order, which makes it a real total order
 * rather than a sort that leaves ties in arbitrary positions: two schedules that
 * compare equal on all four fields are indistinguishable, and swapping them
 * cannot change the hash.
 */
function compareSchedules(a: DisclosedSchedule, b: DisclosedSchedule): number {
  return (
    a.name.localeCompare(b.name) ||
    (a.cron ?? '').localeCompare(b.cron ?? '') ||
    a.permissionMode.localeCompare(b.permissionMode) ||
    Number(a.startsEnabled) - Number(b.startsEnabled)
  );
}

/**
 * Reduce a permission preview to the executable content an approval attests to.
 *
 * Absence is bound as absence: an operation with no preview at all (uninstall,
 * create-package) yields `null` rather than an empty pair of lists, so "nothing
 * was disclosed" can never hash the same as "a package that declares nothing".
 *
 * Hooks keep their declaration order and schedules are sorted; see the module
 * TSDoc for why those differ.
 *
 * @param preview - The preview the person was shown (or its runnable parts), when there was one.
 * @returns The disclosed executable content, or `null` when nothing was previewed.
 */
export function disclosedEffectsOf(preview: DisclosureSource | undefined): DisclosedEffects | null {
  if (!preview) return null;
  return {
    hooks: preview.hooks.map((hook) => ({
      event: hook.event,
      matcher: hook.matcher ?? null,
      command: hook.command,
      source: hook.source ?? null,
    })),
    schedules: preview.schedules
      .map((schedule) => ({
        name: schedule.name,
        cron: schedule.cron ?? null,
        permissionMode: schedule.permissionMode,
        startsEnabled: schedule.startsEnabled,
      }))
      .sort(compareSchedules),
    mcpServers: preview.mcpServers
      .map((server) => ({
        name: server.name,
        transport: server.transport,
        command: server.command ?? null,
        args: server.args ?? [],
        url: server.url ?? null,
      }))
      // By name, then by everything else, so two same-named declarations (from
      // `.mcp.json` and plugin.json) still have one order.
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name) || stableStringify(a).localeCompare(stableStringify(b))
      ),
    lspServers: preview.lspServers
      .map((server) => ({
        name: server.name,
        command: server.command,
        args: server.args,
        when: null,
      }))
      .sort(comparePrograms),
    monitors: preview.monitors
      .map((monitor) => ({
        name: monitor.name,
        command: monitor.command,
        args: [],
        when: monitor.when ?? null,
      }))
      .sort(comparePrograms),
    executables: [...preview.executables].sort(),
    skillTools: preview.skillTools
      .map((entry) => ({ source: entry.source, skill: entry.skill, tools: entry.tools }))
      .sort((a, b) => a.source.localeCompare(b.source)),
    // By file, and within one file in document order (a stable sort keeps
    // it): they run in that order when the skill loads.
    skillCommands: preview.skillCommands
      .map((entry) => ({
        source: entry.source,
        skill: entry.skill,
        form: entry.form,
        command: entry.command,
      }))
      .sort((a, b) => a.source.localeCompare(b.source)),
  };
}

/** By name, then by everything else, so same-named declarations have one order. */
function comparePrograms(a: DisclosedProgram, b: DisclosedProgram): number {
  return a.name.localeCompare(b.name) || stableStringify(a).localeCompare(stableStringify(b));
}

/**
 * Whether two disclosures are the same one.
 *
 * Implemented over the SAME canonicalization the approval hash uses
 * ({@link stableStringify}), so this answer and the binding's answer cannot
 * disagree — a comparison written by hand would be a second opinion about what
 * "the same disclosure" means, and the two would drift.
 *
 * @param a - One disclosure, or `null` for "nothing was previewed".
 * @param b - The other.
 * @returns True when an approval for `a` covers `b`.
 */
export function sameDisclosedEffects(
  a: DisclosedEffects | null,
  b: DisclosedEffects | null
): boolean {
  return stableStringify(a ?? null) === stableStringify(b ?? null);
}

/** How many commands a re-ask names before it stops listing them. */
const NAMED_COMMAND_LIMIT = 3;

/** Render the hook half of {@link describeDisclosedEffects}. */
function describeHooks(hooks: DisclosedHook[]): string {
  if (hooks.length === 0) return 'no shell commands';
  const named = hooks
    .slice(0, NAMED_COMMAND_LIMIT)
    .map((hook) => quoteSummaryValue(hook.command))
    .join(', ');
  const rest = hooks.length - NAMED_COMMAND_LIMIT;
  const tail = rest > 0 ? `, and ${rest} more` : '';
  return `${hooks.length === 1 ? '1 shell command' : `${hooks.length} shell commands`} (${named}${tail})`;
}

/** Render the skill-text commands part of {@link describeDisclosedEffects}, or nothing. */
function describeSkillCommands(commands: DisclosedSkillCommand[]): string {
  if (commands.length === 0) return '';
  const named = commands
    .slice(0, NAMED_COMMAND_LIMIT)
    .map((entry) => quoteSummaryValue(entry.command))
    .join(', ');
  const rest = commands.length - NAMED_COMMAND_LIMIT;
  const tail = rest > 0 ? `, and ${rest} more` : '';
  const count =
    commands.length === 1 ? '1 command a skill runs' : `${commands.length} commands skills run`;
  return `, and ${count} when it is used (${named}${tail})`;
}

/** Render the schedule half of {@link describeDisclosedEffects}. */
function describeSchedules(schedules: DisclosedSchedule[]): string {
  if (schedules.length === 0) return 'no scheduled jobs';
  const modes = [...new Set(schedules.map((schedule) => schedule.permissionMode))].join(', ');
  const count = schedules.length === 1 ? '1 scheduled job' : `${schedules.length} scheduled jobs`;
  return `${count} (${modes})`;
}

/** Render the MCP half of {@link describeDisclosedEffects}. */
function describeMcpServers(servers: DisclosedMcpServer[]): string {
  if (servers.length === 0) return 'no MCP servers';
  const named = servers
    .slice(0, NAMED_COMMAND_LIMIT)
    .map((server) => quoteSummaryValue(server.name))
    .join(', ');
  const rest = servers.length - NAMED_COMMAND_LIMIT;
  const tail = rest > 0 ? `, and ${rest} more` : '';
  return `${servers.length === 1 ? '1 MCP server' : `${servers.length} MCP servers`} (${named}${tail})`;
}

/**
 * Say, in one plain phrase, what a package declares right now.
 *
 * Used to name what a fresh approval is actually for when a stale one no longer
 * covers it. Every command string goes through `quoteSummaryValue`, which quotes,
 * escapes and caps it — this phrase is handed back to the agent that asked, and a
 * command carrying its own quotes and newlines must not be able to forge the rest
 * of the sentence.
 *
 * @param effects - The disclosed executable content, or `null` when none was previewed.
 * @returns A phrase naming what would run, for a message a person or model reads.
 */
export function describeDisclosedEffects(effects: DisclosedEffects | null): string {
  if (!effects) return 'nothing that runs on its own';
  const others = effects.lspServers.length + effects.monitors.length + effects.executables.length;
  const rest =
    others === 0
      ? ''
      : `, and ${others} other ${others === 1 ? 'program' : 'programs'} (language servers, monitors, commands)`;
  const tools =
    effects.skillTools.length === 0
      ? ''
      : `, and ${effects.skillTools.length} ${effects.skillTools.length === 1 ? 'skill that uses' : 'skills that use'} tools without asking`;
  return `${describeHooks(effects.hooks)}, ${describeSchedules(effects.schedules)} and ${describeMcpServers(effects.mcpServers)}${rest}${tools}${describeSkillCommands(effects.skillCommands)}`;
}

/**
 * A value written out whole, quoted and escaped, with every hidden or
 * direction-changing character shown, so it cannot forge the text around it.
 */
const whole = (value: string): string => revealHiddenCharacters(JSON.stringify(value));

/** `the skill "x"` for a `SKILL.md`, `the command "x"` for a command file. */
function describeSkillOf(entry: DisclosedSkillCommand): string {
  return `the ${skillCommandKind(entry.source)} ${whole(entry.skill)}`;
}

/**
 * Every line an approval card's detail shows for one disclosure: each command
 * and when it runs, each skill's tools, each scheduled job, and each program
 * with where it starts. Values are written out whole and escaped, never
 * shortened: a command cut at 80 characters is a command nobody read. Shared
 * by the update card (`marketplace-mcp/update-approval-detail.ts`) and the card
 * a withheld global package raises (`ask-withheld-global-plugins.ts`).
 *
 * @param effects - What a package runs, or `null` when nothing was previewed.
 * @param where - When its own programs start, in words (e.g. `in every session`).
 * @returns One indented line per effect, or one line saying it runs nothing.
 */
export function describeEffectsInFull(effects: DisclosedEffects | null, where: string): string[] {
  if (!effects) return ['  runs nothing on its own'];
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
    ...effects.skillCommands.map(
      (entry) =>
        `  runs ${whole(entry.command)} when ${describeSkillOf(entry)} is used (${whole(entry.source)})`
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
