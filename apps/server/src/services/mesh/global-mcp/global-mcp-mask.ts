/**
 * Masking what looks secret in a global MCP server's arguments and address, for
 * everything a person is shown (DOR-3802). The store keeps the real values,
 * because the server needs them to run; this is only ever for display.
 *
 * It reads flag names, `name: value` shapes and URLs, so it misses a bare value
 * (`-p value`).
 * That is why the audited sentence leaves arguments out altogether.
 *
 * {@link argsLookSecret} is the same reading, for warning a person as they type. It warns and never
 * refuses, and a plain URL path doesn't count, so a key in a webhook-style path goes unnoticed.
 *
 * @module services/mesh/global-mcp/global-mcp-mask
 */
import { SECRET_NAME_PATTERN } from '@dorkos/shared/global-mcp-schemas';

/** What stands in for a value. */
export const MASK = '•••';

/**
 * A URL inside a string: its scheme, then the rest. A browser and most programs read
 * `http:user:pw@host` as `http://user:pw@host`, so the web's schemes count with no `//` as well.
 */
const URL_IN_TEXT = /([a-z][a-z0-9+.-]*:\/\/|\b(?:https?|wss?|ftp):[\\/]*)(\S*)/gi;

/** Whether a scheme is `file:`, which names a file here and holds no key. */
const isFileScheme = (scheme: string): boolean => /file:\/\/$/i.test(scheme);

/**
 * Any URL inside a string, down to its scheme and host: hosted MCP addresses
 * often carry their key in the path or the query. Everything before the LAST `@`
 * goes, since a password can hold one. A `file:` URL names a file here and holds
 * no key, so a person still sees what runs.
 *
 * @param text - An argument or an address.
 */
export function maskUrls(text: string): string {
  return text.replace(URL_IN_TEXT, (url, scheme: string, rest: string) => {
    if (isFileScheme(scheme)) return url;
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
 * Whether what follows a URL's scheme holds a password or a query. Any `user@` counts, and so does
 * a colon before the last `@`, since a password can hold a `/`. A port doesn't, so a package in a
 * path (`https://host:8080/pkg@1.0`) reads as the plain path it is.
 */
function urlRestHoldsSecret(rest: string): boolean {
  if (/^[^/?#]*@/.test(rest) || /\?./.test(rest)) return true;
  const beforeAt = rest.slice(0, Math.max(rest.lastIndexOf('@'), 0));
  return beforeAt.replace(/^[^/?#:]*:\d+(?=[/?#]|$)/, '').includes(':');
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
 * One argument with the value after a secret name hidden, whichever flag came
 * before it: `Authorization: Bearer x`, `--header=X-Api-Key: x`, `API_KEY=x`.
 * The rest of the argument goes, since a value can hold spaces.
 */
function maskSecretShapes(arg: string): string {
  for (const match of arg.matchAll(/([A-Za-z0-9_.-]+)\s*[:=]\s*/g)) {
    if (SECRET_NAME_PATTERN.test(match[1]!)) {
      return `${arg.slice(0, match.index + match[0].length)}${MASK}`;
    }
  }
  return arg.replace(/\bbearer\s+\S+/gi, (found) => `${found.split(/\s+/)[0]} ${MASK}`);
}

/**
 * Walk the arguments, hiding what follows a secret name or `Bearer`.
 *
 * @param args - The server's arguments.
 * @param hideUrls - What to do with the URLs in an argument.
 */
function hideSecretValues(args: readonly string[], hideUrls: (arg: string) => string): string[] {
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
    // `Bearer` alone hands its value to the next argument, like a flag.
    if (/^bearer$/i.test(arg)) hideNext = true;
    out.push(hideUrls(maskSecretShapes(arg)));
  }
  return out;
}

/**
 * Arguments with secret-named flags' values and URL credentials masked.
 *
 * @param args - The server's arguments.
 */
export function maskedArgs(args: readonly string[]): string[] {
  return hideSecretValues(args, maskUrls);
}

/**
 * Whether arguments look like they hold a secret: a secret name, `Bearer`, or a URL with a password
 * or a query.
 *
 * @param args - The arguments as a person typed them.
 */
export function argsLookSecret(args: readonly string[]): boolean {
  if (hideSecretValues(args, (arg) => arg).some((arg, index) => arg !== args[index])) return true;
  return args.some((arg) =>
    [...arg.matchAll(URL_IN_TEXT)].some(
      ([, scheme, rest]) => !isFileScheme(scheme!) && urlRestHoldsSecret(rest!)
    )
  );
}
