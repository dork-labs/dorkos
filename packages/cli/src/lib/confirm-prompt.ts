/**
 * Minimal y/N readline confirmation prompt for CLI commands.
 *
 * Hand-rolled rather than using `@inquirer/prompts` so the install path
 * keeps its own narrow surface and tests can short-circuit by stubbing
 * `process.stdin.isTTY = false`.
 *
 * @module lib/confirm-prompt
 */
import { createInterface } from 'node:readline';

/**
 * Prompt the user with `<message> [y/N]` and resolve `true` only when the
 * input starts with `y` or `Y`. Resolves `false` on any other input,
 * including an empty line. Skips entirely when stdin is not a TTY (CI,
 * pipes) and resolves to `false` so the caller treats it as a decline.
 *
 * @param message - The question to display, without the `[y/N]` suffix.
 * @returns A promise that resolves to the user's choice.
 */
export async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${message} [y/N] `, resolve);
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
