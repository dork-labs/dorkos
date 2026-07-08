import { useMemo } from 'react';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { resolveCanvasMediaSrc, canvasMediaErrorMessage } from '../lib/media-src';

interface CanvasPdfContentProps {
  /** PDF canvas content variant. */
  content: Extract<UiCanvasContent, { type: 'pdf' }>;
}

/**
 * PDF canvas renderer: the browser's native PDF viewer via `<object>`. When the
 * viewer can't render (no plugin, load failure), the `<object>`'s fallback
 * content shows an open-in-new-tab link instead.
 */
export function CanvasPdfContent({ content }: CanvasPdfContentProps) {
  const transport = useTransport();
  const cwd = useAppStore((s) => s.selectedCwd);

  const resolved = useMemo(
    () => resolveCanvasMediaSrc(content.src, 'pdf', (p) => transport.mediaUrl(cwd ?? '', p)),
    [content.src, transport, cwd]
  );

  if (resolved.url === null) {
    const message = resolved.error ? canvasMediaErrorMessage(resolved.error, 'pdf') : '';
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center p-8 text-center">
        <p>{message}</p>
      </div>
    );
  }

  const url = resolved.url;
  const title = content.title ?? 'PDF document';

  return (
    <object data={url} type="application/pdf" title={title} className="h-full w-full">
      {/* Shown by the browser when it can't render the PDF inline. */}
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p>This PDF can&rsquo;t be shown here.</p>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-foreground focus-ring rounded-md underline underline-offset-4"
        >
          Open {title} in a new tab
        </a>
      </div>
    </object>
  );
}
