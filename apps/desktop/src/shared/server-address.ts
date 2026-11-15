import { localDialHost } from '@dorkos/shared/local-dial-host';

/**
 * Where the shell's own server lives: the host it binds, and the origin
 * everything in the main process dials it on.
 *
 * The shell spawns the server with `DORKOS_HOST` pinned to
 * {@link SERVER_BIND_HOST} (see `server-spawn.ts`), so this module states a
 * fact rather than guessing at one. Every main-process caller dials through
 * {@link serverOrigin} instead of spelling a loopback address out, because the
 * two drift: the server binds `localhost`, which on macOS is routinely `::1`
 * alone, and a hard-coded `127.0.0.1` is then refused forever. That is how the
 * tray count and desktop notifications stopped without a word (DOR-4294).
 * `scripts/__tests__/loopback-dial-boundary.test.ts` keeps it from coming back.
 *
 * @module shared/server-address
 */

/**
 * The host the shell's server listens on.
 *
 * `localhost` rather than a literal address: it is the window's origin too
 * (`http://localhost:<port>`), and a changed origin would orphan everything the
 * renderer stored under it. Node and Chromium both try every address the name
 * resolves to, so dialing it reaches the server whichever family it bound.
 */
export const SERVER_BIND_HOST = 'localhost';

/**
 * The origin a main-process caller dials to reach the shell's server.
 *
 * @param port - The port the server is listening on.
 * @returns `http://<host>:<port>`, with the host from `localDialHost`, the rule
 *   the server uses for its own loopback URLs.
 */
export function serverOrigin(port: number): string {
  return `http://${serverDialHost()}:${port}`;
}

/**
 * The host a main-process caller dials to reach the shell's server.
 *
 * @returns The dialable form of {@link SERVER_BIND_HOST}.
 */
export function serverDialHost(): string {
  return localDialHost(SERVER_BIND_HOST);
}
