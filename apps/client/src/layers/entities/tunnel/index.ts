/**
 * Tunnel entity — cross-tab/device sync for the remote-access tunnel.
 *
 * The polled `useTunnelStatus` reading went with the sidebar footer's globe when
 * the footer became one strip (BC-47). Remote access is reached through
 * Settings now, and `TunnelDialog` reads its own machine — so nothing polls a
 * status nobody draws.
 *
 * @module entities/tunnel
 */
export { useTunnelSync, broadcastTunnelChange } from './model/use-tunnel-sync';
