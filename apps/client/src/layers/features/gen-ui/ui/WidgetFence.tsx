import { useRef } from 'react';
import type { WidgetDocument } from '@dorkos/shared/ui-widget';
import { parseWidget } from '../model/parse-widget';
import { WidgetRenderer } from './WidgetRenderer';
import { WidgetErrorCard } from './WidgetErrorCard';
import { WidgetSkeleton } from './WidgetSkeleton';

interface WidgetFenceProps {
  /** Raw fence body (the JSON widget document). */
  code: string;
  /** True while the fence is still streaming (unclosed). */
  isIncomplete: boolean;
  /**
   * The session this widget was rendered in — threaded through so `agent`-kind
   * actions can POST back to it. Supplied by the chat message pipeline.
   */
  sessionId?: string;
}

/**
 * Streamdown custom renderer for ` ```dorkos-ui ` fences. While the fence is
 * still streaming, shows a skeleton (D3, v1 renders only on completion). Once
 * complete, parses the payload and renders the widget — or the D5 error card if
 * the payload is invalid. Extra streamdown props (`language`, `meta`) are ignored.
 *
 * Stability: streamdown re-parses markdown on every streamed token and can flip
 * `isIncomplete` back to `true` (or briefly hand back truncated `code`) after the
 * fence has already closed once. We latch the last successfully-parsed document
 * so the widget never flickers back to a skeleton mid-conversation — it only ever
 * moves forward (skeleton → widget), updating in place when a newer parse succeeds.
 */
export function WidgetFence({ code, isIncomplete, sessionId }: WidgetFenceProps) {
  const lastDocRef = useRef<WidgetDocument | null>(null);

  if (!isIncomplete) {
    const result = parseWidget(code);
    if (result.ok) {
      lastDocRef.current = result.document;
    } else if (lastDocRef.current === null) {
      // Fence closed but never parsed into a valid document — show the error card.
      return (
        <div className="my-2">
          <WidgetErrorCard error={result.error} raw={result.raw} />
        </div>
      );
    }
    // else: a late invalid re-parse after a good render — keep the good render below.
  }

  if (lastDocRef.current) {
    return (
      <div className="my-2">
        <WidgetRenderer document={lastDocRef.current} sessionId={sessionId} />
      </div>
    );
  }

  return (
    <div className="my-2">
      <WidgetSkeleton />
    </div>
  );
}
