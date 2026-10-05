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
 * ## Each record wakes at most once — but survives a boot that dies
 *
 * A record more than {@link STALE_BACKGROUND_WORK_MS} old is dropped without a
 * wake: the work it describes is long stale, and it bounds the retries below.
 *
 * A record is removed only once its chat has been settled: woken, refused as
 * busy, found gone, or skipped as not a person's chat. A dispatch that throws
 * leaves it for the next boot. A second wake for the same chat is refused by
 * `whenBusy: 'refuse'` when the first is still running.
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
import type { BackgroundWorkRecord } from '../../runtimes/claude-code/messaging/background-work-ledger.js';
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
  "DorkOS restarted while this chat's background work was still running, so that work " +
  'was stopped. Check what you were waiting on and carry on.';

/**
 * How old a record may be and still wake its chat: one day. A record from a
 * server quit days ago describes work nobody is waiting on any more, and the
 * bound also ends the retries of a record whose wake keeps failing.
 */
export const STALE_BACKGROUND_WORK_MS = 24 * 60 * 60 * 1000;

/** How one wake ended. Every outcome but `failed` settles the record. */
export type WakeOutcome = 'woken' | 'busy' | 'gone' | 'failed';

/** What {@link wakeChatsCutShort} needs beyond the records. */
export interface WakeChatsCutShortOptions {
  /** Remove a settled record, so the next boot does not wake its chat again. */
  release: (record: BackgroundWorkRecord) => void;
  /**
   * The ids, of those asked about, that belong to a room or a scheduled task
   * and so have no person waiting on them. Absent when neither is known.
   */
  drivenElsewhere?: (sessionIds: string[]) => ReadonlySet<string>;
}

/**
 * Wake one chat whose background work a restart stopped.
 *
 * Never throws and never rejects: it runs detached from boot, so every way it
 * can decline is a log line and an outcome.
 *
 * @param chat - The chat to wake and where it runs
 * @returns How it ended
 */
export async function wakeCutShortChat(
  chat: Pick<BackgroundWorkRecord, 'sessionId' | 'cwd'>
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

/**
 * Wake every chat a previous run left a record for, one after another,
 * removing each record once its chat is settled.
 *
 * @param records - The records the boot read
 * @param opts - How to remove a record, and which chats are not a person's
 */
export async function wakeChatsCutShort(
  records: readonly BackgroundWorkRecord[],
  opts: WakeChatsCutShortOptions
): Promise<void> {
  let elsewhere: ReadonlySet<string> = new Set();
  try {
    const ids = [...new Set(records.flatMap((record) => [record.sessionId, record.key]))];
    elsewhere = opts.drivenElsewhere?.(ids) ?? elsewhere;
  } catch (err) {
    // Unknown is treated as a person's chat: a wake a room did not need is
    // cheaper than one a person did need and never got.
    logger.warn('[background-work-wake] could not tell room and task chats apart', logError(err));
  }
  const now = Date.now();
  for (const record of records) {
    if (now - record.since > STALE_BACKGROUND_WORK_MS) {
      logger.info('[background-work-wake] not waking a chat whose record is over a day old', {
        sessionId: record.sessionId,
        since: new Date(record.since).toISOString(),
      });
      opts.release(record);
      continue;
    }
    if (elsewhere.has(record.sessionId) || elsewhere.has(record.key)) {
      logger.info('[background-work-wake] not waking a room or scheduled-task chat', {
        sessionId: record.sessionId,
      });
      opts.release(record);
      continue;
    }
    if ((await wakeCutShortChat(record)) !== 'failed') opts.release(record);
  }
}
