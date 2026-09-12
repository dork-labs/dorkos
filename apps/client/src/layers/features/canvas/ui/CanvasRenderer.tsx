/**
 * The viewer dispatch the canvas's two views are DEFINED by.
 *
 * Fourteen content types, twelve viewers: `url` and `browser` both go to
 * `CanvasBrowserContent`, which is exactly why those two are the Browser view
 * and the other twelve are the Canvas view (`canvasViewForContent`). Split out
 * of `CanvasViews` because a room's shared table draws the same documents
 * through the same viewers as a private session canvas — only where the
 * documents come from, and who may write them, differ.
 *
 * @module features/canvas/ui/CanvasRenderer
 */
import { lazy, Suspense } from 'react';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { CanvasErrorBoundary } from './CanvasErrorBoundary';
import { CanvasBrowserContent } from './CanvasBrowserContent';
import { CanvasMarkdownContent } from './CanvasMarkdownContent';
import { CanvasJsonContent } from './CanvasJsonContent';
import { CanvasImageContent } from './CanvasImageContent';
import { CanvasPdfContent } from './CanvasPdfContent';
import { CanvasAudioContent } from './CanvasAudioContent';
import { CanvasVideoContent } from './CanvasVideoContent';
import { CanvasWidgetContent } from './CanvasWidgetContent';
import { CanvasMcpAppContent } from './CanvasMcpAppContent';

// Lazy: viewers that pull heavy, on-demand deps (CodeMirror, three.js /
// model-viewer, papaparse) load only when their document first renders.
const CanvasFileContent = lazy(() =>
  import('./CanvasFileContent').then((m) => ({ default: m.CanvasFileContent }))
);
const CanvasModel3dContent = lazy(() =>
  import('./CanvasModel3dContent').then((m) => ({ default: m.CanvasModel3dContent }))
);
const CanvasCsvContent = lazy(() =>
  import('./CanvasCsvContent').then((m) => ({ default: m.CanvasCsvContent }))
);
// Feature→feature UI composition (DOR-212): the canvas dispatches the `diff`
// variant to the diff-review feature's viewer, lazy so its `@codemirror/merge`
// runtime never lands in the main bundle.
const CanvasDiffContent = lazy(() =>
  import('@/layers/features/diff-review').then((m) => ({ default: m.CanvasDiffContent }))
);

/**
 * Render one canvas document's content by its discriminated `type`.
 *
 * @param props - The document's id, its content, and where an in-place edit
 *   writes back to.
 */
export function CanvasRenderer({
  documentId,
  content,
  onContentChange,
}: {
  documentId: string;
  content: UiCanvasContent;
  onContentChange: (content: UiCanvasContent) => void;
}) {
  switch (content.type) {
    // `url` and `browser` share one renderer (DOR-233): every canvas webpage gets
    // navigation chrome and origin isolation, whichever content type opened it.
    // Key on document identity AND content identity — the browser snapshots
    // `content.url` into its history stack on mount, so an `update_canvas` that
    // swaps the url in place (same document) and a tab switch between two web
    // documents (same tree position) must both remount it. documentId alone
    // misses the in-place update; url alone conflates two docs at the same URL.
    case 'url':
    case 'browser':
      return (
        <CanvasBrowserContent
          key={`${documentId}:${content.url}`}
          documentId={documentId}
          content={content}
        />
      );
    case 'markdown':
      // Key per source file so the editor + its save state remount fresh when
      // the document swaps (defense in depth).
      return (
        <CanvasMarkdownContent
          key={content.sourcePath ?? 'generated'}
          documentId={documentId}
          content={content}
          onContentChange={onContentChange}
        />
      );
    case 'json':
      return <CanvasJsonContent content={content} />;
    case 'image':
      return <CanvasImageContent content={content} />;
    case 'pdf':
      return <CanvasPdfContent content={content} />;
    case 'audio':
      return <CanvasAudioContent content={content} />;
    case 'video':
      return <CanvasVideoContent content={content} />;
    case 'widget':
      return <CanvasWidgetContent content={content} />;
    case 'mcp_app':
      return <CanvasMcpAppContent content={content} />;
    case 'file':
      return (
        <Suspense fallback={<CanvasLoading />}>
          <CanvasFileContent documentId={documentId} content={content} />
        </Suspense>
      );
    case 'model3d':
      return (
        <Suspense fallback={<CanvasLoading />}>
          <CanvasModel3dContent content={content} />
        </Suspense>
      );
    case 'csv':
      return (
        <Suspense fallback={<CanvasLoading />}>
          <CanvasCsvContent content={content} />
        </Suspense>
      );
    case 'diff':
      // Key per source file so review state (hunk count, side-by-side toggle,
      // armed confirms) never leaks between two open diff tabs that share the
      // same tree position on a tab switch.
      return (
        <Suspense fallback={<CanvasLoading />}>
          <CanvasDiffContent key={content.sourcePath} documentId={documentId} content={content} />
        </Suspense>
      );
  }
}

/** Fallback shown while a lazy viewer chunk loads. */
function CanvasLoading() {
  return <div className="text-muted-foreground p-4 text-sm">Loading…</div>;
}
