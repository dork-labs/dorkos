/**
 * tunnel-gate feature — passcode-based access gate for remote tunnel connections.
 *
 * Provides `PasscodeGate` (full-screen entry UI) and `PasscodeGateWrapper`
 * (session-aware orchestrator). Wrap the app root with `PasscodeGateWrapper`
 * to enforce passcode protection on non-localhost tunnel URLs.
 *
 * @module features/tunnel-gate
 */
export { PasscodeGate } from './ui/PasscodeGate.js';
export { PasscodeGateWrapper } from './ui/PasscodeGateWrapper.js';
