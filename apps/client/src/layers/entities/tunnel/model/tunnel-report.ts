/**
 * What the server says about the remote-access tunnel, read into the three
 * states every surface distinguishes.
 *
 * Pure types and one function — no React, no side effects. Lifted out of
 * `features/settings/model/tunnel-view-state.ts` when remote access grew
 * surfaces outside its dialog (DOR-1743): the Control Center row and the
 * top-bar beacon read the same report, and a derivation that lives inside one
 * feature cannot be reached by anything else.
 *
 * @module entities/tunnel/model/tunnel-report
 */

import type { ServerConfig } from '@dorkos/shared/types';

/**
 * The `tunnel` block of `GET /api/config`.
 *
 * `isRunning` is part of it now (DOR-1738), so this is a plain alias rather
 * than the hand-widened type it replaced — the field answers "is the listener
 * still open", which is a different question from `connected` ("is it reachable
 * right now"). While ngrok re-establishes a dropped session the first is true
 * and the second is false.
 */
export type TunnelReport = NonNullable<ServerConfig['tunnel']>;

/** The three states the server's report can put the tunnel in. */
export type ReportedStatus = 'on' | 'reconnecting' | 'off';

/**
 * Read the server's tunnel block into the three states every surface
 * distinguishes.
 *
 * `reconnecting` needs `isRunning` to be present AND true, so a server that has
 * not shipped the field cannot produce it and every reading against one is
 * exactly what it was before. That is a property of `undefined` being falsy
 * rather than of any fallback written here — an earlier version spelled the
 * default `?? connected`, which reads like it is doing that work but cannot,
 * since `running` is only consulted on the branch where `connected` is already
 * false.
 *
 * @param tunnel - The `tunnel` block of `GET /api/config`, or `undefined` while
 *   the config read is still in flight.
 */
export function readTunnelReport(tunnel: TunnelReport | undefined): {
  status: ReportedStatus;
  url: string | null;
} {
  const connected = tunnel?.connected ?? false;
  const running = tunnel?.isRunning ?? false;
  return {
    status: connected ? 'on' : running ? 'reconnecting' : 'off',
    url: tunnel?.url ?? null,
  };
}
