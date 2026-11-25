/**
 * How long Stop waits for a runtime to say the turn has stopped, on every
 * runtime.
 *
 * @module services/runtimes/shared/timing/stop-ack
 */

/**
 * How long a Stop may go unanswered before the runtime gives up waiting and
 * answers honestly (DOR-3606).
 *
 * One number for every runtime, because the constraint is the person, not the
 * backend: a Stop that visibly does nothing for longer than this reads as
 * broken, and pressing it again is the natural response. A healthy backend
 * acknowledges a stop in milliseconds, so this is budget for a stuck one.
 *
 * What each runtime does when it runs out differs, and that stays theirs:
 * Claude Code closes the CLI process behind the turn
 * (`claude-code/sessions/bounded-control.ts`), OpenCode answers that the stop
 * was not acknowledged (`opencode/runtime-constants.ts`), and Codex and Doe
 * report the stop unconfirmed. Doe once waited only one second, so a Stop that
 * was about to land there read as a failure.
 */
export const RUNTIME_STOP_ACK_TIMEOUT_MS = 3_000;
