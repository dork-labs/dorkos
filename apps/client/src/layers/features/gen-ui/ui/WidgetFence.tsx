import { useRef } from 'react';
import { PictureInPicture2 } from 'lucide-react';
import type { WidgetDocument } from '@dorkos/shared/ui-widget';
import { useAppStore } from '@/layers/shared/model';
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
  /**
   * Whether the message hosting this fence is the latest in the conversation.
   * Threaded down so a superseded widget renders its `agent` actions inert.
   * Defaults to `true` (surfaces with no message context are always live).
   */
  isLatestMessage?: boolean;
  /**
   * Whether the hosting message is still STREAMING. While a turn streams, a
   * chunk boundary can make the fence look complete (`isIncomplete: false`)
   * with the JSON still truncated — a parse failure then must show the
   * skeleton, never the error card (the flash of "This widget couldn't be
   * rendered" mid-stream). Once settled (`false`, the default), an invalid
   * fence is genuinely broken and the error card is correct.
   */
  isStreaming?: boolean;
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
 * While the message streams, a parse failure holds the skeleton (or the latched
 * doc) rather than flashing the error card at a chunk boundary.
 */
export function WidgetFence({
  code,
  isIncomplete,
  sessionId,
  isLatestMessage,
  isStreaming = false,
}: WidgetFenceProps) {
  const lastDocRef = useRef<WidgetDocument | null>(null);
  // Called unconditionally, ahead of the branches below, so hook order never
  // shifts with parse state (an early return before these would violate the
  // rules of hooks once the pop-out affordance needs them).
  const openPip = useAppStore((s) => s.openPip);

  if (!isIncomplete) {
    const result = parseWidget(code);
    if (result.ok) {
      lastDocRef.current = result.document;
    } else if (lastDocRef.current === null && !isStreaming) {
      // Fence closed in a SETTLED message but never parsed into a valid
      // document — genuinely broken, show the error card. While streaming,
      // fall through to the skeleton instead: the "complete" fence may just be
      // a chunk boundary with the JSON still truncated.
      return (
        <div className="my-2">
          <WidgetErrorCard error={result.error} raw={result.raw} />
        </div>
      );
    }
    // else: a late invalid re-parse after a good render — keep the good render below.
  }

  if (lastDocRef.current) {
    const latchedDocument = lastDocRef.current;
    // Popping out never touches this document's own agent-action dispatch, so
    // define it here rather than lifting it — closing over the latched
    // document by value keeps the panel's title pinned to what was actually
    // popped, even if a later stream update latches a new one in place.
    const popOut = () => {
      if (!sessionId) return;
      openPip({ kind: 'widget', sessionId, title: latchedDocument.title ?? 'Widget' });
    };
    return (
      <div className="group relative my-2">
        <WidgetRenderer
          document={latchedDocument}
          sessionId={sessionId}
          isLatestMessage={isLatestMessage}
        />
        {/* A sibling of the widget tree, never a descendant — so it can never
            intercept a click meant for the widget's own interactive content
            (e.g. a board cell). Always visible on touch (no hover below `md`,
            where the PIP host docks a bottom sheet — DOR-299) and hover-revealed
            on desktop. Hidden with no sessionId (no valid `openPip` target). */}
        {sessionId && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              popOut();
            }}
            aria-label="Pop out into a floating window"
            title="Pop out"
            className="text-muted-foreground hover:bg-muted hover:text-foreground bg-background/80 focus-ring absolute top-1 right-1 rounded-md p-1 opacity-100 backdrop-blur-sm transition-opacity focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
          >
            <PictureInPicture2 className="size-3.5" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="my-2">
      <WidgetSkeleton />
    </div>
  );
}
