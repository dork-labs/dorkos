/**
 * CLI handler for `dorkos debug`.
 *
 * The in-memory truths, from a terminal. `GET /api/debug/*` already answers them
 * over HTTP; this is the shape a person reaches for at 2am, and the one an agent
 * on a runtime without in-session MCP tools can reach at all.
 *
 * Human table by default, raw JSON on `--json` (and nothing else on stdout, so
 * it pipes into `jq`). Returns an exit code rather than calling `process.exit`,
 * so `cli.ts` stays the single source of truth for termination.
 *
 * @module commands/debug
 */
import { apiCall } from '../lib/api-client.js';
import { printError, printJson, renderTable } from '../lib/operator-output.js';

/** Help text for `dorkos debug` (`--help`), rendered by the `cli.ts` interceptor. */
export const DEBUG_HELP = `Usage: dorkos debug <subject> [options]

Read what DorkOS knows right now but keeps in memory: which agents are mid-turn,
what was recently refused, which sessions have a live stream, and whether a
room's conversations still have transcripts on disk.

Nothing here is stored and nothing is sent anywhere. It reads the running
server, so DorkOS has to be up. Ids, counts and times only — never the text of
a message.

Subjects:
  dispatches           Agents working right now, plus what ran recently
  refusals             Recent times DorkOS declined to do something, and why
  projectors           Sessions with a live event stream, and who is watching
  phantoms             Times an agent's own work was cut short by mistake, not by you
  session <id>         One session: its state, its lock, what it is waiting on
  room <id>            One room's agent sessions, and whether each has a transcript
  trace <trace-id>     Every hop of one dispatch across a chat integration

Options:
      --limit <n>      How many recent rows to show (dispatches, refusals, phantoms)
      --json           Print the raw JSON instead of a table

Examples:
  dorkos debug dispatches
  dorkos debug refusals --limit 20
  dorkos debug session 0199a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b
  dorkos debug refusals --json | jq 'group_by(.reason)'
  dorkos debug phantoms --json | jq '.byPath'`;

/** Parsed arguments for `dorkos debug`. */
export interface DebugArgs {
  subject: 'dispatches' | 'refusals' | 'projectors' | 'phantoms' | 'session' | 'room' | 'trace';
  /** The id a subject needs, when it needs one. */
  id?: string;
  limit?: number;
  json: boolean;
}

/** Subjects that take an id, and would answer nothing without one. */
const SUBJECTS_WITH_ID = new Set(['session', 'room', 'trace']);

/**
 * Parse the argv slice after `dorkos debug`.
 *
 * @param rawArgs - Argv after `debug`.
 * @returns Typed {@link DebugArgs}.
 */
export function parseDebugArgs(rawArgs: string[]): DebugArgs {
  const usage =
    'Usage: dorkos debug <dispatches|refusals|projectors|phantoms|session <id>|room <id>|trace <id>> [--limit <n>] [--json]';
  const positionals: string[] = [];
  let json = false;
  let limit: number | undefined;

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--limit') {
      const value = Number.parseInt(rawArgs[++i] ?? '', 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`--limit needs a positive number\n${usage}`);
      }
      limit = value;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option for 'debug': ${arg}\n${usage}`);
    } else {
      positionals.push(arg);
    }
  }

  const [subject, id] = positionals;
  if (!subject) throw new Error(`'debug' needs a subject\n${usage}`);
  if (!isSubject(subject)) throw new Error(`Unknown subject: ${subject}\n${usage}`);
  if (SUBJECTS_WITH_ID.has(subject) && !id) {
    throw new Error(`'debug ${subject}' needs an id\n${usage}`);
  }

  return {
    subject,
    json,
    ...(id !== undefined ? { id } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

/** Whether a positional names a subject this command knows. */
function isSubject(value: string): value is DebugArgs['subject'] {
  return ['dispatches', 'refusals', 'projectors', 'phantoms', 'session', 'room', 'trace'].includes(
    value
  );
}

/** The path each subject reads. */
function pathFor(args: DebugArgs): string {
  const query = args.limit !== undefined ? `?limit=${args.limit}` : '';
  switch (args.subject) {
    case 'dispatches':
      return `/api/debug/dispatches${query}`;
    case 'refusals':
      return `/api/debug/refusals${query}`;
    case 'projectors':
      return '/api/debug/projectors';
    case 'phantoms':
      return `/api/debug/phantom-cancellations${query}`;
    case 'session':
      return `/api/debug/sessions/${encodeURIComponent(args.id as string)}`;
    case 'room':
      return `/api/debug/rooms/${encodeURIComponent(args.id as string)}/bindings`;
    case 'trace':
      return `/api/debug/relay/traces/${encodeURIComponent(args.id as string)}`;
  }
}

/** One live claim, as `/api/debug/dispatches` reports it. */
interface ClaimRow {
  roomId: string;
  authorId: string;
  entryId: string;
  dispatchId: string;
  claimedAt: string;
  heldMs: number;
  pastDeadline: boolean;
}

/** One buffered dispatch. */
interface DispatchRow {
  dispatchId: string;
  origin: string;
  startedAt: string;
  endedAt: string | null;
  outcome: string | null;
  roomId?: string;
  sessionId?: string;
}

/** One buffered refusal. */
interface RefusalRow {
  at: string;
  dispatchId?: string;
  origin?: string;
  reason: string;
  visibility: string;
  roomId?: string;
  authorId?: string;
  sessionId?: string;
}

/** One batch of phantom cancellations, as `/api/debug/phantom-cancellations` reports it. */
interface PhantomRow {
  at: string;
  sessionId: string;
  path: string;
  toolUseIds: string[];
  mainThread: boolean;
  parentToolUseId: string | null;
  steered: boolean;
}

/** The tripwire's totals, alongside its recent batches. */
interface PhantomsPayload {
  total: number;
  batches: number;
  byPath: { turn: number; pump: number };
  mainThread: number;
  subagent: number;
  steered: number;
  sessions: number;
  since: string;
  recent: PhantomRow[];
}

/** Render a duration the way a person reads one. */
function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 100) / 10}s`;
  return `${Math.round(ms / 6_000) / 10}m`;
}

/** Print the human view of one subject. */
function renderHuman(args: DebugArgs, payload: Record<string, unknown>): void {
  if (args.subject === 'dispatches') {
    const claims = (payload.claims ?? []) as ClaimRow[];
    const recent = (payload.recent ?? []) as DispatchRow[];
    console.log(
      claims.length === 0
        ? 'No agent is mid-turn right now.'
        : renderTable(
            ['ROOM', 'AGENT', 'HELD', 'DISPATCH', 'STATE'],
            claims.map((c) => [
              c.roomId,
              c.authorId,
              duration(c.heldMs),
              c.dispatchId,
              c.pastDeadline ? 'late' : 'working',
            ])
          )
    );
    console.log('');
    console.log(
      recent.length === 0
        ? 'Nothing has been dispatched since this server started.'
        : renderTable(
            ['STARTED', 'ORIGIN', 'OUTCOME', 'DISPATCH'],
            recent.map((d) => [d.startedAt, d.origin, d.outcome ?? 'running', d.dispatchId])
          )
    );
    return;
  }

  if (args.subject === 'refusals') {
    const refusals = (payload.refusals ?? []) as RefusalRow[];
    if (refusals.length === 0) {
      console.log('Nothing has been refused since this server started.');
      return;
    }
    console.log(
      renderTable(
        ['WHEN', 'REASON', 'SEEN', 'WHERE', 'DISPATCH'],
        refusals.map((r) => [
          r.at,
          r.reason,
          r.visibility,
          r.roomId ?? r.sessionId ?? '—',
          r.dispatchId ?? '—',
        ])
      )
    );
    return;
  }

  if (args.subject === 'phantoms') {
    const p = payload as unknown as PhantomsPayload;
    if (p.total === 0) {
      // The expected reading, and worth saying in words rather than as a table
      // of zeros: nothing has gone wrong since this server started.
      console.log(`No work has been cut short since ${p.since}.`);
      return;
    }
    console.log(
      `${p.total} tool ${p.total === 1 ? 'call' : 'calls'} cut short in ${p.batches} ` +
        `${p.batches === 1 ? 'batch' : 'batches'}, ${p.sessions} ` +
        `${p.sessions === 1 ? 'session' : 'sessions'}, since ${p.since}`
    );
    console.log(
      `turn ${p.byPath.turn} · pump ${p.byPath.pump} · main thread ${p.mainThread} · ` +
        `inside helpers ${p.subagent} · ${p.steered} corrected`
    );
    console.log('');
    console.log(
      renderTable(
        ['WHEN', 'PATH', 'CALLS', 'THREAD', 'TOLD', 'SESSION'],
        p.recent.map((r) => [
          r.at,
          r.path,
          String(r.toolUseIds.length),
          // The helper's own id is not knowable from here, so a helper batch is
          // named by the task that dispatched it — the id its coordinator uses.
          r.mainThread ? 'main' : (r.parentToolUseId ?? 'helper'),
          r.steered ? 'yes' : 'no',
          r.sessionId,
        ])
      )
    );
    return;
  }

  // The remaining subjects are small, irregular objects. A table would invent a
  // shape they do not have, so they print as JSON — which is also what anybody
  // asking these questions wants to paste into an issue.
  printJson(payload);
}

/**
 * Implements `dorkos debug`.
 *
 * @param args - Parsed debug arguments.
 * @returns The intended process exit code.
 */
export async function runDebug(args: DebugArgs): Promise<number> {
  try {
    const payload = await apiCall<Record<string, unknown>>('GET', pathFor(args));
    if (args.json) {
      printJson(payload);
      return 0;
    }
    renderHuman(args, payload);
    return 0;
  } catch (err) {
    printError(err);
    return 1;
  }
}
