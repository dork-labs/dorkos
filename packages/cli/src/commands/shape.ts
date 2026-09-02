/**
 * CLI handler for `dorkos shape <subcommand>`.
 *
 * A thin HTTP client over the Shape routes (`/api/shapes/*`). Ships the `fork`
 * subcommand today: `dorkos shape fork <name> [--as <newName>] [--capture-current]`
 * calls `POST /api/shapes/:name/fork` and prints a one-line summary.
 *
 * @module commands/shape
 */
import { parseArgs } from 'node:util';
import { ApiError, apiCall } from '../lib/api-client.js';
import { rethrowUnknownOption } from '../lib/parse-args-error.js';

/** Parsed arguments for `dorkos shape fork`. */
export interface ShapeForkArgs {
  /** Source Shape name to fork. */
  name: string;
  /** New Shape name (defaults server-side to `<name>-fork`). */
  as?: string;
  /**
   * Snapshot the live arrangement when forking the active Shape. From the CLI
   * this captures the enabled-extension set only — live window chrome rides
   * along only when a client passes `liveLayout`, which the in-app Shape
   * switcher does (DOR-402). Whatever is not passed keeps the source Shape's
   * value.
   */
  captureCurrent?: boolean;
}

/** Fork API response shape. Mirrors `ForkShapeResult` on the server. */
interface ForkResultBody {
  ok: true;
  name: string;
  forkedFrom: string;
  installPath: string;
}

/** One-line usage string surfaced in error messages. */
const FORK_USAGE = 'Usage: dorkos shape fork <name> [--as <newName>] [--capture-current]';

/** Top-level usage for `dorkos shape`. */
const SHAPE_USAGE = `Usage: dorkos shape <subcommand>

Subcommands:
  fork <name> [--as <newName>] [--capture-current]   Fork an installed Shape

Note: from the CLI, --capture-current snapshots which extensions are enabled.
It cannot see your window layout, so your copy keeps the original's. Use "Make
your own version" in the app's Shape switcher when the layout is what you want
to keep.

Examples:
  dorkos shape fork linear-ops
  dorkos shape fork linear-ops --as my-ops`;

/**
 * Parse the raw argv slice that follows `dorkos shape fork`.
 *
 * @param rawArgs - The argv slice after `fork`.
 * @returns Typed {@link ShapeForkArgs}.
 */
export function parseShapeForkArgs(rawArgs: string[]): ShapeForkArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        as: { type: 'string' },
        'capture-current': { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    rethrowUnknownOption(err, 'shape fork', FORK_USAGE);
  }

  const { values, positionals } = parsed;
  const name = positionals[0];
  if (!name) {
    throw new Error(`Missing required <name> argument.\n${FORK_USAGE}`);
  }

  return {
    name,
    as: typeof values.as === 'string' ? values.as : undefined,
    captureCurrent: Boolean(values['capture-current']),
  };
}

/**
 * Implements `dorkos shape fork <name>`.
 *
 * @param args - Parsed fork arguments.
 * @returns The intended process exit code (`0` success, `1` error).
 */
export async function runShapeFork(args: ShapeForkArgs): Promise<number> {
  try {
    const body: Record<string, unknown> = {};
    if (args.as) body.as = args.as;
    if (args.captureCurrent) body.captureCurrent = true;

    const result = await apiCall<ForkResultBody>(
      'POST',
      `/api/shapes/${encodeURIComponent(args.name)}/fork`,
      body
    );

    console.log(`Forked ${result.forkedFrom} → ${result.name}`);
    console.log(`  ${result.installPath}`);
    return 0;
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return 1;
  }
}

/**
 * Dispatch `dorkos shape <subcommand>`.
 *
 * @param rawArgs - The argv slice after `shape`.
 * @returns The intended process exit code.
 */
export async function runShapeDispatcher(rawArgs: string[]): Promise<number> {
  const subcommand = rawArgs[0];

  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    console.log(SHAPE_USAGE);
    return subcommand === undefined ? 1 : 0;
  }

  if (subcommand === 'fork') {
    const args = parseShapeForkArgs(rawArgs.slice(1));
    return runShapeFork(args);
  }

  console.error(`Unknown shape subcommand: ${subcommand}\n${SHAPE_USAGE}`);
  return 1;
}
