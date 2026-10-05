/**
 * Waking a chat whose agent process was ended while its background work still
 * ran (DOR-2065).
 *
 * ## Why a turn has to be started for it
 *
 * Under the bare Claude Code CLI, a background shell, Monitor or helper agent
 * that finishes after the turn ended wakes the chat with a new turn. Under
 * DorkOS that holds while the warm process lives. When the process is ended
 * anyway — a restart, a hard kill, the four-hour ceiling, an eviction, a crash
 * — the work dies with it and no wake is coming. Relaunching the CLI does not
 * bring one either: it writes its own "didn't finish before the previous
 * session ended" notice into the transcript and answers with zero turns. So
 * DorkOS starts the turn, and the CLI's notice rides it to give the agent the
 * detail.
 *
 * ## The two ways a chat reaches here
 *
 * - **At boot**, from the records `background-work.json` kept for chats whose
 *   process was still holding work when the server went away. The boot takes
 *   and clears them before anything can warm a process, so each wakes once.
 * - **In process**, from the claude-code runtime, when it takes a process back
 *   with work inside it.
 *
 * ## What it deliberately does NOT do
 *
 * A busy chat is not woken: a turn already running carries the CLI's notice
 * anyway, and a queued copy would arrive after it stopped being useful. That
 * is `whenBusy: 'refuse'`, the same shape `mcp-signin-resume.ts` uses for the
 * same reason.
 *
 * Plain message content rather than the `<ui_action>` wrapper the sign-in
 * resume uses: the app renders that wrapper as a widget click, which this is
 * not. Plain words show in the chat as what they are.
 *
 * Lives beside `runtime-turn.ts` because both are turns no person typed, and
 * `services/session/` itself is past `check-dir-size.sh`'s threshold.
 *
 * @module services/session/runtime-turns/wake-cut-short-work
 */
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { logError, logger } from '../../../lib/logger.js';
import { dispatchMessage } from '../message-dispatcher.js';
import { persistenceModeFor } from '../projector-persistence.js';
import { getOrCreateProjector } from '../session-state-projector.js';

/**
 * What the woken agent is told. Agent-facing, and shown in the chat as the
 * message that started the turn, so it is plain and short.
 */
export const CUT_SHORT_WAKE_MESSAGE =
  "DorkOS stopped this chat's agent process while your background work was still " +
  'running, so that work was cut short. Check what you were waiting on and carry on.';

/** A chat owed a wake, and the directory it runs in. */
export interface CutShortChat {
  /** The chat's session id. */
  sessionId: string;
  /** Where the chat runs. */
  cwd: string;
}

/**
 * Wake one chat whose background work was cut short.
 *
 * Never throws and never rejects: it runs detached, from boot or from a
 * runtime's own bookkeeping, so every way it can decline is a log line.
 *
 * @param chat - The chat to wake and where it runs
 */
export async function wakeCutShortChat(chat: CutShortChat): Promise<void> {
  const { sessionId, cwd } = chat;
  try {
    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    // The live session map is empty after a restart and loses the record on
    // an eviction; a stored session cold-starts through the dispatcher, and
    // one that exists nowhere is gone, with nothing left to wake.
    if (!runtime.hasSession(sessionId) && !(await runtime.getSession(cwd, sessionId))) {
      logger.info('[background-work-wake] session is gone — nothing to wake', { sessionId });
      return;
    }
    const projector = getOrCreateProjector(sessionId, cwd, {
      persist: persistenceModeFor(runtime.getCapabilities()),
    });
    projector.cwd = cwd;
    const result = await dispatchMessage({
      sessionId,
      clientId: 'background-work-wake',
      content: CUT_SHORT_WAKE_MESSAGE,
      cwd,
      projector,
      runtime,
      whenBusy: 'refuse',
      onError: (err) => {
        logger.warn('[background-work-wake] detached turn error', {
          sessionId,
          ...logError(err),
        });
      },
    });
    if (!result.accepted) {
      logger.info('[background-work-wake] session busy — its running turn carries the notice', {
        sessionId,
      });
      return;
    }
    logger.info('[background-work-wake] woke a chat whose background work was cut short', {
      sessionId,
    });
  } catch (err) {
    logger.warn('[background-work-wake] could not wake the chat', { sessionId, ...logError(err) });
  }
}

/**
 * Wake every chat in a list, each once, one after another.
 *
 * @param chats - The chats owed a wake, as the boot took them from the record
 */
export async function wakeChatsCutShort(chats: readonly CutShortChat[]): Promise<void> {
  for (const chat of chats) await wakeCutShortChat(chat);
}
