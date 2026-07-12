import { useMemo } from 'react';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { WidgetRenderer, WidgetErrorCard, validateWidgetDocument } from '@/layers/features/gen-ui';
import { useSessionId } from '@/layers/entities/session';

interface CanvasWidgetContentProps {
  /** Widget canvas content variant. */
  content: Extract<UiCanvasContent, { type: 'widget' }>;
}

/**
 * Render a Tier-1 widget document in the canvas — the same {@link WidgetRenderer}
 * used inline in chat, given room to breathe in the canvas pane. The active
 * session id is threaded in so a canvas widget's `agent` actions post back to the
 * session that owns the canvas.
 *
 * The wire schema types `definition` as `z.custom<WidgetDocument>()` without a
 * structural predicate (a value import of the widget schema into `schemas.ts`
 * would form a load-time module cycle), so anything can arrive here. Validate at
 * this render boundary — exactly like the fence path — and degrade to the D5
 * error card on failure; the canvas panel must never throw.
 */
export function CanvasWidgetContent({ content }: CanvasWidgetContentProps) {
  const [sessionId] = useSessionId();
  const result = validateWidgetDocument(content.definition);
  // Remount the widget subtree whenever the definition changes. The action
  // latch (React state + a synchronous dispatchedRef) lives per
  // WidgetActionProvider instance; an `update_canvas` push swaps `definition`
  // in place, so without a changing key the new board arrives pre-latched and
  // never accepts a move. A re-emitted board is a fresh turn and must arrive
  // live — mirrors the inline chat path, where each message renders a new
  // fence instance. Same definition → same key → no spurious remount. The full
  // serialized definition is the key (React keys can be any length, and the
  // string is collision-free — no hashing needed).
  const contentKey = useMemo(() => JSON.stringify(content.definition), [content.definition]);
  return (
    <div className="p-4">
      {result.ok ? (
        <WidgetRenderer
          key={contentKey}
          document={result.document}
          sessionId={sessionId ?? undefined}
        />
      ) : (
        <WidgetErrorCard error={result.error} raw={result.raw} />
      )}
    </div>
  );
}
