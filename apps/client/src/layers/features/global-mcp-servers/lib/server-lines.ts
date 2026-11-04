/**
 * The words the list and the server sheet read off a server. Nothing here has a value to show.
 *
 * @module features/global-mcp-servers/lib/server-lines
 */
import type { GlobalMcpServerField, GlobalMcpServerView } from '@dorkos/shared/global-mcp-schemas';
import { STEP_UP_REQUIRED_CODE } from '@dorkos/shared/step-up';

/** What a secret's value shows as. */
const MASK = '••••••••';

/** How many agent names a row spells out before counting the rest. */
const NAMES_ON_A_ROW = 2;

/** Hosts a request to never leaves this computer. */
const LOCAL_HOST = /^(localhost|127(?:\.\d+){3}|\[::1\]|.+\.localhost)$/i;

/**
 * Who gets a server, as a row says it.
 *
 * @param excluded - The agent ids it is kept from.
 * @param nameOf - An agent's name, or `undefined` for one that is gone.
 */
export function scopeLine(
  excluded: readonly string[],
  nameOf: (agentId: string) => string | undefined
): string {
  if (excluded.length === 0) return 'All agents';
  const names = excluded.flatMap((id) => nameOf(id) ?? []);
  const shown = names.slice(0, NAMES_ON_A_ROW);
  const more = excluded.length - shown.length;
  if (shown.length === 0) return `All agents except ${more}`;
  return `All agents except ${shown.join(', ')}${more > 0 ? ` +${more} more` : ''}`;
}

/**
 * One env var or header as the mono block shows it. The list carries names and no values, so a
 * secret shows as a mask and anything else as its name.
 *
 * @param field - The field.
 */
export function fieldLine(field: GlobalMcpServerField): string {
  return field.secret ? `${field.name}=${MASK}` : field.name;
}

/**
 * How many saved secrets a server holds.
 *
 * @param server - The server.
 */
export function savedSecretCount(server: GlobalMcpServerView): number {
  return [...server.env, ...server.headers].filter((field) => field.secret).length;
}

/**
 * The secret headers a server would send over plain `http://` off this computer.
 *
 * @param server - The server.
 */
export function unencryptedSecretHeaders(server: GlobalMcpServerView): string[] {
  if (!server.url) return [];
  let url: URL;
  try {
    url = new URL(server.url);
  } catch {
    return [];
  }
  if (url.protocol !== 'http:' || LOCAL_HOST.test(url.hostname)) return [];
  return server.headers.filter((field) => field.secret).map((field) => field.name);
}

/**
 * Whether a change came back because the person didn't confirm it: nothing changed.
 *
 * @param error - What the change rejected with.
 */
export function wasNotConfirmed(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === STEP_UP_REQUIRED_CODE;
}

/**
 * A rejection's own words: the server's, written for this person.
 *
 * @param error - What the change rejected with.
 */
export function changeError(error: unknown): string {
  if ((error as { noResponse?: unknown } | null)?.noResponse === true) {
    return 'Can’t reach DorkOS. Check that it’s running.';
  }
  return error instanceof Error && error.message !== ''
    ? error.message
    : 'That didn’t work. Try again.';
}
