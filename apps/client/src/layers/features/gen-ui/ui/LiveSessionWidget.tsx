/**
 * The live, session-bound view a popped-out widget renders in the PIP panel
 * (DOR-298). It pins the session's durable stream and its store retention for
 * its whole lifetime, subscribes to the session's projected stream state, and
 * renders whatever {@link findLatestWidgetFence} reports as the newest
 * `dorkos-ui` board through the UNCHANGED {@link WidgetFence} pipeline — so PIP
 * interactivity (latch, optimistic `<ui_action>`, pending, celebrations,
 * supersede-on-newer-message) is byte-for-byte the inline behavior, never a fork.
 *
 * @module features/gen-ui/ui/LiveSessionWidget
 */
import { useEffect, useMemo, type ReactNode } from 'react';
import { streamManager } from '@/layers/shared/lib';
import {
  useSessionListStore,
  useSessionStreamState,
  useSessionStreamStore,
} from '@/layers/entities/session';
import { findLatestWidgetFence } from '../lib/find-latest-widget-fence';
import { WidgetFence } from './WidgetFence';

/** Props for {@link LiveSessionWidget}. */
export interface LiveSessionWidgetProps {
  /** The session whose newest widget-bearing message this view follows. */
  sessionId: string;
}

/**
 * Render the pinned session's newest `dorkos-ui` widget, following the live game
 * as the agent re-emits the board each turn. Mount pins the session's stream
 * (keeping it live off-route) and its store entry (against LRU eviction); unmount
 * (or a `sessionId` change) unpins both, together, so stream liveness and store
 * retention never disagree.
 *
 * Declared at module scope with no inline renderer closures, so `PipHost`'s
 * renderer map can reference it directly without the `StreamingText.tsx:40-49`
 * remount hazard.
 *
 * @param props - See {@link LiveSessionWidgetProps}.
 */
export function LiveSessionWidget({ sessionId }: LiveSessionWidgetProps): ReactNode {
  useEffect(() => {
    // Resolve the pinned session's cwd for correct off-route history hydration:
    // session metadata first (the more complete source, from `session_upserted`),
    // then the status-derived cwd (populated even for sessions whose metadata was
    // never fetched), and `null` (default cwd) only if neither is known yet. Read
    // synchronously at pin time — the pop-out affordance only surfaces on a widget
    // in the session the operator is already viewing, so its cwd is already known;
    // `pinSession` keys idempotency on `sessionId` alone, so a repeat call could
    // not adopt a late-resolved cwd anyway.
    const listState = useSessionListStore.getState();
    const cwd = listState.sessions[sessionId]?.cwd ?? listState.statusCwds[sessionId] ?? null;
    streamManager.pinSession(sessionId, cwd);
    useSessionStreamStore.getState().setPinnedSession(sessionId);
    return () => {
      streamManager.unpinSession();
      useSessionStreamStore.getState().setPinnedSession(null);
    };
  }, [sessionId]);

  const state = useSessionStreamState(sessionId);
  const fence = useMemo(() => findLatestWidgetFence(state), [state]);

  if (fence === null) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center p-4 text-center text-sm">
        No live widget in this session
      </div>
    );
  }

  return (
    <WidgetFence
      code={fence.code}
      isIncomplete={fence.isIncomplete}
      sessionId={sessionId}
      isLatestMessage={fence.isLatest}
      isStreaming={fence.isStreaming}
    />
  );
}
