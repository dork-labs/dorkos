/**
 * CLI handlers for `dorkos permissions` and `dorkos agent permissions`
 * (spec `agent-permissions`, task 3.9).
 *
 * Thin HTTP wrappers over the permission routes, so a terminal change is the
 * same change the app makes, recorded the same way:
 *
 * - `permissions [list]`               → `GET /api/permissions`
 * - `permissions set --preset <p>`     → `PUT /api/permissions/preset`
 * - `permissions set|reset <target>`   → `PATCH /api/permissions/defaults`
 * - `permissions history`              → `GET /api/permissions/history`
 * - `agent permissions <agent> …`      → `GET|PATCH /api/agents/:id/permissions`
 *
 * Nothing here writes config or an agent's manifest itself: every write carries
 * `surface: 'cli'`, and a refusal prints the server's own sentence. The one line
 * the CLI adds is the terminal's next step when the server asks for the Full
 * autonomy acknowledgement, because the app's next step is a dialog a terminal
 * does not have.
 *
 * Handlers return an exit code rather than calling `process.exit`, so `cli.ts`
 * stays the single source of truth for termination.
 *
 * @module commands/permissions
 */
import { parseArgs } from 'node:util';
import {
  PERMISSION_AREA_IDS,
  PERMISSION_PRESETS,
  PERMISSION_STATES,
  PermissionStopSchema,
  type AgentPermissionsResponse,
  type PermissionHistoryResponse,
  type PermissionPreset,
  type PermissionSource,
  type PermissionsResponse,
  type PermissionState,
} from '@dorkos/shared/permissions';
import type { PermissionStop } from '@dorkos/shared/agent-runtime';
import { ApiError, apiCall } from '../lib/api-client.js';
import { printError, printJson, renderTable } from '../lib/operator-output.js';
import { ACKNOWLEDGE_AUTONOMY_COMMAND, AUTONOMY_ACK_REQUIRED_CODE } from '../config-write.js';

/** Help text for `dorkos permissions`. */
const PERMISSIONS_HELP = `Usage: dorkos permissions <subcommand> [options]

See and change what your agents may do without asking you first.

Subcommands:
  list                              Show the preset, every area and who differs
  set --preset <preset>             Choose a preset: careful, balanced or full
  set <area|action> <state>         Change one area or action for every agent
  reset <area|action>               Put an area or action back to the preset
  history [--agent <agent>]         Show recent permission changes

States: blocked, ask, allowed. Safety limits, Permissions and Reach & secrets
are never allowed: they can only be blocked or ask.

Options:
      --limit <n>   How many history rows to show (default 50, max 100)
      --json        Print raw JSON instead of a table

Examples:
  dorkos permissions
  dorkos permissions set --preset balanced
  dorkos permissions set rooms ask
  dorkos permissions set tasks_delete blocked
  dorkos permissions reset rooms
  dorkos permissions history --agent dorkbot --limit 20

One agent's own settings: dorkos agent permissions <agent> --help`;

/** Help text for `dorkos agent permissions`. */
const AGENT_PERMISSIONS_HELP = `Usage: dorkos agent permissions <agent> [subcommand] [options]

See and change what one agent may do. <agent> is its id or its name.

Subcommands:
  (none)                            Show what this agent may do, and why
  set <area|action> <state>         Give this agent its own setting
  set files <ask|act|autonomy>      Give this agent its own Files & commands stop
  reset <area|action|files>         Put it back to the setting everyone has

Options:
      --json   Print raw JSON instead of a table

Examples:
  dorkos agent permissions dorkbot
  dorkos agent permissions security-auditor set rooms blocked
  dorkos agent permissions security-auditor set files ask
  dorkos agent permissions security-auditor reset files`;

/** A preset as a person reads it (the app's words). */
const PRESET_LABEL: Record<PermissionPreset, string> = {
  careful: 'Careful',
  balanced: 'Balanced',
  full: 'Full power',
};

/** A Files & commands stop as a person reads it (the app's words). */
const STOP_LABEL: Record<PermissionStop, string> = {
  ask: 'Ask first',
  act: 'Act',
  autonomy: 'Full autonomy',
};

/** A state as a person reads it. */
const STATE_LABEL: Record<PermissionState, string> = {
  blocked: 'Blocked',
  ask: 'Ask',
  allowed: 'Allowed',
};

/** Where a resolved state came from, in the words the app uses. */
function sourceText(source: PermissionSource, preset: PermissionPreset | null): string {
  switch (source) {
    case 'agent-area':
    case 'agent-action':
      return "This agent's own setting";
    case 'default-area':
    case 'default-action':
      return 'Changed from your preset';
    case 'preset':
      return preset ? `From ${PRESET_LABEL[preset]}` : 'From your preset';
    case 'unchanged':
      return 'Not chosen yet, so it works as it did before';
    case 'floor':
      return 'Never Allowed';
    case 'inactive':
      return 'This agent is no longer active, so everything but reading is Blocked';
    case 'always-asks':
      return 'Always asks, so you see what it would change';
  }
}

/** Where a Files & commands stop came from. */
function filesSourceText(source: AgentPermissionsResponse['filesAndCommands']['source']): string {
  switch (source) {
    case 'agent':
      return "This agent's own setting";
    case 'runtime':
      return "Set for this agent's runtime";
    case 'default':
      return 'The setting everyone has';
    case 'runtime-own':
      return 'Not set, so the runtime decides';
  }
}

/** A stop, or the runtime's own behaviour when none is set. */
function stopText(stop: PermissionStop | null): string {
  return stop ? STOP_LABEL[stop] : 'Not set';
}

/** Which key of a permissions patch a target names. */
type Target = { kind: 'area'; id: string } | { kind: 'action'; id: string } | { kind: 'files' };

/** Read `<area|action|files>`: an area id is an area; anything else is an action id. */
function readTarget(raw: string | undefined, usage: string): Target {
  if (!raw) throw new Error(`Missing <area|action>.\n${usage}`);
  if (raw === 'files') return { kind: 'files' };
  if ((PERMISSION_AREA_IDS as readonly string[]).includes(raw)) return { kind: 'area', id: raw };
  return { kind: 'action', id: raw };
}

/** Read `<state>`, refusing anything that is not one of the three states. */
function readState(raw: string | undefined, usage: string): PermissionState {
  if (raw && (PERMISSION_STATES as readonly string[]).includes(raw)) {
    return raw as PermissionState;
  }
  throw new Error(
    `${raw ? `'${raw}' is not a state.` : 'Missing <state>.'} Use one of: ${PERMISSION_STATES.join(', ')}.\n${usage}`
  );
}

/** Read a Files & commands stop. */
function readStop(raw: string | undefined, usage: string): PermissionStop {
  const parsed = PermissionStopSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new Error(
    `${raw ? `'${raw}' is not a Files & commands stop.` : 'Missing <stop>.'} Use one of: ${PermissionStopSchema.options.join(', ')}.\n${usage}`
  );
}

/** The areas/actions half of a patch for one target and value. */
function statePatch(target: Target, value: PermissionState | null): Record<string, unknown> {
  if (target.kind === 'area') return { areas: { [target.id]: value } };
  if (target.kind === 'action') return { actions: { [target.id]: value } };
  throw new Error('unreachable: files is not a state');
}

/**
 * Check an action id against the ones this server has, so a typo is caught here
 * with the list to choose from instead of arriving as a refusal. Areas are
 * checked locally; `files` needs no lookup.
 *
 * @param target - What the person named.
 * @throws {Error} Naming every action, by area, when the id is not one of them.
 */
async function checkActionExists(target: Target): Promise<void> {
  if (target.kind !== 'action') return;
  const overview = await apiCall<PermissionsResponse>('GET', '/api/permissions');
  if (overview.areas.some((area) => area.actions.some((action) => action.id === target.id))) {
    return;
  }
  const lines = overview.areas
    .filter((area) => area.actions.length > 0)
    .map((area) => `  ${area.id}: ${area.actions.map((action) => action.id).join(', ')}`);
  throw new Error(
    `'${target.id}' is not an area or an action. Areas: ${PERMISSION_AREA_IDS.join(', ')}.\n` +
      `Actions, by area:\n${lines.join('\n')}`
  );
}

/**
 * Print a refusal, adding the terminal's next step when the server wants the
 * Full autonomy acknowledgement first.
 *
 * @param err - What the call threw.
 */
function explain(err: unknown): void {
  printError(err);
  if (err instanceof ApiError && err.body.code === AUTONOMY_ACK_REQUIRED_CODE) {
    console.error(
      `Run \`${ACKNOWLEDGE_AUTONOMY_COMMAND}\` to read what it means and confirm, then try again.`
    );
  }
}

/** Parse `--json` plus positionals for a subcommand, strictly. */
function parseSimple(args: string[]): { json: boolean; positionals: string[] } {
  const { values, positionals } = parseArgs({
    args,
    options: { json: { type: 'boolean', default: false } },
    allowPositionals: true,
    strict: true,
  });
  return { json: Boolean(values.json), positionals };
}

/** An agent as the Mesh roster returns it. */
interface RosterAgent {
  id: string;
  name: string;
  displayName?: string;
}

/**
 * Find an agent by id, name or display name.
 *
 * @param ref - What the person typed.
 * @returns The agent's id.
 * @throws {Error} When no agent, or more than one, matches.
 */
async function resolveAgentRef(ref: string): Promise<{ id: string; name: string }> {
  const { agents } = await apiCall<{ agents: RosterAgent[] }>('GET', '/api/mesh/agents');
  const byId = agents.find((a) => a.id === ref);
  if (byId) return { id: byId.id, name: byId.displayName ?? byId.name };
  const wanted = ref.toLowerCase();
  const matches = agents.filter(
    (a) => a.name.toLowerCase() === wanted || a.displayName?.toLowerCase() === wanted
  );
  if (matches.length === 1) {
    const [only] = matches;
    return { id: only!.id, name: only!.displayName ?? only!.name };
  }
  if (matches.length > 1) {
    throw new Error(
      `More than one agent is called '${ref}'. Use its id instead: ${matches.map((a) => a.id).join(', ')}.`
    );
  }
  throw new Error(`No agent called '${ref}'. Run \`dorkos agent list\` to see them.`);
}

/** How many distinct agents keep a setting of their own. */
function agentsDiffering(overview: PermissionsResponse): number {
  return new Set([
    ...overview.exceptions.map((e) => e.agentId),
    ...overview.filesAndCommands.exceptions.map((e) => e.agentId),
  ]).size;
}

/** "Full power, 2 changes" / "Not chosen yet". */
function presetLine(overview: PermissionsResponse): string {
  if (!overview.preset) return 'Not chosen yet, so everything works as it did before';
  const label = PRESET_LABEL[overview.preset];
  if (overview.changeCount === 0) return label;
  return `${label}, ${overview.changeCount} change${overview.changeCount === 1 ? '' : 's'}`;
}

/**
 * Implements `dorkos permissions list`.
 *
 * @param json - Print the raw overview.
 * @returns The intended process exit code.
 */
async function runPermissionsList(json: boolean): Promise<number> {
  try {
    const overview = await apiCall<PermissionsResponse>('GET', '/api/permissions');
    if (json) {
      printJson(overview);
      return 0;
    }
    console.log(`Preset: ${presetLine(overview)}`);
    const files = overview.filesAndCommands;
    const perRuntime = files.runtimes.map((r) => `${r.runtime}: ${STOP_LABEL[r.stop]}`);
    console.log(
      `Files & commands: ${stopText(files.stop)}${perRuntime.length ? ` (${perRuntime.join(', ')})` : ''}`
    );
    console.log('');
    const rows = overview.areas.map((area) => [
      area.label,
      area.id,
      STATE_LABEL[area.resolved.state],
      sourceText(area.resolved.source, overview.preset),
    ]);
    console.log(renderTable(['AREA', 'ID', 'STATE', 'WHY'], rows));
    const exceptions = [
      ...overview.exceptions.map((e) => [e.agentName, e.action ?? e.area, STATE_LABEL[e.state]]),
      ...files.exceptions.map((e) => [e.agentName, 'files', STOP_LABEL[e.stop]]),
    ];
    if (exceptions.length > 0) {
      console.log('');
      console.log('Agents with their own settings:');
      console.log(renderTable(['AGENT', 'AREA OR ACTION', 'SETTING'], exceptions));
    }
    return 0;
  } catch (err) {
    explain(err);
    return 1;
  }
}

/** Report a default-layer write, and who kept their own setting. */
function reportDefaultWrite(what: string, overview: PermissionsResponse): void {
  console.log(what);
  const differing = agentsDiffering(overview);
  if (differing > 0) {
    console.log(
      `${differing} agent${differing === 1 ? ' keeps its' : 's keep their'} own settings. See them with \`dorkos permissions\`.`
    );
  }
}

/**
 * Implements `dorkos permissions set` and `dorkos permissions reset`.
 *
 * @param rawArgs - Argv after `set` or `reset`.
 * @param reset - True for `reset`.
 * @returns The intended process exit code.
 */
async function runPermissionsWrite(rawArgs: string[], reset: boolean): Promise<number> {
  const usage = reset
    ? 'Usage: dorkos permissions reset <area|action>'
    : 'Usage: dorkos permissions set <area|action> <state> | set --preset <careful|balanced|full>';
  const { values, positionals } = parseArgs({
    args: rawArgs,
    options: {
      preset: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const json = Boolean(values.json);

  if (!reset && typeof values.preset === 'string') {
    const preset = values.preset;
    if (!(PERMISSION_PRESETS as readonly string[]).includes(preset)) {
      throw new Error(`'${preset}' is not a preset. Use one of: ${PERMISSION_PRESETS.join(', ')}.`);
    }
    try {
      const result = await apiCall<{ changes: unknown[]; permissions: PermissionsResponse }>(
        'PUT',
        '/api/permissions/preset',
        { preset, surface: 'cli' }
      );
      if (json) printJson(result);
      else
        reportDefaultWrite(
          `Preset is now ${PRESET_LABEL[preset as PermissionPreset]}.`,
          result.permissions
        );
      return 0;
    } catch (err) {
      explain(err);
      return 1;
    }
  }

  const target = readTarget(positionals[0], usage);
  if (target.kind === 'files') {
    throw new Error(
      'Files & commands for every agent comes with the preset. To change it on its own, run ' +
        '`dorkos config set runtimes.defaultTrustStop <ask|act|autonomy>`.'
    );
  }
  const state = reset ? null : readState(positionals[1], usage);
  try {
    await checkActionExists(target);
    const result = await apiCall<{ changes: unknown[]; permissions: PermissionsResponse }>(
      'PATCH',
      '/api/permissions/defaults',
      { ...statePatch(target, state), surface: 'cli' }
    );
    if (json) printJson(result);
    else
      reportDefaultWrite(
        state === null
          ? `${target.id} is back to the preset.`
          : `${target.id} is now ${STATE_LABEL[state]} for every agent.`,
        result.permissions
      );
    return 0;
  } catch (err) {
    explain(err);
    return 1;
  }
}

/**
 * Implements `dorkos permissions history`.
 *
 * @param rawArgs - Argv after `history`.
 * @returns The intended process exit code.
 */
async function runPermissionsHistory(rawArgs: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      agent: { type: 'string' },
      limit: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  const params = new URLSearchParams();
  if (typeof values.limit === 'string') {
    const limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error(`Invalid value for --limit: '${values.limit}' (expected 1 to 100).`);
    }
    params.set('limit', String(limit));
  }
  try {
    if (typeof values.agent === 'string') {
      params.set('agentId', (await resolveAgentRef(values.agent)).id);
    }
    const qs = params.toString();
    const history = await apiCall<PermissionHistoryResponse>(
      'GET',
      `/api/permissions/history${qs ? `?${qs}` : ''}`
    );
    if (values.json) {
      printJson(history);
      return 0;
    }
    if (history.items.length === 0) {
      console.log('No permission changes yet.');
      return 0;
    }
    const rows = history.items.map((item) => [
      item.occurredAt,
      item.actorDetail ? `${item.actorLabel} (${item.actorDetail})` : item.actorLabel,
      item.summary,
    ]);
    console.log(renderTable(['WHEN', 'WHO', 'WHAT'], rows));
    return 0;
  } catch (err) {
    explain(err);
    return 1;
  }
}

/**
 * Dispatch `dorkos permissions <subcommand>`.
 *
 * @param rawArgs - Argv after `permissions`.
 * @returns The intended process exit code.
 */
export async function runPermissionsDispatcher(rawArgs: string[]): Promise<number> {
  const subcommand = rawArgs[0];
  if (subcommand === '--help' || subcommand === '-h') {
    console.log(PERMISSIONS_HELP);
    return 0;
  }
  try {
    if (subcommand === undefined || subcommand === 'list' || subcommand === '--json') {
      const rest = subcommand === 'list' ? rawArgs.slice(1) : rawArgs;
      return await runPermissionsList(parseSimple(rest).json);
    }
    if (subcommand === 'set') return await runPermissionsWrite(rawArgs.slice(1), false);
    if (subcommand === 'reset') return await runPermissionsWrite(rawArgs.slice(1), true);
    if (subcommand === 'history') return await runPermissionsHistory(rawArgs.slice(1));
  } catch (err) {
    printError(err);
    return 1;
  }
  console.error(`Unknown permissions subcommand: ${subcommand}\n${PERMISSIONS_HELP}`);
  return 1;
}

/** Print one agent's permissions. */
function printAgent(view: AgentPermissionsResponse): void {
  console.log(`Agent: ${view.agentName} (${view.agentId})`);
  const files = view.filesAndCommands;
  console.log(`Files & commands: ${stopText(files.stop)} (${filesSourceText(files.source)})`);
  console.log('');
  const rows = view.areas.map((area) => [
    area.label,
    area.id,
    STATE_LABEL[area.resolved.state],
    area.resolved.layer === 'agent'
      ? `${sourceText(area.resolved.source, null)} (everyone: ${STATE_LABEL[area.inherited.state]})`
      : area.resolved.layer === 'floor'
        ? 'Never Allowed'
        : 'The setting everyone has',
  ]);
  console.log(renderTable(['AREA', 'ID', 'STATE', 'WHY'], rows));
}

/**
 * Dispatch `dorkos agent permissions <agent> [set|reset …]`.
 *
 * @param rawArgs - Argv after `agent permissions`.
 * @returns The intended process exit code.
 */
export async function runAgentPermissions(rawArgs: string[]): Promise<number> {
  if (rawArgs.length === 0 || rawArgs[0] === '--help' || rawArgs[0] === '-h') {
    console.log(AGENT_PERMISSIONS_HELP);
    return rawArgs.length === 0 ? 1 : 0;
  }
  const usage =
    'Usage: dorkos agent permissions <agent> [set <area|action> <state> | set files <stop> | reset <area|action|files>]';
  try {
    const { json, positionals } = parseSimple(rawArgs);
    const [ref, verb, rawTarget, rawValue] = positionals;
    if (!ref) throw new Error(`Missing <agent>.\n${usage}`);
    const agent = await resolveAgentRef(ref);
    const url = `/api/agents/${encodeURIComponent(agent.id)}/permissions`;

    if (verb === undefined) {
      const view = await apiCall<AgentPermissionsResponse>('GET', url);
      if (json) printJson(view);
      else printAgent(view);
      return 0;
    }
    if (verb !== 'set' && verb !== 'reset') {
      throw new Error(`Unknown agent permissions subcommand: ${verb}\n${usage}`);
    }
    const target = readTarget(rawTarget, usage);
    let body: Record<string, unknown>;
    let done: string;
    if (target.kind === 'files') {
      const stop = verb === 'reset' ? null : readStop(rawValue, usage);
      body = { filesAndCommands: stop };
      done =
        stop === null
          ? `${agent.name}'s Files & commands is back to the setting everyone has.`
          : `${agent.name}'s Files & commands is now ${STOP_LABEL[stop]}.`;
    } else {
      const state = verb === 'reset' ? null : readState(rawValue, usage);
      await checkActionExists(target);
      body = statePatch(target, state);
      done =
        state === null
          ? `${agent.name}'s ${target.id} is back to the setting everyone has.`
          : `${agent.name}'s ${target.id} is now ${STATE_LABEL[state]}.`;
    }
    const result = await apiCall<{ changes: unknown[]; permissions: AgentPermissionsResponse }>(
      'PATCH',
      url,
      { ...body, surface: 'cli' }
    );
    if (json) printJson(result);
    else console.log(done);
    return 0;
  } catch (err) {
    explain(err);
    return 1;
  }
}
