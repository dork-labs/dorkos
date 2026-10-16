/**
 * Read a setting that must be a bare web origin: HTTPS, or HTTP on this machine, with no
 * credentials, path, query or fragment.
 *
 * @param name - The setting's name, as its error messages say it.
 * @param raw - The setting's value, already checked to be a URL.
 * @returns The parsed address.
 */
export function parseOrigin(name: string, raw: string): URL {
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
  )
    throw new Error(`${name} must use HTTPS, or HTTP on localhost`);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error(`${name} must be a bare origin without credentials, path, query or fragment`);
  return url;
}

/**
 * Read `COMMUNITY_USER_CONTENT_URL` (DOR-2957): the separate address files are downloaded from,
 * so a file never opens on the space's own address, where its page's sign-in lives. Unset, files
 * download from the space's own address, with the same headers.
 *
 * It must be another host than the space's, and not one under it: the space's cookies are
 * host-only, and a file's address must not even look like the space's. It should be a registrable
 * domain of its own (on the Public Suffix List when it serves several spaces); that is the
 * operator's to arrange, since this server cannot check it.
 *
 * @param raw - The setting's value, if set.
 * @param publicUrl - The space's own address, already parsed.
 * @returns The origin, or `null` when unset.
 */
export function parseUserContentUrl(raw: string | undefined, publicUrl: URL): string | null {
  if (raw === undefined) return null;
  const url = parseOrigin('COMMUNITY_USER_CONTENT_URL', raw);
  if (url.hostname === publicUrl.hostname || url.hostname.endsWith(`.${publicUrl.hostname}`))
    throw new Error(
      'COMMUNITY_USER_CONTENT_URL must be another host than COMMUNITY_PUBLIC_URL, and not under it'
    );
  return url.origin;
}
