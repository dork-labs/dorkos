/**
 * The right panel's two document views, over one store (ADR 260911-200304).
 *
 * {@link CanvasContent} is the Canvas tab and {@link BrowserContent} the Browser
 * tab; both render the same {@link CanvasBody} over the documents their own view
 * holds, with their own active document. {@link CanvasRenderer} is the viewer
 * dispatch those views are DEFINED by — `url` and `browser` go to
 * `CanvasBrowserContent`, so they are the Browser view, and everything else is
 * the Canvas view (`canvasViewForContent`).
 *
 * @module features/canvas/ui/CanvasViews
 */
import { lazy, Suspense } from 'react';
import { useAppStore, documentsInView } from '@/layers/shared/model';
import type { CanvasView } from '@/layers/shared/lib';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { CanvasHeader, canvasPanelId, canvasTabDomId } from './CanvasHeader';
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
import { CanvasHeldUpdateBanner } from './CanvasHeldUpdateBanner';
import { CanvasSplash } from './CanvasSplash';

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

/** Renders one canvas document's content by its discriminated `type`. */
function CanvasRenderer({
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

/**
 * Shared body for one of the two document views — rendered in the right panel's
 * Canvas and Browser tabs, and in the desktop Panel / mobile Sheet below.
 *
 * One store, two views (ADR 260911-200304): the documents are filtered to this
 * view and the active id read from this view's own slot, so switching tabs
 * returns the reader to the document they left there.
 */
function CanvasBody({ view }: { view: CanvasView }) {
  const openDocuments = useAppStore((s) => s.openDocuments);
  const activeDocumentId = useAppStore((s) =>
    view === 'browser' ? s.activeBrowserDocumentId : s.activeCanvasDocumentId
  );
  const activate = useAppStore((s) => s.activateCanvasDocument);
  const close = useAppStore((s) => s.closeCanvasDocument);
  const setDocumentContent = useAppStore((s) => s.setDocumentContent);
  const openDocument = useAppStore((s) => s.openCanvasDocument);
  const applyHeldUpdate = useAppStore((s) => s.applyHeldUpdate);
  const discardHeldUpdate = useAppStore((s) => s.discardHeldUpdate);

  const documents = documentsInView(openDocuments, view);
  const active = documents.find((d) => d.id === activeDocumentId) ?? null;
  const headerDocs = documents.map((d) => ({
    id: d.id,
    sourceLabel: d.sourceLabel,
    contentType: d.content.type,
  }));
  const panelId = canvasPanelId(view);

  return (
    <>
      <CanvasHeader
        view={view}
        documents={headerDocs}
        activeDocumentId={activeDocumentId}
        onActivate={activate}
        onClose={close}
      />
      {/* Above the scroll container, so the choice stays put while the document
          scrolls under it — and outside the tabpanel, because it is about the
          document rather than part of it. */}
      {active?.heldUpdate && (
        <CanvasHeldUpdateBanner
          onReload={() => applyHeldUpdate(active.id)}
          onKeepMine={() => discardHeldUpdate(active.id)}
        />
      )}
      {/* Single scroll container for all content types. min-h-0 keeps the flex
          item from sizing to its content, which would clip instead of scroll
          (DOR-96). When a document is open it is the tab strip's panel, labelled
          by the active tab (WAI-ARIA Tabs). The id + tabIndex are unconditional:
          the strip's Delete-last-tab handling focuses this container by id
          synchronously (before the splash re-render), so it must always be a
          resolvable, focusable target. */}
      <div
        id={panelId}
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-auto focus-visible:outline-none"
        {...(active ? { role: 'tabpanel', 'aria-labelledby': canvasTabDomId(active.id) } : {})}
      >
        {active ? (
          // Contain each document's viewer: a render throw (stale lazy chunk,
          // WebGL failure, a bad file) is caught here, keyed by document id, so
          // it never reaches the outer PanelErrorBoundary and wipes the tab
          // strip. Keying by id resets the boundary on a tab switch and
          // re-attempts render on switch-back.
          <CanvasErrorBoundary key={active.id} documentId={active.id}>
            <CanvasRenderer
              documentId={active.id}
              content={active.content}
              onContentChange={(content) => setDocumentContent(active.id, content)}
            />
          </CanvasErrorBoundary>
        ) : (
          <CanvasSplash view={view} onAction={openDocument} />
        )}
      </div>
    </>
  );
}

/**
 * Standalone canvas body for use as a right-panel contribution.
 *
 * Renders {@link CanvasBody} inside its own full-height flex column — the
 * right-panel slot wrapper is a plain block container, so each contribution
 * must establish the flex context its body needs to lock height and scroll
 * (the same contract the docked profile follows).
 */
export function CanvasContent() {
  return (
    <div data-slot="canvas" className="flex h-full flex-col overflow-hidden">
      <CanvasBody view="canvas" />
    </div>
  );
}

/**
 * The Browser tab's body — the same surface over the documents the embedded
 * browser renders (`url` and `browser`), with its own active document.
 *
 * Registered only under a transport that can serve or proxy a page, so the
 * Obsidian shell drops the tab rather than showing one that could only error
 * (ADR 260911-200304).
 */
export function BrowserContent() {
  return (
    <div data-slot="browser" className="flex h-full flex-col overflow-hidden">
      <CanvasBody view="browser" />
    </div>
  );
}
