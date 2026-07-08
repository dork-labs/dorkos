/**
 * Terminal feature — the embedded workbench terminal tab (spec
 * right-panel-workbench, Chunk E). Renders an xterm.js terminal attached to a
 * server-side PTY over the Transport byte channel. Web-only; the right-panel
 * contribution gates the tab on `transport.supportsTerminal`.
 *
 * @module features/terminal
 */
export { TerminalPanel } from './ui/TerminalPanel';
