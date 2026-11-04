/**
 * Masking what looks secret in a global MCP server's arguments and address, for
 * everything a person is shown (DOR-3802). The store keeps the real values,
 * because the server needs them to run; this is only ever for display.
 *
 * It reads flag names and URL shapes, so it misses a bare value (`-p value`).
 * That is why the audited sentence leaves arguments out altogether.
 *
 * @module services/mesh/global-mcp/global-mcp-mask
 */
import { SECRET_NAME_PATTERN } from '@dorkos/shared/global-mcp-schemas';

/** What stands in for a value. */
export const MASK = '•••';

/**
 * Any URL inside a string, down to its scheme and host: hosted MCP addresses
 * often carry their key in the path or the query. Everything before the LAST `@`
 * goes, since a password can hold one. A `file:` URL names a file here and holds
 * no key, so a person still sees what runs.
 *
 * @param text - An argument or an address.
 */
export function maskUrls(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)(\S*)/gi, (url, scheme: string, rest: string) => {
    if (/file:\/\/$/i.test(scheme)) return url;
    const at = rest.lastIndexOf('@');
    const after = at >= 0 ? rest.slice(at + 1) : rest;
    const host = /^[^/?#]*/.exec(after)![0];
    const tail = after.slice(host.length);
    const path = /^\/[^?#]/.test(tail) ? `/${MASK}` : '';
    const query = /[?#]./.test(tail) ? `?${MASK}` : '';
    return `${scheme}${at >= 0 ? `${MASK}@` : ''}${host}${path}${query}`;
  });
}

/**
 * Whether a connection still holds a mask, as a client that read a server and
 * sent it back would. Saving one would run the mask as the real value.
 *
 * @param values - The connection's arguments, address and setting values.
 */
export function holdsMask(values: readonly string[]): boolean {
  return values.some((value) => value.includes(MASK));
}

/**
 * Arguments with secret-named flags' values and URL credentials masked.
 *
 * @param args - The server's arguments.
 */
export function maskedArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  let hideNext = false;
  for (const arg of args) {
    if (hideNext) {
      out.push(MASK);
      hideNext = false;
      continue;
    }
    const flag = /^(--?[^=\s]+)(=?)/.exec(arg);
    if (flag && SECRET_NAME_PATTERN.test(flag[1]!)) {
      if (flag[2] === '=') out.push(`${flag[1]}=${MASK}`);
      else {
        out.push(arg);
        hideNext = true;
      }
      continue;
    }
    out.push(maskUrls(arg));
  }
  return out;
}
