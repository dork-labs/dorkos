/**
 * Control Center widget — the one always-present place to see and change the
 * fleet's power posture at a glance (spec `full-power-defaults`, D7): the global
 * Trust Dial, the power switches, an overrides ledger with deep links, and an
 * unattended-status line.
 *
 * Opened from a persistent ⚡ glyph, a command-palette entry, a keyboard
 * shortcut, and the full-power consent door — all through the `controlCenterOpen`
 * flag in the app store. Mounted once by the app shell.
 *
 * @module widgets/control-center
 */
export { ControlCenter } from './ui/ControlCenter';
export { ControlCenterBody } from './ui/ControlCenterBody';
// The Remote-access row on its own, for the Dev Playground's state gallery —
// the panel only ever shows the one state a running server happens to be in.
export { RemoteAccessRow } from './ui/RemoteAccessRow';
export { useControlCenterShortcut } from './model/use-control-center-shortcut';
export { useOverridesLedger } from './model/use-overrides-ledger';
export type { OverrideKind, OverrideRow, OverridesLedger } from './model/use-overrides-ledger';
