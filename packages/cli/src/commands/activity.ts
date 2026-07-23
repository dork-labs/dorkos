/**
 * CLI handler for `dorkos activity`.
 *
 * Reads the activity feed from the running server (`GET /api/activity`) with
 * optional filters. The server query supports category, actor-type, and limit
 * filters; `--type` (event type) is applied client-side after the fetch because
 * the feed endpoint does not filter on it.
 *
 * Accepts `--json` for raw machine output. Returns an exit code rather than
 * calling `process.exit` so `cli.ts` stays the single source of truth for
 * termination.
 *
 * @module commands/activity
 */
import { parseArgs } from 'node:util';
import { apiCall } from '../lib/api-client.js';
import { printError, printJson, renderTable } from '../lib/operator-output.js';

/** Help text for `dorkos activity` (`--help`), rendered by the `cli.ts` interceptor. */
export const ACTIVITY_HELP = `Usage: dorkos activity [options]

Show the DorkOS activity feed from the running server.

Options:
      --actor <type>     Filter by actor type (user|agent|system|tasks)
      --category <name>  Filter by category (comma-separated for multiple)
      --type <event>     Filter by event type (e.g. agent.registered);
                         applied to the fetched page, so events older than
                         --limit are not shown (raise --limit to widen it)
      --limit <n>        Maximum events to return (default: 50, max: 100)
      --json             Print raw JSON instead of a table

Examples:
  dorkos activity
  dorkos activity --actor agent --limit 20
  dorkos activity --category tasks --json
  dorkos activity --type agent.registered`;

/** An activity item as returned by `GET /api/activity`. */
interface ActivityItem {
  id: string;
  occurredAt: string;
  actorType: string;
  actorLabel: string;
  category: string;
  eventType: string;
  summary: string;
}

/** Parsed arguments for `dorkos activity`. */
export interface ActivityArgs {
  actor?: string;
  category?: string;
  type?: string;
  limit?: number;
  json: boolean;
}

/**
 * Parse the argv slice after `dorkos activity`.
 *
 * @param rawArgs - Argv after `activity`.
 * @returns Typed {@link ActivityArgs}.
 */
export function parseActivityArgs(rawArgs: string[]): ActivityArgs {
  const usage =
    'Usage: dorkos activity [--actor <type>] [--category <name>] [--type <event>] [--limit <n>]';
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        actor: { type: 'string' },
        category: { type: 'string' },
        type: { type: 'string' },
        limit: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    if (
      err instanceof TypeError &&
      (err as NodeJS.ErrnoException).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
    ) {
      const match = err.message.match(/Unknown option '([^']+)'/);
      throw new Error(`Unknown option for 'activity': ${match?.[1] ?? 'unknown'}\n${usage}`);
    }
    throw err;
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
    actor: typeof values.actor === 'string' ? values.actor : undefined,
    category: typeof values.category === 'string' ? values.category : undefined,
    type: typeof values.type === 'string' ? values.type : undefined,
    limit,
    json: jsonOf(values),
  };
}

/** Read the `--json` flag off a parsed values object. */
function jsonOf(values: Record<string, unknown>): boolean {
  return Boolean(values.json);
}

/**
 * Implements `dorkos activity`.
 *
 * @param args - Parsed activity arguments.
 * @returns The intended process exit code.
 */
export async function runActivity(args: ActivityArgs): Promise<number> {
  try {
    const params = new URLSearchParams();
    if (args.actor) params.set('actorType', args.actor);
    if (args.category) params.set('categories', args.category);
    if (args.limit !== undefined) params.set('limit', String(args.limit));
    const qs = params.toString();
    const { items } = await apiCall<{ items: ActivityItem[]; nextCursor: string | null }>(
      'GET',
      `/api/activity${qs ? `?${qs}` : ''}`
    );
    // `--type` filters by event type, which the feed endpoint does not support
    // server-side, so apply it here so the flag still narrows the result set.
    const filtered = args.type ? items.filter((i) => i.eventType === args.type) : items;
    if (args.json) {
      printJson(filtered);
      return 0;
    }
    if (filtered.length === 0) {
      console.log('No activity.');
      return 0;
    }
    const rows = filtered.map((i) => [
      i.occurredAt,
      i.actorLabel,
      i.category,
      i.eventType,
      i.summary,
    ]);
    console.log(renderTable(['WHEN', 'ACTOR', 'CATEGORY', 'EVENT', 'SUMMARY'], rows));
    return 0;
  } catch (err) {
    printError(err);
    return 1;
  }
}
