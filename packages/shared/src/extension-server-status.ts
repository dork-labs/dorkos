/**
 * What an extension's card says when its server half stopped or cannot start
 * (DOR-2686): one sentence per `serverError.code`, and the line shown while a
 * restart is pending.
 *
 * The server writes these into `serverError.message` and the app shows that
 * message, so both say the same words; the app falls back to this map only
 * when a message is missing. Each sentence is one block of at most 15 words
 * (`writing-app-copy`).
 *
 * @module shared/extension-server-status
 */

/**
 * Whether this version of DorkOS runs the server half of an extension that
 * runs separately (DOR-2686). `false` until the phase that starts isolated
 * extensions lands: the server refuses that half with `isolation_not_ready`
 * (`waitsForIsolation`), and every card says so before the yes
 * ({@link ISOLATED_SERVER_NOT_YET_COPY}). The one switch: flipping it turns
 * the refusal and the card line off together.
 */
export const ISOLATED_SERVER_PARTS_RUN: boolean = false;

/** The card line shown before the yes while {@link ISOLATED_SERVER_PARTS_RUN} is `false`. */
export const ISOLATED_SERVER_NOT_YET_COPY = 'Its server part can’t run in this version yet.';

/** The `serverError` codes an extension that runs separately can carry. */
export const EXTENSION_SERVER_ERROR_CODES = [
  'server_crashed',
  'server_out_of_memory',
  'server_unresponsive',
  'isolation_unavailable',
  'isolation_not_ready',
] as const;

/** One of {@link EXTENSION_SERVER_ERROR_CODES}. */
export type ExtensionServerErrorCode = (typeof EXTENSION_SERVER_ERROR_CODES)[number];

/** The sentence for each code, given the extension's name. */
const COPY: Record<ExtensionServerErrorCode, (name: string) => string> = {
  server_crashed: (name) => `${name} stopped unexpectedly 3 times. Reload it to try again.`,
  server_out_of_memory: (name) => `${name} ran out of memory and stopped. Reload it to try again.`,
  server_unresponsive: (name) => `${name} stopped responding, so DorkOS stopped it.`,
  isolation_unavailable: (name) => `${name} can’t run with its limits on this computer.`,
  // Its screens can still load; only the part that runs separately waits.
  isolation_not_ready: (name) => `${name} needs a newer DorkOS to run its server part.`,
};

/**
 * Whether a `serverError.code` is one of the isolated-extension codes.
 *
 * @param code - The code on the record.
 */
export function isExtensionServerErrorCode(code: string): code is ExtensionServerErrorCode {
  return (EXTENSION_SERVER_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * The card sentence for a code, or `null` for a code this map does not own
 * (a rebuild failure, which the card words on its own).
 *
 * @param code - The `serverError.code`.
 * @param name - The extension's name, e.g. "Mail".
 */
export function extensionServerErrorCopy(code: string, name: string): string | null {
  return isExtensionServerErrorCode(code) ? COPY[code](name) : null;
}

/**
 * The line shown while a restart after a crash is pending.
 *
 * @param name - The extension's name.
 */
export function extensionRestartingCopy(name: string): string {
  return `Restarting ${name}…`;
}
