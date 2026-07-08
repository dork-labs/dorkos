import type { WidgetDocument } from '@dorkos/shared/ui-widget';
import { WidgetActionProvider } from '../model/widget-context';
import { WidgetNodeView } from './WidgetNodeView';

interface WidgetRendererProps {
  /** A validated widget document (parse untrusted input with `parseWidget` first). */
  document: WidgetDocument;
}

/**
 * Render a validated widget document. Wraps the tree in the action provider so
 * interactive nodes can dispatch `ui`/`url` actions; the document `title` labels
 * the region for assistive tech.
 *
 * @param document - A validated {@link WidgetDocument}
 */
export function WidgetRenderer({ document }: WidgetRendererProps) {
  return (
    <WidgetActionProvider>
      <section aria-label={document.title ?? 'Widget'} className="text-sm">
        <WidgetNodeView node={document.root} />
      </section>
    </WidgetActionProvider>
  );
}
