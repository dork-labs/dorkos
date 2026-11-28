/**
 * Waking, after a restart, a chat whose background work the restart stopped
 * (DOR-2065).
 *
 * ## Why a turn has to be started for it
 *
 * Under the bare Claude Code CLI, a background shell, Monitor or helper agent
 * that finishes after the turn ended wakes the chat with a new turn. Under
 * DorkOS that holds while the warm process lives. When the server goes away —
 * a restart, a hard kill — the work dies with the process and no wake is
 * coming. Relaunching the CLI does not bring one either: it writes its own
 * "didn't finish before the previous session ended" notice into the
 * transcript and answers with zero turns. So DorkOS starts the turn, and the
 * CLI's notice rides it to give the agent the detail.
 *
 * ## Only after a restart
 *
 * A process DorkOS takes back while the server runs (the four-hour ceiling, an
 * eviction, a crash) is NOT woken: a shell that never ends would be reaped and
 * woken every four hours for ever, and a crash wake could spend the chat's one
 * automatic relaunch. Those simply clear the record, and the CLI's own notice
 * reaches the agent on its next turn.
 *
 * ## Through the run record
 *
 * Recovery decides which records wake (`services/runs/recovery`, spec
 * `turns-survive-restarts` §7.3): a record over a day old
 * (`RUNS.RESTART_AGE_BOUND_MS`), a room's or a task's chat, or a runtime that
 * does not declare `wakesForLostBackgroundWork` wakes nobody. Each record that
 * wakes is a `lost_work_wake` effect, saved before the worker starts, whose
 * handler calls {@link wakeCutShortChat}. The wake's run carries the effect's
 * `start_key`, so a boot that dies mid-wake never wakes the chat twice, and a
 * record is removed only once its chat has been settled: woken, refused as busy
 * or found gone. A dispatch that throws is tried again.
 *
 * ## What it deliberately does NOT do
 *
 * - A busy chat is not woken: a turn already running carries the CLI's notice
 *   anyway, and a queued copy would arrive after it stopped being useful.
 * - A room's or a scheduled task's chat is not woken: those are driven by
 *   their room or their schedule, not by a person waiting on the work.
 *
 * Plain message content rather than the `<ui_action>` wrapper the sign-in
 * resume uses: the app renders that wrapper as a widget click, which this is
 * not.
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
import { ceilingForContinuation } from '../../core/turn-power/continuation-hold.js';

/**
 * What the woken agent is told. Agent-facing, and shown in the chat as the
 * message that started the turn, so it is plain and short.
 */
export const CUT_SHORT_WAKE_MESSAGE =
  "DorkOS restarted while this chat's background work was still running, so that work " +
  'was stopped. Check what you were waiting on and carry on.';

/** One chat a restart cut short: the id to wake it under and the directory it runs in. */
interface CutShortWork {
  sessionId: string;
  cwd: string;
}

/** How one wake ended. Every outcome but `failed` settles the record. */
export type WakeOutcome = 'woken' | 'busy' | 'gone' | 'failed';

/**
 * Wake one chat whose background work a restart stopped.
 *
 * Never throws and never rejects: it runs detached from boot, so every way it
 * can decline is a log line and an outcome.
 *
 * @param chat - The chat to wake, where it runs, and the key its run is made under
 * @returns How it ended
 */
export async function wakeCutShortChat(
  chat: Pick<CutShortWork, 'sessionId' | 'cwd'> & { startKey?: string }
): Promise<WakeOutcome> {
  const { sessionId, cwd } = chat;
  try {
    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    // The live session map is empty after a restart; a stored session
    // cold-starts through the dispatcher, and one that exists nowhere is gone.
    if (!runtime.hasSession(sessionId) && !(await runtime.getSession(cwd, sessionId))) {
      logger.info('[background-work-wake] session is gone — nothing to wake', { sessionId });
      return 'gone';
    }
    const projector = getOrCreateProjector(sessionId, cwd, {
      persist: persistenceModeFor(runtime.getCapabilities()),
    });
    projector.cwd = cwd;
    const result = await dispatchMessage({
      turnStarter: 'agent',
      // Nobody asked: DorkOS carries the bound chat on after a restart.
      origin: { kind: 'resume' },
      sessionId,
      clientId: 'background-work-wake',
      content: CUT_SHORT_WAKE_MESSAGE,
      cwd,
      projector,
      runtime,
      whenBusy: 'refuse',
      ...(chat.startKey !== undefined ? { startKey: chat.startKey } : {}),
      // Held when the chat's latest turn was, as every turn nobody asked for is (DOR-3037).
      ...ceilingForContinuation(sessionId),
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
      return 'busy';
    }
    logger.info('[background-work-wake] woke a chat whose background work a restart stopped', {
      sessionId,
    });
    return 'woken';
  } catch (err) {
    logger.warn('[background-work-wake] could not wake the chat; trying again next boot', {
      sessionId,
      ...logError(err),
    });
    return 'failed';
  }
}
