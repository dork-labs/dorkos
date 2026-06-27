/**
 * Shared argv + stdin plumbing for the `/flow` oracle CLI scripts (ADR-0294,
 * tasks 1.2 / 1.3). Every wrapper under `cli/` reads a JSON payload from stdin
 * (or `--input <path>`), invokes a pure decision oracle from `src/`, and writes
 * JSON to stdout. This module is the one place the argv + stdin contract lives,
 * so the five entrypoints stay tiny and identical in shape.
 *
 * It is intentionally dependency-free (node builtins only): the four pure-oracle
 * scripts must bundle to zero-runtime-dep `.mjs`, and this helper is bundled into
 * each of them.
 *
 * @module @dorkos/flow-engine/cli/_shared
 */

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The minimal argv surface every oracle script accepts. */
export interface CliArgs {
  /** Whether `--help` / `-h` was passed (print the JSON shape and exit 0). */
  help: boolean;
  /** Path from `--input <path>` / `--input=<path>`, or `undefined` to read stdin. */
  inputPath?: string;
}

/**
 * Parse the minimal argv every oracle script accepts: `--help` / `-h` and
 * `--input <path>` (or `--input=<path>`). Unknown flags are ignored — the
 * scripts take no positional arguments and read their payload as JSON.
 *
 * @param argv - Args after the node + script entries (`process.argv.slice(2)`).
 * @returns The parsed help flag and optional input path.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--input') {
      out.inputPath = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--input=')) {
      out.inputPath = arg.slice('--input='.length);
    }
  }
  return out;
}

/**
 * Read the script's JSON payload: from `--input <path>` when given, else from
 * stdin read to EOF (file descriptor `0`). The caller parses and validates the
 * returned text; this only does the I/O.
 *
 * @param inputPath - The `--input` path, or `undefined` to read stdin.
 * @returns The raw input text.
 */
export function readRawInput(inputPath?: string): string {
  return readFileSync(inputPath ?? 0, 'utf8');
}

/**
 * Narrow an unknown JSON value to a plain (non-array, non-null) object, the
 * structural guard every wrapper uses before casting its input shape.
 *
 * @param value - An arbitrary parsed-JSON value.
 * @returns `true` when `value` is a non-null, non-array object.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether the module was invoked directly (`node <script>.mjs`) rather than
 * imported. The bundled entrypoints run `main` only when this is true, so they
 * stay importable (e.g. from a test) without auto-executing.
 *
 * @param metaUrl - The entry module's `import.meta.url`.
 * @returns `true` when this module is the process entry point.
 */
export function invokedDirectly(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(entry);
  } catch {
    return false;
  }
}
