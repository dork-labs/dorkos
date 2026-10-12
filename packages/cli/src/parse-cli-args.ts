/**
 * The top-level `dorkos` flag table and its parser, kept apart from `cli.ts` so
 * the entry point stays a sequence of steps rather than a wall of option
 * definitions.
 *
 * @module parse-cli-args
 */
import { parseArgs } from 'node:util';

/**
 * Parse the top-level `dorkos` flags, reporting an unrecognised one as a
 * one-line message instead of a Node stack trace.
 *
 * The option table is passed inline so `parseArgs` can infer the exact result
 * shape from it: `values.port` is `string | undefined`, `values.tunnel` is
 * `boolean`, and so on. Returning that inferred value is what makes the
 * inference reachable. Destructuring into pre-declared `let`s (as this used to)
 * widened every flag back to `string | boolean | (string | boolean)[]` — the
 * shape `parseArgs` falls back to when it cannot see the options — so each read
 * downstream silently became a union nobody had narrowed.
 *
 * @param args - The arguments after `dorkos` (defaults to the real argv).
 * @returns The parsed flags and positional arguments.
 */
export function parseCliArgs(args: string[] = process.argv.slice(2)) {
  try {
    return parseArgs({
      args,
      options: {
        port: { type: 'string', short: 'p' },
        tunnel: { type: 'boolean', short: 't', default: false },
        dir: { type: 'string', short: 'd' },
        boundary: { type: 'string', short: 'b' },
        tasks: { type: 'boolean' },
        open: { type: 'boolean' },
        'debug-trace': { type: 'boolean', default: false },
        'log-level': { type: 'string', short: 'l' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        'post-install-check': { type: 'boolean', default: false },
        yes: { type: 'boolean', short: 'y', default: false },
        ref: { type: 'string' },
      },
      allowPositionals: true,
      allowNegative: true,
    });
  } catch (err) {
    if (
      err instanceof TypeError &&
      (err as NodeJS.ErrnoException).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
    ) {
      const match = err.message.match(/Unknown option '([^']+)'/);
      const option = match?.[1] ?? 'unknown';
      console.error(`Unknown option: ${option}`);
      console.error(`Run 'dorkos --help' for usage information.`);
      process.exit(1);
    }
    throw err;
  }
}
