/**
 * Tunnel entity — the one shared account of remote access.
 *
 * Remote access is reachable from three places now (DOR-1743): the Remote
 * Access dialog, the Control Center's top row, and the beacon in the top bar.
 * They all read {@link useRemoteAccess} and act through
 * {@link useRemoteAccessActions}, so a tunnel started in one is on in all three
 * before the request settles, and no surface can hold an opinion of its own
 * about what is running.
 *
 * Two hooks here are mounted exactly ONCE, by the app shell:
 * {@link useTunnelSync} (keeps the config read fresh from other tabs and the
 * server's event stream) and {@link useRemoteAccessAnnouncer} (says something
 * when the tunnel changes without you).
 *
 * @module entities/tunnel
 */
export { tunnelHost } from './lib/tunnel-host';
export { friendlyErrorMessage } from './lib/tunnel-failure';
export { readTunnelReport } from './model/tunnel-report';
export type { TunnelReport, ReportedStatus } from './model/tunnel-report';
export { useRemoteAccessStore, resetRemoteAccessStore } from './model/remote-access-store';
export type { TunnelState, RemoteAccessState } from './model/remote-access-store';
export { useRemoteAccess, useRemoteAccessSnapshot } from './model/use-remote-access';
export type { RemoteAccess, RemoteAccessSnapshot } from './model/use-remote-access';
export { useRemoteAccessActions } from './model/use-remote-access-actions';
export type { RemoteAccessActionHandlers } from './model/use-remote-access-actions';
export { useRemoteAccessAnnouncer } from './model/use-remote-access-announcer';
export { useTunnelSync, broadcastTunnelChange } from './model/use-tunnel-sync';
export { TunnelQrCode } from './ui/TunnelQrCode';
export type { TunnelQrCodeProps } from './ui/TunnelQrCode';
