/**
 * What a whole room will do, in one line at the top of its sheet.
 *
 * @module entities/room/ui/RoomLoudnessLine
 */
import type { RoomKind, RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { cn } from '@/layers/shared/lib';
import { previewLoudness, roomLoudness, type LoudnessPreview } from '../lib/loudness';
import { LoudnessMeter } from './LoudnessMeter';

export interface RoomLoudnessLineProps {
  /** The room's roster. People are filtered out inside — see {@link roomLoudness}. */
  members: readonly RoomRosterEntry[];
  /** The room the roster lives in; two stored values change meaning with it. */
  roomKind: RoomKind;
  /**
   * One member imagined on a different rung, or `null` for the room as it is.
   *
   * Required rather than optional: there is one caller, and a preview a surface
   * forgot to pass is a feature that silently is not there.
   */
  preview: LoudnessPreview | null;
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
 * **The preview is the same computation, not a second one.** Point at a rung —
 * with a pointer or with the arrow keys — and this line answers with what the
 * room WOULD do, through {@link previewLoudness}, which is
 * {@link roomLoudness} over a roster with one value swapped. That is why the
 * caller hands over the member and the rung rather than a finished reading: a
 * preview computed somewhere else can drift, and a preview that disagrees with
 * the outcome teaches the wrong model and only proves itself wrong after the
 * write has landed.
 *
 * **A hypothetical is marked as one, in words as well as in colour.** The tint
 * is for whoever is looking at it; the sentence carries "If you make that
 * change" for whoever is not, because a reader who arrives at this line during
 * a preview would otherwise be told something false about the room they are in.
 * There is no live region: the rung being pointed at already announces its own
 * consequence as it is reached, and a second announcement of the same act is
 * the one nobody asked for.
 *
 * **It must not be drawn over a roster that has not arrived.** An empty list is
 * a real answer here — "There is nobody here to answer you" — so rendering this
 * during the read would state something false about the room and then correct
 * itself. Whatever holds it decides when there is a roster to describe.
 */
export function RoomLoudnessLine({ members, roomKind, preview, className }: RoomLoudnessLineProps) {
  const loudness =
    preview === null
      ? roomLoudness(members, roomKind)
      : previewLoudness(members, roomKind, preview.authorId, preview.rung);

  return (
    <div
      data-slot="room-loudness-line"
      data-preview={preview === null ? undefined : true}
      className={cn(
        'flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors duration-150',
        // Brand rather than a neutral wash: this line is about loudness and the
        // brand is loudness's colour here, so the whole panel reading as one
        // tint says "this is the loudness you would get" without a legend.
        preview === null ? 'bg-muted/50' : 'bg-brand/5 ring-brand/30 ring-1 ring-inset',
        className
      )}
    >
      <LoudnessMeter level={loudness.level} size="room" />
      <div className="min-w-0 flex-1">
        <p className={cn('text-sm', preview !== null && 'text-brand')}>
          {preview !== null && <span className="sr-only">If you make that change: </span>}
          {loudness.sentence}
        </p>
        {loudness.detail !== null && (
          <p className="text-muted-foreground text-xs">{loudness.detail}</p>
        )}
      </div>
    </div>
  );
}
