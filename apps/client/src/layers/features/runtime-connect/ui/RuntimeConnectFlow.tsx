/**
 * Connect-flow dispatcher (ADR-0318, T1 tasks 2.4/2.5/2.8).
 *
 * Maps a runtime's server `connect.kind` to its terminal-free flow, and adapts
 * it to the entity's {@link RuntimeConnectSlot} so the existing T0 Ready/Connect
 * shell drives every runtime through one entry point:
 * - `login` -> {@link LoginConnect} (Codex + Claude paste-key / delegated login)
 * - `provider-picker` -> {@link OpenCodeProviderPicker} (Local / Gateway / Direct)
 *
 * The `install` kind never reaches here — the entity handles OpenCode's
 * one-click provisioning inline (ADR-0317).
 *
 * @module features/runtime-connect/ui/RuntimeConnectFlow
 */
import type { RuntimeConnectSlot, RuntimeConnectSlotProps } from '@/layers/entities/runtime';
import { LoginConnect } from './LoginConnect';
import { OpenCodeProviderPicker } from './OpenCodeProviderPicker';

/** Render the terminal-free connect flow for a not-ready runtime. */
export function RuntimeConnectFlow({
  type,
  connect,
  currentProvider,
  onConnected,
}: RuntimeConnectSlotProps) {
  if (connect.kind === 'provider-picker') {
    return <OpenCodeProviderPicker currentProvider={currentProvider} onConnected={onConnected} />;
  }
  if (connect.kind === 'login') {
    return <LoginConnect type={type} onConnected={onConnected} />;
  }
  return null;
}

/**
 * The {@link RuntimeConnectSlot} implementation injected into the entity
 * `RuntimeSetupDialog` / `RuntimeSetupPanel`. Passing this from a feature-layer
 * consumer wires the native connect flows into the T0 shell without the entity
 * ever importing a feature.
 */
export const renderRuntimeConnect: RuntimeConnectSlot = (props) => (
  <RuntimeConnectFlow {...props} />
);
