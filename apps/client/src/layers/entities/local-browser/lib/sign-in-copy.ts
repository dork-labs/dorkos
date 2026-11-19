/**
 * The sign-in window's words, shared by the handoff card and the browser panel so both say
 * the same thing at every step (DOR-4731). The one instruction is Done signing in: on a Mac,
 * closing Chrome's window leaves Chrome running, so DorkOS can't see a close.
 */

/** The button that ends an open sign-in window. */
export const DONE_SIGNING_IN = 'Done signing in';

/**
 * What to do while the sign-in window is open.
 *
 * @param site - The site's host, from DorkOS's own reading, never the agent's word.
 */
export function signInOpenLine(site: string): string {
  return `Sign in to ${site} in the sign-in window, then press ${DONE_SIGNING_IN}.`;
}

/** While the sign-in saves. */
export const SIGN_IN_SAVING = 'Saving your sign-in…';
