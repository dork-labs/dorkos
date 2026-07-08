/**
 * Embedded-terminal service — PTY lifecycle plus its WebSocket byte channel
 * (spec right-panel-workbench, Chunk E; ADR 260708-185521). The `node-pty`
 * import is ESLint-confined to this directory.
 *
 * @module services/terminal
 */
export { TerminalManager, TerminalLimitError } from './terminal-manager.js';
export type { PtyLike, SpawnPty, SpawnPtyOptions, TerminalSink } from './terminal-manager.js';
export {
  attachTerminalWebSocket,
  authorizeTerminalUpgrade,
  bindTerminalSocket,
} from './terminal-websocket.js';
export type { TerminalUpgradeDecision } from './terminal-websocket.js';
