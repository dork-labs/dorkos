/**
 * Runtime connect feature — the terminal-free, in-app connect flows (ADR-0318,
 * effortless-runtime-switching T1). Codex + Claude paste-key / delegated login,
 * and the OpenCode power-source picker (cloud / on your computer / your own key).
 *
 * The public entry point is {@link renderRuntimeConnect}: a
 * {@link RuntimeConnectSlot} that a feature-layer consumer passes to the entity
 * `RuntimeSetupDialog`'s `renderConnect` prop, wiring these flows into the T0
 * Ready/Connect shell (one entry point per runtime's existing Connect CTA).
 *
 * @module features/runtime-connect
 */
export { RuntimeConnectFlow, renderRuntimeConnect } from './ui/RuntimeConnectFlow';
export { LoginConnect } from './ui/LoginConnect';
export { OpenCodeProviderPicker } from './ui/OpenCodeProviderPicker';
