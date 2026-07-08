import type { UiCanvasContent } from '@dorkos/shared/types';
import { WidgetRenderer } from '@/layers/features/gen-ui';

interface CanvasWidgetContentProps {
  /** Widget canvas content variant. */
  content: Extract<UiCanvasContent, { type: 'widget' }>;
}

/**
 * Render a Tier-1 widget document in the canvas — the same {@link WidgetRenderer}
 * used inline in chat, given room to breathe in the canvas pane.
 */
export function CanvasWidgetContent({ content }: CanvasWidgetContentProps) {
  return (
    <div className="p-4">
      <WidgetRenderer document={content.definition} />
    </div>
  );
}
