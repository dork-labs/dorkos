import type { ReactNode } from 'react';
import { Panel, PanelGroup } from 'react-resizable-panels';
import { PaneResizeHandle } from '@/layers/shared/ui';
import { THREAD_SPLIT_ID, useThreadColumnSizing } from '../model/use-thread-column-sizing';

interface RoomThreadSplitProps {
  /** The room's own column: bar chrome, timeline, live lane and composer. */
  room: ReactNode;
  /** The open thread's panel, or `false` when no thread is open. */
  thread: ReactNode | false;
}

/**
 * The room and its open thread, side by side, with a handle between them.
 *
 * Wide screens only — on a phone the thread is a full-screen push and there is
 * nothing to divide. The handle is the same {@link PaneResizeHandle} the right
 * panel uses, so the two splits look and behave alike, and the dragged width
 * is remembered in this viewer's browser (`autoSaveId`) the same way.
 *
 * Both panes carry an `id` and an `order` because the thread pane mounts and
 * unmounts as threads open and close; the library keys its saved layouts by
 * which panes are present, so closing a thread gives the room the whole width
 * and reopening one restores the width it had.
 *
 * @param props - The room column and the thread panel.
 */
export function RoomThreadSplit({ room, thread }: RoomThreadSplitProps) {
  const { ref, measured, sizing } = useThreadColumnSizing();
  const { minPct, maxPct, defaultPct } = sizing;

  return (
    <div ref={ref} className="h-full overflow-hidden">
      <PanelGroup direction="horizontal" id={THREAD_SPLIT_ID} autoSaveId={THREAD_SPLIT_ID}>
        <Panel id="room" order={1} className="flex">
          {room}
        </Panel>
        {thread !== false && measured && (
          <>
            <PaneResizeHandle aria-label="Resize thread" data-testid="room-thread-resize-handle" />
            <Panel
              id="thread"
              order={2}
              defaultSize={defaultPct}
              minSize={minPct}
              maxSize={maxPct}
              className="flex"
            >
              {thread}
            </Panel>
          </>
        )}
      </PanelGroup>
    </div>
  );
}
