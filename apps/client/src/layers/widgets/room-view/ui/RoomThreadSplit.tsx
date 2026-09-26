import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Panel, PanelGroup, type ImperativePanelHandle } from 'react-resizable-panels';
import { STORAGE_KEYS } from '@/layers/shared/lib';
import { PaneResizeHandle } from '@/layers/shared/ui';
import {
  THREAD_SPLIT_ID,
  forgetLegacyThreadLayout,
  readChosenThreadWidth,
  threadPctFor,
  useThreadColumnSizing,
  writeChosenThreadWidth,
} from '../model/use-thread-column-sizing';

const ROOM_PANE_ID = `${THREAD_SPLIT_ID}-room`;
const THREAD_PANE_ID = `${THREAD_SPLIT_ID}-thread`;
const HANDLE_ID = `${THREAD_SPLIT_ID}-handle`;

/** Below this much play, in pixels, the handle is disabled rather than offered. */
const MIN_RANGE_PX = 4;

interface RoomThreadSplitProps {
  /** The room's own column: bar chrome, timeline, live lane and composer. */
  room: ReactNode;
  /** The open thread's panel, or `false` when no thread is open. */
  thread: ReactNode | false;
  /**
   * Where the chosen thread width is kept. The app's own key by default; the
   * Dev Playground passes its own so dragging a demo never moves a real room.
   */
  storageKey?: string;
}

/**
 * The room and its open thread, side by side, with a handle between them.
 *
 * Wide screens only — on a phone the thread is a full-screen push and there is
 * nothing to divide. The handle is the same {@link PaneResizeHandle} the right
 * panel uses, so the two splits look and behave alike.
 *
 * **The width a reader chose is remembered, and nothing else is.** The library
 * clamps panes to their bounds whenever the split narrows — a smaller window,
 * the right panel opening — and its own `autoSaveId` would save that clamped
 * size over the chosen one, so a thread squeezed once stayed squeezed for good.
 * Instead the width is saved in pixels only when a drag lets go or a key moves
 * the separator, and the live size is derived from it and today's bounds on
 * every measure ({@link threadPctFor}).
 *
 * **The separator describes the THREAD.** The library reports the pane before
 * it, which here is the room, so a screen reader heard a number going down as
 * the thread it was resizing got wider. The value, range and `aria-controls` are
 * rewritten after the library writes them: the thread's width, rising as Left
 * Arrow moves the line toward the room, with Home and End taking the thread to
 * its narrowest and widest. When the split is too narrow to offer
 * any range, the handle is disabled rather than left as a stop that does
 * nothing.
 *
 * @param props - The room column and the thread panel.
 */
export function RoomThreadSplit({
  room,
  thread,
  storageKey = STORAGE_KEYS.ROOM_THREAD_WIDTH,
}: RoomThreadSplitProps) {
  const { ref, element, width, sizing } = useThreadColumnSizing();
  const [chosenPx, setChosenPx] = useState(() => readChosenThreadWidth(storageKey));
  const [livePct, setLivePct] = useState<number | null>(null);
  const threadPane = useRef<ImperativePanelHandle>(null);
  const targetPct = threadPctFor(chosenPx, width, sizing);
  // Too little range to be worth a stop: at 1440 with the right panel open the
  // floors leave half a pixel of play, and a separator that moves by that is
  // one a keyboard reader lands on for nothing.
  const fixed = width === null || ((sizing.maxPct - sizing.minPct) / 100) * width < MIN_RANGE_PX;
  const open = thread !== false;

  // Once per mount, and cheap: the old store only ever held a clamped layout.
  useEffect(forgetLegacyThreadLayout, []);

  // Follow the target: a re-measure moves the bounds, a chosen width moves the
  // target, and either way the pane goes where the two agree. A resize here is
  // never saved — only `rememberChoice` saves.
  //
  // Only once the group has laid the pane out (`laidOut`, set from `onLayout`,
  // which the group calls in its own layout effect — before this one runs).
  // Until then the library has no size for the pane and `resize` throws, and
  // `defaultSize` already puts it at this same target.
  const laidOut = useRef(false);
  useLayoutEffect(() => {
    if (laidOut.current) threadPane.current?.resize(targetPct);
  }, [targetPct, open]);

  /**
   * The thread's size when a resize began — a drag taking hold, or a key
   * arriving at the separator — so the end can tell a move from a no-op.
   *
   * **Read in the key's CAPTURE phase, never from the last render.** A real key
   * press runs the microtask queue between the library's listener on the
   * separator and React's at the root, and React commits the new width in that
   * gap: a "before" read from what was last rendered is already the "after",
   * and the move looked like nothing and was never saved. Capture runs before
   * the library's listener, so it is the one place the old width is still true.
   */
  const startPct = useRef<number | null>(null);

  const rememberChoice = () => {
    const now = threadPane.current?.getSize();
    const before = startPct.current;
    startPct.current = null;
    // A click on the handle, or a key against a bound, moved nothing: that is
    // not a choice, and saving it would store whatever squeeze is on screen.
    if (now === undefined || width === null || width <= 0 || before === now) return;
    const px = Math.round((now / 100) * width);
    setChosenPx(px);
    writeChosenThreadWidth(storageKey, px);
  };

  const shownPct = livePct ?? targetPct;
  useLayoutEffect(() => {
    // Deliberately every commit, after the library's own write in the same
    // commit (a parent's layout effects run after its children's).
    const handle = element?.querySelector(`[data-panel-resize-handle-id="${HANDLE_ID}"]`);
    if (!handle) return;
    handle.setAttribute('aria-controls', THREAD_PANE_ID);
    handle.setAttribute('aria-valuenow', String(Math.round(shownPct)));
    handle.setAttribute('aria-valuemin', String(Math.round(sizing.minPct)));
    handle.setAttribute('aria-valuemax', String(Math.round(sizing.maxPct)));
  });

  return (
    <div ref={ref} className="h-full overflow-hidden">
      <PanelGroup
        direction="horizontal"
        id={THREAD_SPLIT_ID}
        onLayout={(layout) => {
          laidOut.current = layout.length > 1;
          setLivePct(laidOut.current ? layout[1]! : null);
        }}
      >
        <Panel id={ROOM_PANE_ID} order={1} className="flex">
          {room}
        </Panel>
        {open && (
          <>
            <PaneResizeHandle
              id={HANDLE_ID}
              aria-label="Resize thread"
              data-testid="room-thread-resize-handle"
              disabled={fixed}
              onDragging={(dragging) => {
                if (dragging) startPct.current = threadPane.current?.getSize() ?? null;
              }}
              onKeyDownCapture={(event) => {
                startPct.current = threadPane.current?.getSize() ?? null;
                // Home and End, the thread's way round. The library moves the
                // pane BEFORE the line to its smallest on Home — the room — which
                // made the thread, the pane this separator is named for, its
                // largest. Taken here, before the library's own listener sees it.
                if (event.key !== 'Home' && event.key !== 'End') return;
                event.preventDefault();
                threadPane.current?.resize(event.key === 'Home' ? sizing.minPct : sizing.maxPct);
              }}
              onResizeEnd={rememberChoice}
            />
            <Panel
              ref={threadPane}
              id={THREAD_PANE_ID}
              order={2}
              defaultSize={targetPct}
              minSize={sizing.minPct}
              maxSize={sizing.maxPct}
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
