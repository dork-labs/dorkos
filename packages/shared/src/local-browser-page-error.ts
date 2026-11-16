/**
 * Why a page in the Agent browser didn't load, sorted from Chromium's fixed `ERR_…` codes into
 * the few causes a person can act on (DOR-4430, spec DOR-4420 §8). The app draws one block per
 * cause in the page area; an agent's tool result gets the same title as a sentence. Both read
 * the host from the browser's own record of the request, never from text an agent wrote.
 *
 * @module shared/local-browser-page-error
 */

/** A cause of a failed page load that DorkOS draws itself. */
export type PageErrorKind =
  | 'name-not-found'
  | 'no-response'
  | 'offline'
  | 'certificate'
  | 'blocked-by-dorkos'
  | 'blocked-by-policy'
  | 'too-many-redirects'
  | 'crashed';

const BY_CODE: Record<string, PageErrorKind> = {
  ERR_NAME_NOT_RESOLVED: 'name-not-found',
  ERR_NAME_RESOLUTION_FAILED: 'name-not-found',
  ERR_INTERNET_DISCONNECTED: 'offline',
  ERR_BLOCKED_BY_CLIENT: 'blocked-by-dorkos',
  ERR_BLOCKED_BY_ADMINISTRATOR: 'blocked-by-policy',
  ERR_NETWORK_ACCESS_DENIED: 'blocked-by-policy',
  ERR_TOO_MANY_REDIRECTS: 'too-many-redirects',
};

/**
 * The cause behind one of Chromium's `ERR_…` codes, or `null` for a load that was only
 * cancelled (`ERR_ABORTED`: a download, a stop, a new navigation), which shows nothing.
 * A code this table doesn't know reads as "didn't respond", the cause a person can retry.
 *
 * @param code - Chromium's fixed code, with or without its `net::` prefix.
 */
export function pageErrorKind(code: string): PageErrorKind | null {
  const bare = code.replace(/^net::/, '');
  if (bare === 'ERR_ABORTED') return null;
  if (Object.hasOwn(BY_CODE, bare)) return BY_CODE[bare];
  if (/^ERR_(CERT_|SSL_)/.test(bare)) return 'certificate';
  return 'no-response';
}

/**
 * The block's title for a cause, as the app shows it. `host` is the failed request's host.
 *
 * @param kind - The cause.
 * @param host - The host the browser tried to reach.
 */
export function pageErrorTitle(kind: PageErrorKind, host: string): string {
  switch (kind) {
    case 'name-not-found':
      return `Can’t find ${host}`;
    case 'no-response':
      return `${host} didn’t respond`;
    case 'offline':
      return 'You’re offline';
    case 'certificate':
      return 'This connection isn’t private';
    case 'blocked-by-dorkos':
      return 'DorkOS doesn’t open this page';
    case 'blocked-by-policy':
      return `${host} is blocked`;
    case 'too-many-redirects':
      return `${host} redirects too many times`;
    case 'crashed':
      return 'This page stopped working';
  }
}
