import type { UiCanvasContent } from '@dorkos/shared/types';
import { WidgetRenderer, WidgetErrorCard, validateWidgetDocument } from '@/layers/features/gen-ui';

interface CanvasWidgetContentProps {
  /** Widget canvas content variant. */
  content: Extract<UiCanvasContent, { type: 'widget' }>;
}

/**
 * Render a Tier-1 widget document in the canvas — the same {@link WidgetRenderer}
 * used inline in chat, given room to breathe in the canvas pane.
 *
 * The wire schema types `definition` as `z.custom<WidgetDocument>()` without a
 * structural predicate (a value import of the widget schema into `schemas.ts`
 * would form a load-time module cycle), so anything can arrive here. Validate at
 * this render boundary — exactly like the fence path — and degrade to the D5
 * error card on failure; the canvas panel must never throw.
 */
export function CanvasWidgetContent({ content }: CanvasWidgetContentProps) {
  const result = validateWidgetDocument(content.definition);
  return (
    <div className="p-4">
      {result.ok ? (
        <WidgetRenderer document={result.document} />
      ) : (
        <WidgetErrorCard error={result.error} raw={result.raw} />
      )}
    </div>
  );
}
