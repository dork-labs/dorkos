/**
 * What a thread panel says INSTEAD of the message its replies answer.
 *
 * Three sentences, and the distinction between them is the whole point: a root
 * that failed to load, a root that has not arrived yet, and a root that is
 * genuinely out of the loaded history. Saying the third while the second is
 * true flashes a small lie on every deep link.
 *
 * Drawn as a row of the log rather than as chrome above it, because it is part
 * of the log: a reply that IS loaded still renders under the sentence
 * explaining why its head is not.
 *
 * @module widgets/room-view/ui/ThreadNotice
 */
import { Skeleton } from '@/layers/shared/ui';

/** Which of the three a panel is showing. */
export type ThreadNoticeKind = 'thread-error' | 'thread-waiting' | 'thread-orphan';

/**
 * Draw the panel's stand-in for a missing root.
 *
 * @param props - Which notice to draw.
 */
export function ThreadNotice({ kind }: { kind: ThreadNoticeKind }) {
  if (kind === 'thread-error') {
    // Said out loud rather than left as a skeleton that never resolves. Same
    // words as the room's own failure, because it is the same read that failed
    // and a reader should not have to work out whether two different sentences
    // mean two different problems.
    return (
      <div
        data-slot="thread-notice"
        data-testid="room-thread-error"
        className="text-muted-foreground flex flex-col items-center gap-2 px-[var(--msg-padding-x)] py-6 text-center text-sm"
      >
        <p className="text-foreground font-medium">Couldn&rsquo;t load this thread</p>
        <p className="max-w-sm text-xs">
          Nothing was lost — a room keeps everything that was said. Reload to try again.
        </p>
      </div>
    );
  }

  if (kind === 'thread-waiting') {
    // Still arriving. A thread whose root has not loaded YET is not a thread
    // whose root is gone.
    return (
      <div data-slot="thread-notice" className="flex flex-col gap-2 px-[var(--msg-padding-x)]">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-full max-w-sm" />
      </div>
    );
  }

  // The orphaned thread (design record §4). Its replies are real and stay; only
  // the message they answer is out of the loaded history.
  return (
    <p
      data-slot="thread-notice"
      data-testid="room-thread-orphan"
      className="text-muted-foreground border-b px-[var(--msg-padding-x)] pb-3 text-xs italic"
    >
      The start of this thread is gone. What was said after it is still here.
    </p>
  );
}
