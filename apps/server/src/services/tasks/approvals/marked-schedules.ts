/**
 * Schedules written in a marked turn (DOR-3036, `specs/turn-marks`): a schedule an agent creates or
 * edits while its turn carries a mark (it read a stranger's words, or a teammate in a shared space
 * started the chain) parks for a person, whatever the trust preset.
 *
 * A schedule runs later, unattended, as the agent's own work. Arming one from a marked turn would
 * let words from outside the owner's circle outlive the turn that read them and come back as a
 * turn nobody marked. So the marks are kept on the row (`pulse_schedules.origin_marks`) with the
 * names DorkOS knew when they were written, the approval card shows each one and where it came
 * from, and only a person's approval clears them (`TaskApprovals.recordApproval`).
 *
 * @module services/tasks/approvals/marked-schedules
 */
import { eq } from 'drizzle-orm';
import { pulseSchedules, type Db } from '@dorkos/db';
import type { TeammateOrigin } from '@dorkos/shared/agent-runtime';
import { ScheduleOriginMarksSchema, type ScheduleOriginMarks } from '@dorkos/shared/schemas';
import { hasMarks, type TurnMarks } from '../../core/turn-power/turn-marks.js';

/** The names DorkOS knows for a teammate origin, for the card. */
export interface OriginLabel {
  /** The teammate's name, or null when unknown. */
  name: string | null;
  /** The space room's title, or null when unknown. */
  room: string | null;
}

/**
 * The labeler the server runs: the teammate's display name, and the room's title as a channel is
 * named everywhere else (`#title`). Either is null when unknown.
 *
 * @param lookup - Reads an author's display name and a room's title.
 * @param lookup.authorName - The display name of an author id, or null.
 * @param lookup.roomTitle - The title of a local room id, or null.
 */
export function originLabelerFrom(lookup: {
  authorName: (authorId: string) => string | null | undefined;
  roomTitle: (roomId: string) => string | null | undefined;
}): (origin: TeammateOrigin) => OriginLabel {
  return (origin) => {
    const title = lookup.roomTitle(origin.roomId);
    return {
      name: lookup.authorName(origin.authorId) || null,
      room: title ? `#${title.replace(/^#/, '')}` : null,
    };
  };
}

/** Names a teammate origin; set at startup by the rooms layer, which knows authors and rooms. */
let labelOrigin: (origin: TeammateOrigin) => OriginLabel = () => ({ name: null, room: null });

/**
 * Set how a teammate origin is named on a parked schedule's card.
 *
 * @param next - Reads the teammate's name and the room's title.
 */
export function setOriginLabeler(next: (origin: TeammateOrigin) => OriginLabel): void {
  labelOrigin = next;
}

/**
 * The marks stored on a row, or null when none (or when the stored value cannot be read, which a
 * newer DorkOS could write; the row's status still says whether it waits for a person).
 *
 * @param stored - The `origin_marks` column.
 */
export function parseOriginMarks(stored: string | null | undefined): ScheduleOriginMarks | null {
  if (!stored) return null;
  try {
    const parsed = ScheduleOriginMarksSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Both sets of stored marks together, each teammate origin once. */
function mergeStored(
  before: ScheduleOriginMarks | null,
  added: ScheduleOriginMarks
): ScheduleOriginMarks {
  const teammate = [...(before?.teammate ?? [])];
  for (const origin of added.teammate ?? []) {
    if (!teammate.some((t) => t.roomId === origin.roomId && t.authorId === origin.authorId)) {
      teammate.push(origin);
    }
  }
  return {
    ...(before?.outsider || added.outsider ? { outsider: true as const } : {}),
    ...(before?.wifi || added.wifi ? { wifi: true as const } : {}),
    ...(teammate.length > 0 ? { teammate } : {}),
  };
}

/**
 * Keep a marked turn's marks on a schedule it created or edited, and park it for a person. An
 * unmarked turn changes nothing. Marks already on the row are kept: only an approval clears them.
 *
 * @param db - The database the store writes.
 * @param id - The schedule.
 * @param marks - The marks of the turn that wrote it.
 * @returns Whether the schedule was marked (and so now waits for a person).
 */
export function markScheduleOrigin(db: Db, id: string, marks: TurnMarks): boolean {
  if (!hasMarks(marks)) return false;
  const row = db.select().from(pulseSchedules).where(eq(pulseSchedules.id, id)).get();
  if (!row) return false;
  const added: ScheduleOriginMarks = {
    ...(marks.outsider ? { outsider: true as const } : {}),
    ...(marks.wifi ? { wifi: true as const } : {}),
    ...(marks.teammate !== undefined
      ? { teammate: marks.teammate.map((origin) => ({ ...origin, ...labelOrigin(origin) })) }
      : {}),
  };
  db.update(pulseSchedules)
    .set({
      originMarks: JSON.stringify(mergeStored(parseOriginMarks(row.originMarks), added)),
      status: 'pending_approval',
      approvedContentKey: null,
      // What was approved, so the card can say what changed.
      previousApprovalKey: row.approvedContentKey ?? row.previousApprovalKey,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(pulseSchedules.id, id))
    .run();
  return true;
}
