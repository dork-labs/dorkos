/**
 * How an app's `api.request` becomes a request to its own server routes
 * (DOR-3293, Security 2026-11-10): the path rule, and the failure an app sees.
 *
 * @module features/extensions/frame/app-request
 */

/** The most of a failed reply's body an app is shown: 64 KB of text. */
export const APP_FAILURE_BODY_MAX = 64 * 1024;

/** Control characters, never part of a path segment. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what this refuses.
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Turn an app's path into the address of its own route, or throw.
 *
 * The host checks and encodes each segment itself: `.` and `:` may appear
 * inside a segment, but a segment that is `.` or `..`, an empty segment, a
 * backslash, a raw `%` and control characters are refused. The result must
 * still sit under `/ext/<id>/` once a browser resolves it.
 *
 * @param id - The app's own id, from DorkOS's records.
 * @param path - What the app asked for, e.g. `/reports/q3.v2:final?limit=5`.
 * @returns The address under `/ext/<id>/`, query re-encoded.
 * @throws When the path is not one plainly inside the app.
 */
export function extensionRequestPath(id: string, path: string): string {
  const refuse = (): never => {
    throw new Error('Use a path inside this app.');
  };
  if (path.length > 4000 || !path.startsWith('/') || path.includes('#') || path.includes('\\')) {
    refuse();
  }
  const query = path.indexOf('?');
  const pathname = query === -1 ? path : path.slice(0, query);
  if (pathname.includes('%')) refuse();
  const segments = pathname.slice(1).split('/');
  segments.forEach((segment, index) => {
    // Only the last segment may be empty: a trailing slash, never `//`.
    if (segment === '' && index !== segments.length - 1) refuse();
    if (segment === '.' || segment === '..' || CONTROL.test(segment)) refuse();
  });
  const prefix = `/ext/${encodeURIComponent(id)}/`;
  const address = prefix + segments.map(encodeURIComponent).join('/');
  // Resolve it the way a browser would, and make sure it never left the app.
  if (!new URL(address, 'http://dorkos.invalid').pathname.startsWith(prefix)) refuse();
  const search = query === -1 ? '' : new URLSearchParams(path.slice(query + 1)).toString();
  return search ? `${address}?${search}` : address;
}

/**
 * A request an app made that its server answered with an error. The frame's
 * `api.request` rejects with this status and body; no reply headers cross.
 */
export class AppRequestFailure extends Error {
  /**
   * Record what the app's route answered.
   *
   * @param status - The HTTP status the app's route answered with.
   * @param body - Its body: parsed JSON, or text (at most {@link APP_FAILURE_BODY_MAX}).
   */
  constructor(
    readonly status: number,
    readonly body: unknown
  ) {
    super(`The app request failed (${status}).`);
    this.name = 'AppRequestFailure';
  }
}

/**
 * Read a reply for the app: its JSON or text on success, or an
 * {@link AppRequestFailure} carrying only the status and body.
 *
 * @param response - The reply from the app's own route.
 */
export async function readAppResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!response.ok) {
    // A body past the cap is cut as text, never handed over whole.
    const body =
      text.length > APP_FAILURE_BODY_MAX
        ? text.slice(0, APP_FAILURE_BODY_MAX)
        : parseJsonOrText(text);
    throw new AppRequestFailure(response.status, body);
  }
  return parseJsonOrText(text);
}

/** JSON when the text parses as JSON, else the text itself; empty text is `null`. */
function parseJsonOrText(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
