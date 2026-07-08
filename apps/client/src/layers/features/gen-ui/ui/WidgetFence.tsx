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
 */
export function WidgetFence({ code, isIncomplete, sessionId }: WidgetFenceProps) {
  if (isIncomplete) {
    return (
      <div className="my-2">
        <WidgetSkeleton />
      </div>
    );
  }

  const result = parseWidget(code);
  return (
    <div className="my-2">
      {result.ok ? (
        <WidgetRenderer document={result.document} sessionId={sessionId} />
      ) : (
        <WidgetErrorCard error={result.error} raw={result.raw} />
      )}
    </div>
  );
}
