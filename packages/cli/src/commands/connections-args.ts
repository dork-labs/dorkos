/** Shared strict argument helpers for Connections subcommands. */
import fs from 'node:fs';

/**
 * Require one nonblank CLI value and trim its surrounding whitespace.
 *
 * @param value - Parsed argument value.
 * @param flag - Flag or positional name shown in the error.
 * @param usage - Command usage shown in the error.
 * @returns The trimmed value.
 */
export function requireNonblank(value: unknown, flag: string, usage: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required ${flag} value.\n${usage}`);
  }
  return value.trim();
}

/**
 * Reject positional arguments beyond a command's exact arity.
 *
 * @param positionals - Parsed positional arguments.
 * @param expected - Maximum accepted argument count.
 * @param usage - Command usage shown in the error.
 */
export function rejectExtraPositionals(
  positionals: string[],
  expected: number,
  usage: string
): void {
  if (positionals.length > expected) {
    throw new Error(`Too many positional arguments.\n${usage}`);
  }
}

/**
 * Read JSON from one inline value, file, or stdin without accepting both sources.
 *
 * @param inline - Inline JSON value, when supplied.
 * @param file - File path or `-` for stdin, when supplied.
 * @param inlineFlag - Inline flag name for errors.
 * @param fileFlag - File flag name for errors.
 * @param usage - Command usage shown in errors.
 * @returns Parsed JSON, or an empty object when neither source has content.
 */
export function readJsonSource(
  inline: unknown,
  file: unknown,
  inlineFlag: string,
  fileFlag: string,
  usage: string
): unknown {
  if (inline !== undefined && file !== undefined) {
    throw new Error(`Pass only one of ${inlineFlag} or ${fileFlag}, not both.\n${usage}`);
  }
  let raw: string | undefined;
  if (typeof inline === 'string') raw = inline;
  if (typeof file === 'string') {
    try {
      raw = fs.readFileSync(file === '-' ? 0 : file, 'utf8');
    } catch (error) {
      throw new Error(
        `Cannot read ${fileFlag} '${file}': ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }
  if (raw === undefined || raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON for ${inlineFlag}: ${error instanceof Error ? error.message : String(error)}\n${usage}`,
      { cause: error }
    );
  }
}
