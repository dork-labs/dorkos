/**
 * CLI handlers for `dorkos task list|create|trigger|runs`.
 *
 * Thin HTTP wrappers over the running server's Tasks scheduler API:
 *
 * - `task list`            → `GET /api/tasks`
 * - `task create`          → `POST /api/tasks`
 * - `task trigger <id>`    → `POST /api/tasks/:id/trigger`
 * - `task runs`            → `GET /api/tasks/runs`
 *
 * Every verb accepts `--json` for raw machine output. Handlers return an exit
 * code rather than calling `process.exit` so `cli.ts` stays the single source of
 * truth for termination.
 *
 * @module commands/task
 */
import { parseArgs } from 'node:util';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import { isUnattendedAutonomy } from '@dorkos/shared/permission-semantics';
import { apiCall } from '../lib/api-client.js';
import { printError, printJson, renderTable } from '../lib/operator-output.js';

/** Help text for `dorkos task` (no subcommand or `--help`). */
const TASK_USAGE = `Usage: dorkos task <subcommand> [options]

Manage scheduled tasks on the running DorkOS server.

Subcommands:
  list                       List every scheduled task
  create [options]           Create a scheduled task
  trigger <id>               Run a scheduled task now
  runs [options]             List recent runs

Options (all subcommands):
      --json   Print raw JSON instead of a table

create options:
      --name <name>          Scheduled task name (required)
      --description <text>   What the scheduled task does (required)
      --prompt <text>        The instruction the agent runs (required)
      --target <ref>         Agent id, or 'global' (required)
      --cron <expr>          Cron schedule (omit for a run-on-request task)
      --timezone <tz>        IANA timezone for the schedule
      --display-name <name>  Human-friendly name

runs options:
      --schedule <id>        Only runs for this scheduled task
      --status <status>      Filter by run status
      --limit <n>            Maximum runs to return

Examples:
  dorkos task list
  dorkos task create --name nightly --description "Nightly sweep" \\
    --prompt "Review open PRs" --target global --cron "0 2 * * *"
  dorkos task trigger 01J...
  dorkos task runs --limit 10 --json`;

/** A scheduled task as returned by `GET /api/tasks`. */
interface TaskSchedule {
  id: string;
  name: string;
  displayName?: string | null;
  cron?: string | null;
  enabled: boolean;
  status?: string;
  nextRun?: string | null;
  /** How much the run may do without asking, as the server resolved it. */
  permissionMode?: string | null;
}

/**
 * The runtime a scheduled run executes on.
 *
 * The same assumption the server and the task form both make, written down in a
 * third place rather than imported, because this package is the published CLI
 * bundle and reaching into server internals for a constant would drag the module
 * graph with it. The reasoning lives once, in
 * `apps/server/src/services/tasks/scheduled-run-power.ts`: a task carries no
 * runtime of its own and the scheduler's is fixed at boot to Claude Code, so the
 * registry default is the wrong thing to read. If that stops being true, all
 * three move together.
 */
const TASK_RUNTIME = 'claude-code';

/** What `GET /api/capabilities` answers, narrowed to the part read here. */
interface CapabilitiesResponse {
  capabilities?: Record<
    string,
    { permissionModes?: { values?: readonly PermissionModeDescriptor[] } }
  >;
}

/**
 * One plain sentence naming the level a task will run at, when that level never
 * stops to ask — and nothing at all otherwise.
 *
 * `dorkos task create` has no flag for the permission mode, so it ALWAYS omits
 * it and the server always resolves one from the operator's configured trust
 * stop (spec `full-power-defaults`, D6). On an install sitting at full autonomy
 * that quietly arms a cron nothing will ever pause to ask about, and a person
 * who typed six flags about a schedule deserves to be told which of them they
 * did not type mattered most.
 *
 * **The judgement is the runtime's, never this id's.** The mode is looked up in
 * the profile its runtime published and put to `isUnattendedAutonomy` — the same
 * rule the cockpit's standing banner uses — because reading "bypassPermissions"
 * as dangerous by its name is the substrate mistake this codebase keeps
 * refusing to make. A mode the profile does not describe says nothing.
 *
 * Advisory only: any failure reaching the server, and any shape it does not
 * recognise, answers `null`. Telling somebody about a task is not worth failing
 * the create that already succeeded.
 *
 * @param permissionMode - The mode the server stored on the new task.
 * @returns The line to print, or `null` when there is nothing worth saying.
 */
async function describeUnattendedLevel(
  permissionMode: string | null | undefined
): Promise<string | null> {
  if (!permissionMode) return null;
  try {
    const { capabilities } = await apiCall<CapabilitiesResponse>('GET', '/api/capabilities');
    const declared = capabilities?.[TASK_RUNTIME]?.permissionModes?.values ?? [];
    const descriptor = declared.find((mode) => mode.id === permissionMode);
    if (!descriptor || !isUnattendedAutonomy(descriptor)) return null;
    return `Runs at full power — no approval prompts (from your default trust level). Change it in Settings, or per task.`;
  } catch {
    return null;
  }
}

/** Parsed arguments for `task create`. */
export interface TaskCreateArgs {
  name: string;
  description: string;
  prompt: string;
  target: string;
  cron?: string;
  timezone?: string;
  displayName?: string;
  json: boolean;
}

/** Parsed arguments for `task runs`. */
export interface TaskRunsArgs {
  scheduleId?: string;
  status?: string;
  limit?: number;
  json: boolean;
}

/** Read the `--json` flag off a parsed values object. */
function jsonOf(values: Record<string, unknown>): boolean {
  return Boolean(values.json);
}

/** Map an `ERR_PARSE_ARGS_UNKNOWN_OPTION` into a friendly per-subcommand error. */
function rethrowUnknownOption(err: unknown, subcommand: string, usage: string): never {
  if (
    err instanceof TypeError &&
    (err as NodeJS.ErrnoException).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
  ) {
    const match = err.message.match(/Unknown option '([^']+)'/);
    throw new Error(
      `Unknown option for 'task ${subcommand}': ${match?.[1] ?? 'unknown'}\n${usage}`
    );
  }
  throw err;
}

/**
 * Parse the argv slice after `dorkos task create`.
 *
 * @param rawArgs - Argv after `create`.
 * @returns Typed {@link TaskCreateArgs}.
 */
export function parseTaskCreateArgs(rawArgs: string[]): TaskCreateArgs {
  const usage =
    'Usage: dorkos task create --name <name> --description <text> --prompt <text> --target <ref> [--cron <expr>]';
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        name: { type: 'string' },
        description: { type: 'string' },
        prompt: { type: 'string' },
        target: { type: 'string' },
        cron: { type: 'string' },
        timezone: { type: 'string' },
        'display-name': { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    rethrowUnknownOption(err, 'create', usage);
  }
  const { values } = parsed;
  const name = typeof values.name === 'string' ? values.name : undefined;
  const description = typeof values.description === 'string' ? values.description : undefined;
  const prompt = typeof values.prompt === 'string' ? values.prompt : undefined;
  const target = typeof values.target === 'string' ? values.target : undefined;
  if (!name) throw new Error(`Missing required --name.\n${usage}`);
  if (!description) throw new Error(`Missing required --description.\n${usage}`);
  if (!prompt) throw new Error(`Missing required --prompt.\n${usage}`);
  if (!target) throw new Error(`Missing required --target.\n${usage}`);
  return {
    name,
    description,
    prompt,
    target,
    cron: typeof values.cron === 'string' ? values.cron : undefined,
    timezone: typeof values.timezone === 'string' ? values.timezone : undefined,
    displayName: typeof values['display-name'] === 'string' ? values['display-name'] : undefined,
    json: jsonOf(values),
  };
}

/**
 * Parse the argv slice after `dorkos task runs`.
 *
 * @param rawArgs - Argv after `runs`.
 * @returns Typed {@link TaskRunsArgs}.
 */
export function parseTaskRunsArgs(rawArgs: string[]): TaskRunsArgs {
  const usage = 'Usage: dorkos task runs [--schedule <id>] [--status <status>] [--limit <n>]';
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        schedule: { type: 'string' },
        status: { type: 'string' },
        limit: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    rethrowUnknownOption(err, 'runs', usage);
  }
  const { values } = parsed;
  let limit: number | undefined;
  if (typeof values.limit === 'string') {
    const parsedLimit = Number(values.limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      throw new Error(
        `Invalid value for --limit: '${values.limit}' (expected a positive integer).\n${usage}`
      );
    }
    limit = parsedLimit;
  }
  return {
    scheduleId: typeof values.schedule === 'string' ? values.schedule : undefined,
    status: typeof values.status === 'string' ? values.status : undefined,
    limit,
    json: jsonOf(values),
  };
}

/**
 * Implements `dorkos task list`.
 *
 * @param json - When true, print the raw schedules array as JSON.
 * @returns The intended process exit code.
 */
export async function runTaskList(json: boolean): Promise<number> {
  try {
    const schedules = await apiCall<TaskSchedule[]>('GET', '/api/tasks');
    if (json) {
      printJson(schedules);
      return 0;
    }
    if (schedules.length === 0) {
      console.log('No scheduled tasks.');
      return 0;
    }
    const rows = schedules.map((s) => [
      s.displayName ?? s.name,
      s.id,
      s.cron ?? '(manual)',
      s.enabled ? 'on' : 'off',
      s.nextRun ?? '-',
    ]);
    console.log(renderTable(['NAME', 'ID', 'CRON', 'ENABLED', 'NEXT RUN'], rows));
    return 0;
  } catch (err) {
    printError(err);
    return 1;
  }
}

/**
 * Implements `dorkos task create`.
 *
 * @param args - Parsed create arguments.
 * @returns The intended process exit code.
 */
export async function runTaskCreate(args: TaskCreateArgs): Promise<number> {
  try {
    const body: Record<string, unknown> = {
      name: args.name,
      description: args.description,
      prompt: args.prompt,
      target: args.target,
    };
    if (args.cron) body.cron = args.cron;
    if (args.timezone) body.timezone = args.timezone;
    if (args.displayName) body.displayName = args.displayName;
    const created = await apiCall<TaskSchedule>('POST', '/api/tasks', body);
    if (args.json) {
      printJson(created);
      return 0;
    }
    console.log(`Created scheduled task ${created.displayName ?? created.name} (${created.id})`);
    // Printed after the success line, and only when there is something a person
    // would want to have been told. `--json` callers get the mode in the payload
    // and no prose.
    const level = await describeUnattendedLevel(created.permissionMode);
    if (level) console.log(level);
    return 0;
  } catch (err) {
    printError(err);
    return 1;
  }
}

/**
 * Implements `dorkos task trigger <id>`.
 *
 * @param id - The schedule id to run now.
 * @param json - When true, print the raw `{ runId }` response as JSON.
 * @returns The intended process exit code.
 */
export async function runTaskTrigger(id: string, json: boolean): Promise<number> {
  try {
    const result = await apiCall<{ runId: string }>(
      'POST',
      `/api/tasks/${encodeURIComponent(id)}/trigger`
    );
    if (json) {
      printJson(result);
      return 0;
    }
    console.log(`Triggered scheduled task ${id}: run ${result.runId}`);
    return 0;
  } catch (err) {
    printError(err);
    return 1;
  }
}

/**
 * Implements `dorkos task runs`.
 *
 * @param args - Parsed runs arguments.
 * @returns The intended process exit code.
 */
export async function runTaskRuns(args: TaskRunsArgs): Promise<number> {
  try {
    const params = new URLSearchParams();
    if (args.scheduleId) params.set('scheduleId', args.scheduleId);
    if (args.status) params.set('status', args.status);
    if (args.limit !== undefined) params.set('limit', String(args.limit));
    const qs = params.toString();
    const runs = await apiCall<
      Array<{ id: string; scheduleId: string; status: string; startedAt?: string | null }>
    >('GET', `/api/tasks/runs${qs ? `?${qs}` : ''}`);
    if (args.json) {
      printJson(runs);
      return 0;
    }
    if (runs.length === 0) {
      console.log('No runs yet.');
      return 0;
    }
    const rows = runs.map((r) => [r.id, r.scheduleId, r.status, r.startedAt ?? '-']);
    console.log(renderTable(['RUN ID', 'SCHEDULE', 'STATUS', 'STARTED'], rows));
    return 0;
  } catch (err) {
    printError(err);
    return 1;
  }
}

/**
 * Dispatch `dorkos task <subcommand>`.
 *
 * @param rawArgs - Argv after `task`.
 * @returns The intended process exit code.
 */
export async function runTaskDispatcher(rawArgs: string[]): Promise<number> {
  const subcommand = rawArgs[0];
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    console.log(TASK_USAGE);
    return subcommand === undefined ? 1 : 0;
  }

  try {
    if (subcommand === 'list') {
      const { values } = parseArgs({
        args: rawArgs.slice(1),
        options: { json: { type: 'boolean', default: false } },
        allowPositionals: false,
        strict: true,
      });
      return await runTaskList(jsonOf(values));
    }
    if (subcommand === 'create') {
      return await runTaskCreate(parseTaskCreateArgs(rawArgs.slice(1)));
    }
    if (subcommand === 'trigger') {
      const { values, positionals } = parseArgs({
        args: rawArgs.slice(1),
        options: { json: { type: 'boolean', default: false } },
        allowPositionals: true,
        strict: true,
      });
      const id = positionals[0];
      if (!id) {
        console.error('Error: missing required <id>.\nUsage: dorkos task trigger <id>');
        return 1;
      }
      return await runTaskTrigger(id, jsonOf(values));
    }
    if (subcommand === 'runs') {
      return await runTaskRuns(parseTaskRunsArgs(rawArgs.slice(1)));
    }
  } catch (err) {
    printError(err);
    return 1;
  }

  console.error(`Unknown task subcommand: ${subcommand}\n${TASK_USAGE}`);
  return 1;
}
