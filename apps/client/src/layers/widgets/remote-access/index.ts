/**
 * Remote-access chrome — the beacon in the top bar and what it opens.
 *
 * The one thing this widget adds to the app's permanent furniture is a globe
 * that is only there while a tunnel is (DOR-1743). Its state comes from
 * `entities/tunnel`, shared with the Control Center's Remote-access row and the
 * Remote Access dialog, so all three agree without any of them asking the
 * others.
 *
 * @module widgets/remote-access
 */
export { RemoteAccessBeacon } from './ui/RemoteAccessBeacon';
export { RemoteAccessPanel } from './ui/RemoteAccessPanel';
export type { RemoteAccessPanelProps } from './ui/RemoteAccessPanel';
export { useConnectRipple } from './model/use-connect-ripple';
