/**
 * Embedded-terminal wire schemas — the DTOs for the PTY lifecycle REST routes
 * and the bidirectional WebSocket byte channel (spec right-panel-workbench,
 * Chunk E; ADR 260708-185521).
 *
 * The terminal is a first-party, web-only surface: a `node-pty` process spawned
 * on the server in a boundary-confined working directory, its raw byte stream
 * carried to `@xterm/xterm` over a dedicated WebSocket. These schemas define the
 * REST create/teardown contract and the small control-message grammar the
 * client sends up the socket. Server → client frames are raw binary PTY output
 * and are intentionally not schema-wrapped (they are opaque bytes).
 *
 * @module shared/terminal-schemas
 */
import { z } from 'zod';

/**
 * WebSocket close code the terminal server uses when a NEW attachment supersedes
 * an existing one for the same PTY — a takeover. The classic trigger is a
 * duplicated browser tab: `sessionStorage` (and its terminal ids) is copied into
 * the dupe, which re-attaches to the same ids and the server replaces each
 * original socket. It is an application close code (RFC 6455 reserves 4000-4999
 * for application use, so it never collides with a protocol code). The client
 * reads it to tell "your socket was replaced elsewhere" apart from "the shell
 * exited": a takeover keeps the tab (with a moved-elsewhere notice) and leaves
 * the stored ids untouched, where an exit prunes the tab and clears its id.
 */
export const TERMINAL_CLOSE_SUPERSEDED = 4001;

/** WebSocket close reason paired with {@link TERMINAL_CLOSE_SUPERSEDED}. */
export const TERMINAL_CLOSE_SUPERSEDED_REASON = 'superseded';

/**
 * Terminal viewport dimensions in character cells. Bounded to sane values so a
 * malformed resize can never ask the PTY for a pathological grid.
 */
export const TerminalSizeSchema = z.object({
  /** Column count (character cells wide). */
  cols: z.number().int().min(1).max(1000),
  /** Row count (character cells tall). */
  rows: z.number().int().min(1).max(1000),
});
/** Terminal viewport dimensions in character cells. */
export type TerminalSize = z.infer<typeof TerminalSizeSchema>;

/**
 * `POST /api/terminal` request — create a PTY in `cwd` (boundary-confined) with
 * an optional initial viewport. The shell is the server's default login shell.
 */
export const CreateTerminalRequestSchema = z.object({
  /** Working directory to spawn the shell in; validated against the boundary. */
  cwd: z.string().min(1),
  /** Optional initial viewport; the client resizes again once xterm has fit. */
  size: TerminalSizeSchema.optional(),
});
/** `POST /api/terminal` request body. */
export type CreateTerminalRequest = z.infer<typeof CreateTerminalRequestSchema>;

/** `POST /api/terminal` response — the id used to attach the socket and tear down. */
export const CreateTerminalResponseSchema = z.object({
  /** Server-assigned terminal-session id. */
  id: z.string(),
});
/** `POST /api/terminal` response body. */
export type CreateTerminalResponse = z.infer<typeof CreateTerminalResponseSchema>;

/**
 * A control message the client sends up the terminal WebSocket. Keystrokes and
 * paste flow as `input`; viewport changes as `resize`. Output travels the other
 * way as raw binary frames, never wrapped in this envelope.
 */
export const TerminalClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    /** User input (keystrokes / paste) to write to the PTY stdin. */
    type: z.literal('input'),
    /** UTF-8 input data. */
    data: z.string(),
  }),
  z.object({
    /** Viewport resize forwarded to the PTY as a `TIOCSWINSZ`. */
    type: z.literal('resize'),
    /** New column count. */
    cols: z.number().int().min(1).max(1000),
    /** New row count. */
    rows: z.number().int().min(1).max(1000),
  }),
]);
/** A control message sent from the client up the terminal WebSocket. */
export type TerminalClientMessage = z.infer<typeof TerminalClientMessageSchema>;
