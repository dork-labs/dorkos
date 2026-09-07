/**
 * The way further back into a room's history (DOR-1734).
 *
 * @module widgets/room-view/ui/LoadOlderRow
 */
import { Button, Spinner } from '@/layers/shared/ui';

interface LoadOlderRowProps {
  /** True while the page is on its way. */
  loading: boolean;
  /** Read the page directly older than what is loaded. */
  onLoad: () => void;
}

/**
 * "Older messages" — the first row of a room whose history reaches past the
 * page it opened on.
 *
 * **A press, not a scroll trigger**, and that is the decision worth stating.
 * Loading on reaching the top reads well in a consumer chat app and badly here:
 * a reader who flicks to the top of a busy room would pull page after page they
 * never asked for, each one moving the ground under them, with no way to say
 * stop. A room is a log an operator reads deliberately. One control, pressed
 * once, one page — and the reader is put back on the message they were standing
 * on (`RoomSurface` holds the timeline handle that does it).
 *
 * Quiet on purpose: it is the ceiling of the room, seen once on the way past
 * and never again, so it is a ghost button in muted text rather than anything
 * that competes with what was said.
 *
 * Its own row inside the feed rather than chrome above it, because it has to
 * scroll with the history: pinned to the top of a scroller it would sit over
 * the oldest message at every position, offering "older" beside the newest
 * line in the room.
 */
export function LoadOlderRow({ loading, onLoad }: LoadOlderRowProps) {
  return (
    <div className="flex justify-center px-4 py-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onLoad}
        disabled={loading}
        data-testid="room-load-older"
        className="text-muted-foreground hover:text-foreground h-7 gap-2 text-xs"
      >
        {loading && <Spinner size="xs" />}
        {loading ? 'Loading older messages…' : 'Older messages'}
      </Button>
    </div>
  );
}
