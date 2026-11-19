/**
 * The one way a heavy job is named anywhere the load gate writes: by its program
 * alone (`pnpm`, `tsc`, `docker`), never by its arguments (DOR-4209). Tickets
 * are shared by every agent on the machine, and a command's arguments can carry
 * paths, branch names or anything else an agent typed.
 *
 * @module services/core/load-gate/job-label
 */
import path from 'node:path';

/** A program name: a letter or digit, then up to 63 of letters, digits, `_`, `.`, `+`, `-`. */
export const JOB_LABEL = /^[A-Za-z0-9][\w.+-]{0,63}$/;

/** What a job is called when its program name will not fit {@link JOB_LABEL}. */
const UNNAMED_JOB = 'job';

/**
 * The label for a program, from the word that ran it.
 *
 * @param word - The command word, possibly a path such as `./node_modules/.bin/tsc`.
 */
export function jobLabel(word: string): string {
  const base = path.basename(word);
  return JOB_LABEL.test(base) ? base : UNNAMED_JOB;
}
