import type { StreamEvent } from '@dorkos/shared/types';
import type { TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';

/**
 * The live session the in-session tool server is built for, narrowed to what the
 * hand-registered tools and the capability projection actually read.
 *
 * It used to carry the window's UI state and the room this turn was answering
 * in. Both moved off it when the `ui` verbs became capabilities (spec
 * `canvas-agent-seat` §5): a fact that lives on one runtime's session object is
 * a fact the other two runtimes cannot have.
 */
export interface McpToolSession {
  /** The turn's outbound event queue, drained into the session's SSE stream. */
  eventQueue: StreamEvent[];
  /** Wakes the queue drainer after a push. */
  eventQueueNotify?: () => void;
  /**
   * Session working directory. Used to resolve the session's trusted Relay
   * sender identity (see `resolveSenderIdentity`) so relay tools inject a
   * server-derived `from` rather than trusting the LLM, and carried into every
   * capability call as the directory the caller is standing in.
   */
  cwd?: string;
  /**
   * The session's canonical SDK id, seeded to the request id at creation and
   * updated when the SDK init assigns the real id (see `session-store.ts`).
   * Resolved at CALL time by everything that reads it, so a first-turn rekey
   * never strands a call on the stale request UUID.
   */
  sdkSessionId?: string;
  /**
   * The mode the session's turn runs under RIGHT NOW: the live object's field,
   * which a scheduled run, a room turn, a person lowering it and a live PATCH
   * all write. `session_start` reads it as the ceiling of the chats this one may
   * start, so it must be read at CALL time, never copied when the tools are
   * built — a copy would let a chat lowered mid-turn start chats at its old level.
   */
  permissionMode?: string;
  /** The session's model, read at call time beside {@link permissionMode}. */
  model?: string;
  /**
   * The model Auto was confirmed for at the last launch (`AgentSession`'s field
   * of the same name). `permissionMode` can say `'auto'` while the turn runs at
   * `'default'`; this is how a reader tells the two apart. Read at call time.
   */
  autoModeConfirmedFor?: string;
  /**
   * The current turn's ceiling (`AgentSession`'s field of the same name), so a
   * chat held below its own level by a stranger's message starts nothing above
   * that. Read at call time.
   */
  turnPermissionCeiling?: TurnPermissionCeiling;
  /** The agent's level this turn starts from, for a chat that follows its agent up (DOR-3175). */
  turnLevelMode?: string;
  /** The ceiling background work from an earlier ceilinged turn still runs under. */
  backgroundPermissionCeiling?: TurnPermissionCeiling;
}
