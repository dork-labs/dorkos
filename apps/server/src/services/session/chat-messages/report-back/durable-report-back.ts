/** Durable report production and final delivery effects, distinct from public handoff admission. */
import { logger, logError } from '../../../../lib/logger.js';
import { chatReadOutsideWords } from '../../../core/turn-power/chat-outside-words.js';
import type { TurnMarks } from '../../../core/turn-power/turn-marks.js';
import type {
  SavedReport,
  ReportOutboxRow,
} from '../../../rooms/handoff/outbox/report-outbox-store.js';
import type {
  ChatReportBackDeps,
  ReportReason,
  ReportTarget,
  TurnWindow,
} from '../chat-report-back.js';
import { cutReportDetail } from './report-words.js';

/** Journal transitions and effects owned by one report producer lifetime. */
export class DurableReportBack {
  private readonly unsavedSources = new Set<string>();
  /** Failed captures use conservative word evidence on the legacy live-delivery path. */
  fallbackOutsideWords(): boolean {
    return this.deps.outbox !== undefined;
  }
  constructor(
    private readonly deps: ChatReportBackDeps,
    private readonly now: () => number,
    private readonly later: (ms: number, run: () => void) => void,
    private readonly delay: (ms: number) => Promise<void>,
    private readonly isStopped: () => boolean,
    private readonly summary: Record<ReportReason, string>,
    private readonly retrySteps: readonly number[],
    private readonly recheckMs: number
  ) {}
  /** Retry the durable terminal cursor when a notification write failed. */
  async flushNotices(): Promise<void> {
    const journal = this.deps.outbox?.reports;
    if (!journal || !this.deps.onUndelivered || this.isStopped()) return;
    journal.pruneSettled(this.now());
    for (const row of journal.notices()) {
      try {
        let reason: ReportReason = 'failed';
        try {
          reason = journal.decode(row).reason;
        } catch {
          /* Corrupt policy is never replayed. */
        }
        await this.deps.onUndelivered({
          sessionId: row.sourceSessionId,
          parentSessionId: row.parentSessionId,
          reason,
          onStored: (tx) => {
            journal.acceptNoticeWithin(tx, row.id);
          },
          reportId: row.id,
          at: new Date(row.settledAt ?? row.enqueuedAt).toISOString(),
          deliveryUnknown: row.state === 'interrupted',
        });
        if (this.isStopped()) return;
        journal.acceptNotice(row.id);
      } catch (error) {
        logger.warn('[chat report-back] terminal notice remains durable', {
          reportId: row.id,
          ...logError(error),
        });
        this.later(this.recheckMs, () => {
          void this.flushNotices();
        });
        break;
      }
    }
  }

  save(
    sessionId: string,
    target: ReportTarget,
    reason: ReportReason,
    marks: TurnMarks,
    window: TurnWindow,
    kind: SavedReport['kind'],
    detail?: string,
    key = `${kind}:${reason}:${window.to ?? this.now()}`
  ): ReportOutboxRow | undefined {
    try {
      const row = this.deps.outbox?.reports.create(
        sessionId,
        target.parentSessionId,
        {
          kind,
          reason,
          window,
          marks,
          // Saved already cut: a runtime's error can be any length (DOR-3535).
          detail: detail === undefined ? undefined : cutReportDetail(detail),
          outsideWords: chatReadOutsideWords(sessionId) || this.unsavedSources.has(sessionId),
          since: this.now(),
        },
        key
      );
      if (row) this.unsavedSources.delete(sessionId);
      return row;
    } catch (error) {
      // A storage failure must not prevent the existing live delivery. Its carry stays restrictive.
      this.unsavedSources.add(sessionId);
      logger.warn('[chat report-back] could not save report; using live delivery', {
        sessionId,
        ...logError(error),
      });
      const notice = {
        sessionId,
        parentSessionId: target.parentSessionId,
        reason,
        recoveryUnavailable: true,
        at: new Date(this.now()).toISOString(),
      };
      const notify = async () => {
        if (this.isStopped()) return;
        try {
          await this.deps.onUndelivered?.(notice);
        } catch (noticeError) {
          logger.warn('[chat report-back] could not store recovery notice', {
            sessionId,
            ...logError(noticeError),
          });
          this.later(this.recheckMs, () => {
            void notify();
          });
        }
      };
      void notify();
      return undefined;
    }
  }

  /** A ready seat report stays replayable while busy; an effect claim is never replayed. */
  async deliverSaved(row: ReportOutboxRow, saved: SavedReport, parent: string): Promise<void> {
    const journal = this.deps.outbox!.reports;
    try {
      // The seat it was saved for may be gone by now: then it goes to the chat (DOR-3753).
      const released = journal.releaseGoneSeat(row);
      if (released) [row, saved] = [journal.get(row.id) ?? row, released];
      if (!journal.valid(row)) throw new Error('The saved report scope changed.');
      const agentPath = await this.deps.agentPathOf(row.sourceSessionId);
      if (this.isStopped()) return;
      if (saved.source === null || agentPath !== saved.source.agentPath)
        throw new Error('The report source changed.');
      parent = this.deps.reportTargetOf(row.sourceSessionId)?.parentSessionId ?? parent;
      const toSeat = this.deps.toRoomSeat;
      // A runtime busy reply retries under this live worker, like a public handoff. The claim
      // happens once; the row stays running, never replayable, since a launch may have begun.
      let claimed = false;
      const taken =
        toSeat &&
        (await toSeat(parent, {
          fromSessionId: row.sourceSessionId,
          fromAgentPath: agentPath,
          text: saved.message!,
          marks: saved.marks,
          outsideWords: saved.outsideWords,
          waitDeadlineAt: row.waitDeadlineAt ?? undefined,
          ...(saved.seat && saved.seat !== 'unavailable'
            ? { seat: { roomId: saved.seat.roomId, authorId: saved.seat.authorId } }
            : {}),
          beforeRun: () => {
            if (this.isStopped() || saved.seat === null) return false;
            claimed = claimed
              ? journal.holdsRunning(row.id)
              : journal.claim(row.id, this.now(), 'running');
            return claimed;
          },
        }));
      if (this.isStopped()) return;
      if (!taken) {
        if (saved.seat !== null) throw new Error('The original room seat is unavailable.');
        if (!journal.claim(row.id, this.now(), 'dispatching')) {
          await this.flushNotices();
          return;
        }
        await this.deps.service.send(
          {
            sessionId: row.sourceSessionId,
            agentPath,
            marksAtTurnEnd: saved.marks,
            outsideWordsAtTurnEnd: saved.outsideWords,
          },
          { to: parent, message: saved.message!, summary: this.summary[saved.reason] },
          'report'
        );
      }
      if (!this.isStopped()) journal.finish(row.id, 'delivered', this.now());
    } catch (error) {
      if (this.isStopped()) return;
      const current = journal.get(row.id);
      const state = current?.state;
      // The agent left while the report waited on its busy seat: the old chat takes it now.
      const released = current && state === 'ready' ? journal.releaseGoneSeat(current) : null;
      if (released) return this.deliverSaved(journal.get(row.id)!, released, parent);
      const wait = this.retrySteps[saved.attempt];
      if (
        current &&
        state === 'ready' &&
        wait !== undefined &&
        journal.valid(current) &&
        (current.waitDeadlineAt === null || this.now() + wait < current.waitDeadlineAt)
      ) {
        const retry = { ...saved, attempt: saved.attempt + 1, retryAt: this.now() + wait };
        if (!journal.update(row.id, 'ready', retry)) return;
        await this.delay(wait);
        if (!this.isStopped()) await this.deliverSaved(journal.get(row.id)!, retry, parent);
        return;
      }
      journal.finish(
        row.id,
        state === 'running' || state === 'dispatching' ? 'interrupted' : 'declined',
        this.now(),
        error instanceof Error ? error.message : 'Report delivery failed.'
      );
    }
    await this.flushNotices();
  }
}
