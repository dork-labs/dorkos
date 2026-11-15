/**
 * Reading a project's own instruction files (`AGENTS.md`, `CLAUDE.md`) into a
 * prompt, safely (DOR-4405).
 *
 * Both runtimes pass this text after DorkOS's own instructions when the
 * project's settings are not loaded (`opencode/messaging/project-instructions.ts`,
 * `claude-code/folder-settings/folder-instructions.ts`). A cloned project
 * chooses what sits at those paths, so two things are refused here:
 *
 * - **Anything but a regular file.** A symlink is never followed, so an
 *   `AGENTS.md` pointing at a file outside the project is not read. The file is
 *   opened without blocking and checked on the open handle, so a FIFO or a
 *   device answers at once instead of hanging the turn, and nothing can be
 *   swapped in between the check and the read.
 * - **More text than the budget.** All the files together get
 *   {@link INSTRUCTION_BUDGET_CHARS}; past it, the text is cut and a one-line
 *   marker says so, so a huge file cannot crowd out the agent's own persona.
 *   DorkOS's text always comes first; the callers place this after it.
 *
 * @module services/runtimes/shared/project-files/instruction-files
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';

/** How much project instruction text one prompt carries, headers included. */
export const INSTRUCTION_BUDGET_CHARS = 32 * 1024;

/** Said once, at the end, when the budget cut something. */
export const TRIMMED_MARKER =
  `[DorkOS trimmed the project's instructions here: together they are longer than ` +
  `${INSTRUCTION_BUDGET_CHARS} characters.]`;

/** Open flags: read only, never follow a symlink, never wait on a FIFO. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * Up to `maxChars` of a regular file's text, and whether there was more; or
 * `undefined` when it is absent, unreadable, a symlink, or not a regular file.
 *
 * @param file - The path to read.
 * @param maxChars - The most text to return.
 */
export function readInstructionFile(
  file: string,
  maxChars: number
): { text: string; more: boolean } | undefined {
  let fd: number | undefined;
  try {
    // Where the platform has no O_NOFOLLOW (Windows), ask about the link first.
    if (constants.O_NOFOLLOW === undefined && lstatSync(file).isSymbolicLink()) return undefined;
    fd = openSync(file, OPEN_FLAGS);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return undefined;
    // A UTF-8 character is at most 4 bytes; read one past the limit to know there is more.
    const buffer = Buffer.alloc(Math.min(stat.size, maxChars * 4 + 4));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const whole = buffer.subarray(0, read).toString('utf8');
    const more = whole.length > maxChars || read < stat.size;
    return { text: whole.slice(0, maxChars), more };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The text of these instruction files, in order, each headed by its path, cut
 * to {@link INSTRUCTION_BUDGET_CHARS} with {@link TRIMMED_MARKER} when it ran
 * over; `undefined` when none has any text.
 *
 * @param files - The files to read, outermost first.
 */
export function joinInstructionFiles(files: readonly string[]): string | undefined {
  const parts: string[] = [];
  let left = INSTRUCTION_BUDGET_CHARS;
  let trimmed = false;
  for (const file of files) {
    const header = `Contents of ${file}:\n\n`;
    const room = left - header.length - (parts.length > 0 ? 2 : 0);
    const found = readInstructionFile(file, Math.max(room, 0));
    if (found === undefined) continue;
    if (room <= 0 || found.text.trim() === '') {
      // Out of room for a file that has text: that is a cut too.
      if (found.more) trimmed = true;
      continue;
    }
    parts.push(`${header}${found.text}`);
    left = room - found.text.length;
    if (found.more) trimmed = true;
  }
  if (parts.length === 0) return undefined;
  const text = parts.join('\n\n');
  return trimmed ? `${text}\n\n${TRIMMED_MARKER}` : text;
}
