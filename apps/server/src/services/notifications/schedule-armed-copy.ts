/**
 * What a `schedule.armed_by_agent` notification says and offers, kept beside
 * the registry rather than inside it so the registry stays one table.
 *
 * Two events share the kind, both about a schedule one of our agents set
 * running without a person being asked: an agent armed a new schedule (Pause),
 * or an agent changed how a running schedule runs, above Don't ask, on content
 * a person approved (DOR-3703, final rulings: Undo puts the old mode back).
 * Either way nothing waits on the person, so it is `notable` and never a
 * "Needs you" row: it is told so the schedule never runs unseen.
 *
 * @module services/notifications/schedule-armed-copy
 */
import type { NotificationActionDTO } from '@dorkos/shared/notification-schemas';
import type { ScheduleSubject } from './emitters/schedule-subject.js';

/** What a `schedule.armed_by_agent` notification is told. */
export interface ScheduleArmedPayload extends ScheduleSubject {
  /** The session the agent made or changed it from, when there was one. */
  proposedBySessionId?: string;
  /** What to call the agent. */
  armedBy: string;
  /** When it runs, as the end of "Runs …", e.g. `every day at 9:00 AM`. */
  cadence: string;
  /**
   * Set when an agent changed the mode of a running schedule on its own: the
   * modes as a person reads them, who started the turn that did it (M6), and
   * when. Undo puts `from` back.
   */
  modeChange?: { from: string; to: string; at: string; startedBy?: string };
  /**
   * Set when the task's own agent rewrote a running schedule's prompt above
   * Don't ask (DOR-3703, M6): who started the turn that did, when, and the
   * short hashes of the old prompt and the new one. Undo puts the old one back.
   */
  promptChange?: { startedBy: string; at: string; fromHash: string; toHash: string };
  /**
   * Set when a scheduled run, a heartbeat or a chat either started asked for a
   * looser mode and was refused (DOR-3703, MUST-H): nothing changed, so it offers
   * only a look. The modes as a person reads them, and who started the turn.
   */
  refusedRaise?: { from: string; to: string; startedBy: string; at: string };
  /**
   * Set when the task's SKILL file changed outside the task tools (DOR-3703,
   * M4): `capped` when its runs went to Don't ask (one notice per pair of
   * hashes), `lifted` when its own agent accepted the file (Undo caps it
   * again). The short hashes of the attested file and the file now.
   */
  fileChange?: {
    kind: 'capped' | 'lifted';
    fromHash: string;
    toHash: string;
    at: string;
    startedBy?: string;
    /** The capped mode as the runtime's mode picker names it, e.g. `Never ask`. */
    cappedAs?: string;
  };
}

/** The intent behind a mode change's Undo: `POST /api/tasks/:id/undo-agent-mode`. */
export const UNDO_AGENT_MODE_ACTION_ID = 'undo-mode';

/**
 * What a schedule an agent armed offers: stop it, or go and look at it. Pause
 * switches it off through the ordinary task update (`enabled: false`), the same
 * write a person's own switch makes.
 */
const ARMED_SCHEDULE_ACTIONS: NotificationActionDTO[] = [
  { id: 'pause', label: 'Pause', style: 'neutral' },
  { id: 'open', label: 'Open', style: 'primary' },
];

/** What a mode an agent set offers: put the old one back, or go and look. */
const MODE_CHANGE_ACTIONS: NotificationActionDTO[] = [
  { id: UNDO_AGENT_MODE_ACTION_ID, label: 'Undo', style: 'neutral' },
  { id: 'open', label: 'Open', style: 'primary' },
];

/** What a capped file's notice offers: nothing depends on the person, so only a look. */
const FILE_CAPPED_ACTIONS: NotificationActionDTO[] = [
  { id: 'open', label: 'Open', style: 'primary' },
];

/** The title of a file-change notice (M4). */
function fileChangeTitle(
  p: ScheduleArmedPayload,
  change: NonNullable<ScheduleArmedPayload['fileChange']>
) {
  return change.kind === 'capped'
    ? `${p.taskName} runs capped at ${change.cappedAs ?? 'Never ask'}`
    : `${p.armedBy} accepted a changed file for ${p.taskName}`;
}

/** The body of a file-change notice (M4), naming who started a lift's turn (M6). */
function fileChangeBody(change: NonNullable<ScheduleArmedPayload['fileChange']>) {
  const hashes = `(${change.fromHash} → ${change.toHash})`;
  return change.kind === 'capped'
    ? `Its file changed outside the task tools ${hashes}. Some steps may fail.`
    : `The file changed outside the task tools ${hashes}.${change.startedBy ? ` Started by ${change.startedBy}.` : ''}`;
}

/** The kind's wording, actions and dedupe key, spread into its registry entry. */
export const SCHEDULE_ARMED_COPY = {
  title: (p: ScheduleArmedPayload) =>
    p.refusedRaise
      ? `${p.armedBy} asked to set ${p.taskName} to ${p.refusedRaise.to}`
      : p.fileChange
        ? fileChangeTitle(p, p.fileChange)
        : p.promptChange
          ? `${p.armedBy} rewrote ${p.taskName}`
          : p.modeChange
            ? `${p.armedBy} set ${p.taskName} to ${p.modeChange.to}`
            : `${p.armedBy} scheduled ${p.taskName}`,
  // A second line that never contradicts a refused Undo (designer, round 7).
  body: (p: ScheduleArmedPayload) =>
    p.refusedRaise
      ? `Nothing changed. It still runs at ${p.refusedRaise.from}. Started by ${p.refusedRaise.startedBy}.`
      : p.fileChange
        ? fileChangeBody(p.fileChange)
        : p.promptChange
          ? `Prompt changed ${p.promptChange.fromHash} → ${p.promptChange.toHash}. Started by ${p.promptChange.startedBy}.`
          : p.modeChange
            ? `Was ${p.modeChange.from}.${p.modeChange.startedBy ? ` Started by ${p.modeChange.startedBy}.` : ''}`
            : `Runs ${p.cadence}${p.runsAs ? ` as ${p.runsAs}` : ''}. Pause it any time.`,
  actions: (p: ScheduleArmedPayload) =>
    p.fileChange?.kind === 'capped' || p.refusedRaise
      ? FILE_CAPPED_ACTIONS
      : p.modeChange || p.promptChange || p.fileChange
        ? MODE_CHANGE_ACTIONS
        : ARMED_SCHEDULE_ACTIONS,
  // Not `schedule:` — that is the parked condition's key, and dedupe and the
  // escalation ledger are keyed across kinds, so sharing it would let this
  // row swallow a later park of the same schedule. A mode change is keyed by
  // when it happened, so a second change is never folded into the first.
  // A capped file is told once per pair of hashes (M4); a lift by when it happened.
  // A refused raise is told once a day per mode asked: a run asking in a loop is one line.
  dedupeKey: (p: ScheduleArmedPayload) =>
    p.refusedRaise
      ? `schedule-raise-refused:${p.taskId}:${p.refusedRaise.to}:${p.refusedRaise.at.slice(0, 10)}`
      : p.fileChange?.kind === 'capped'
        ? `schedule-file:${p.taskId}:${p.fileChange.fromHash}:${p.fileChange.toHash}`
        : p.fileChange
          ? `schedule-file-lift:${p.taskId}:${p.fileChange.at}`
          : p.promptChange
            ? `schedule-prompt:${p.taskId}:${p.promptChange.at}`
            : p.modeChange
              ? `schedule-mode:${p.taskId}:${p.modeChange.at}`
              : `schedule-armed:${p.taskId}`,
};
