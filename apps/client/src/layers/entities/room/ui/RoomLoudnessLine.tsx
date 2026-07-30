/**
 * What a whole room will do, in one line at the top of its sheet.
 *
 * @module entities/room/ui/RoomLoudnessLine
 */
import type { RoomKind, RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { cn } from '@/layers/shared/lib';
import { roomLoudness } from '../lib/loudness';
import { LoudnessMeter } from './LoudnessMeter';

export interface RoomLoudnessLineProps {
  /** The room's roster. People are filtered out inside — see {@link roomLoudness}. */
  members: readonly RoomRosterEntry[];
  /** The room the roster lives in; two stored values change meaning with it. */
  roomKind: RoomKind;
  className?: string;
}

/**
 * The room's own loudness, as a meter and a sentence.
 *
 * The two questions people open this sheet with are about the ROOM — *this is
 * too loud* and *nobody answered me* — and every other loudness statement in the
 * cockpit is about one agent. Answering the room's question by making somebody
 * read N grey sentences and compare them is work the roster already has all the
 * information to do.
 *
 * The meter is the same mark a member's pill wears, at the size that stands for
 * a whole roster, which is what lets a reader see one cause the other.
 *
 * **It must not be drawn over a roster that has not arrived.** An empty list is
 * a real answer here — "There is nobody here to answer you" — so rendering this
 * during the read would state something false about the room and then correct
 * itself. Whatever holds it decides when there is a roster to describe.
 */
export function RoomLoudnessLine({ members, roomKind, className }: RoomLoudnessLineProps) {
  const loudness = roomLoudness(members, roomKind);

  return (
    <div
      data-slot="room-loudness-line"
      className={cn('bg-muted/50 flex items-center gap-3 rounded-lg px-3 py-2.5', className)}
    >
      <LoudnessMeter level={loudness.level} size="room" />
      <div className="min-w-0 flex-1">
        <p className="text-sm">{loudness.sentence}</p>
        {loudness.detail !== null && (
          <p className="text-muted-foreground text-xs">{loudness.detail}</p>
        )}
      </div>
    </div>
  );
}
