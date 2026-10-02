import { useMemo } from 'react';
import type { UiCanvasContent } from '@dorkos/shared/types';
import {
  WidgetRenderer,
  WidgetErrorCard,
  validateWidgetDocument,
  type WidgetChannelPort,
} from '@/layers/features/gen-ui';
import { useSessionId } from '@/layers/entities/session';

interface CanvasWidgetContentProps {
  /** Widget canvas content variant. */
  documentId?: string;
  channel?: WidgetChannelPort;
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
export function CanvasWidgetContent({ content, documentId, channel }: CanvasWidgetContentProps) {
  const [sessionId] = useSessionId();
  const result = validateWidgetDocument(content.definition);
  // Inline-style canvases reset the legacy turn latch when their definition
  // changes. A document channel instead keeps the physical document identity:
  // downstream receipt/state updates must preserve the user's draft and caret.
  const contentKey = useMemo(() => JSON.stringify(content.definition), [content.definition]);
  return (
    <div className="p-4">
      {result.ok ? (
        <WidgetRenderer
          key={channel ? (documentId ?? channel.documentId) : contentKey}
          channel={channel}
          document={result.document}
          sessionId={sessionId ?? undefined}
        />
      ) : (
        <WidgetErrorCard error={result.error} raw={result.raw} />
      )}
    </div>
  );
}
