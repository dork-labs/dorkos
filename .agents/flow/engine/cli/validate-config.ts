/**
 * CLI wrapper over {@link FlowConfigSchema} — validates a `.agents/flow/config.json`
 * object against the authoritative Zod schema. Reads the config from stdin (or
 * `--input <path>`) and emits `{ ok: true, config }` with the fully-resolved
 * config (defaults filled) on success, or `{ ok: false, errors }` (the Zod issue
 * list) on failure.
 *
 * Unlike the four pure-oracle scripts, this one bundles Zod IN: esbuild inlines
 * the schema + its runtime so the emitted `.mjs` stays self-contained and
 * dependency-free at install time.
 *
 * @module @dorkos/flow-engine/cli/validate-config
 */

import { FlowConfigSchema } from '../src/config-schema.js';
import { invokedDirectly, parseArgs, readRawInput } from './_shared.js';

const HELP = `validate-config — validate a /flow config object against FlowConfigSchema.

Reads a config object as JSON from stdin (or --input <path>).

Writes the result as JSON to stdout:
  { "ok": true,  "config": <fully-resolved FlowConfig> }    // exit 0
  { "ok": false, "errors": ZodIssue[] }                      // exit 1

Exit codes: 0 valid | 1 invalid (schema violation or unreadable/non-JSON input).
`;

/**
 * Run the validate-config CLI: parse args, read the config payload, run it
 * through {@link FlowConfigSchema} (via `safeParse`), and write the typed result
 * to stdout. Returns `0` only when the config is valid; both a schema violation
 * and unreadable / non-JSON input return `1` with `{ ok: false, errors }`.
 *
 * @param argv - Process args after node + script (`process.argv.slice(2)`).
 * @returns The exit code: 0 valid, 1 invalid.
 */
export function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readRawInput(args.inputPath));
  } catch (err) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, errors: [{ message: `invalid JSON: ${(err as Error).message}` }] })}\n`
    );
    return 1;
  }

  const result = FlowConfigSchema.safeParse(parsed);
  if (result.success) {
    process.stdout.write(`${JSON.stringify({ ok: true, config: result.data })}\n`);
    return 0;
  }

  process.stdout.write(`${JSON.stringify({ ok: false, errors: result.error.issues })}\n`);
  return 1;
}

if (invokedDirectly(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
