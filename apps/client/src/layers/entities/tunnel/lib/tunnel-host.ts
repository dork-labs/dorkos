/**
 * The address a person reads, taken off the URL a machine dials.
 *
 * @module entities/tunnel/lib/tunnel-host
 */

/**
 * Strip the scheme from a tunnel URL, leaving the host.
 *
 * Every surface that shows the address in passing — the Control Center row's
 * "On · your-box.ngrok.app", the beacon's tooltip — shows the host and not the
 * scheme: `https://` is true of all of them, so it is the half that carries no
 * information and costs the most characters. The full URL still travels intact
 * wherever it is going to be USED (copy, QR code, the dialog).
 *
 * @param url - The public tunnel URL, or `null` when none is known.
 * @returns The host, or `null` when there is no URL.
 */
export function tunnelHost(url: string | null): string | null {
  if (!url) return null;
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
