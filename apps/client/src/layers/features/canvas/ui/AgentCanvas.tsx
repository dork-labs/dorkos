import { lazy, Suspense } from 'react';
import { Panel, PanelResizeHandle } from 'react-resizable-panels';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/layers/shared/ui';
import { useAppStore, useIsMobile } from '@/layers/shared/model';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { CanvasHeader } from './CanvasHeader';
import { CanvasUrlContent } from './CanvasUrlContent';
import { CanvasMarkdownContent } from './CanvasMarkdownContent';
import { CanvasJsonContent } from './CanvasJsonContent';
import { CanvasImageContent } from './CanvasImageContent';
import { CanvasPdfContent } from './CanvasPdfContent';
import { CanvasWidgetContent } from './CanvasWidgetContent';
import { CanvasMcpAppContent } from './CanvasMcpAppContent';
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

/** Renders one canvas document's content by its discriminated `type`. */
function CanvasRenderer({
  content,
  onContentChange,
}: {
  content: UiCanvasContent;
  onContentChange: (content: UiCanvasContent) => void;
}) {
  switch (content.type) {
    case 'url':
      return <CanvasUrlContent content={content} />;
    case 'markdown':
      // Key per source file so the editor + its save state remount fresh when
      // the document swaps (defense in depth).
      return (
        <CanvasMarkdownContent
          key={content.sourcePath ?? 'generated'}
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
    case 'widget':
      return <CanvasWidgetContent content={content} />;
    case 'mcp_app':
      return <CanvasMcpAppContent content={content} />;
    case 'file':
      return (
        <Suspense fallback={<CanvasLoading />}>
          <CanvasFileContent content={content} />
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
  }
}

/** Fallback shown while a lazy viewer chunk loads. */
function CanvasLoading() {
  return <div className="text-muted-foreground p-4 text-sm">Loading…</div>;
}

/** Shared canvas body — rendered in both desktop Panel and mobile Sheet. */
function CanvasBody() {
  const openDocuments = useAppStore((s) => s.openDocuments);
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const activate = useAppStore((s) => s.activateCanvasDocument);
  const close = useAppStore((s) => s.closeCanvasDocument);
  const setActiveContent = useAppStore((s) => s.setActiveDocumentContent);
  const openDocument = useAppStore((s) => s.openCanvasDocument);

  const active = openDocuments.find((d) => d.id === activeDocumentId) ?? null;
  const headerDocs = openDocuments.map((d) => ({
    id: d.id,
    sourceLabel: d.sourceLabel,
    contentType: d.content.type,
  }));

  return (
    <>
      <CanvasHeader
        documents={headerDocs}
        activeDocumentId={activeDocumentId}
        onActivate={activate}
        onClose={close}
      />
      {/* Single scroll container for all content types. min-h-0 keeps the flex
          item from sizing to its content, which would clip instead of scroll
          (DOR-96). */}
      <div className="min-h-0 flex-1 overflow-auto">
        {active ? (
          <CanvasRenderer content={active.content} onContentChange={setActiveContent} />
        ) : (
          <CanvasSplash onAction={openDocument} />
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
 * (same contract AgentHub follows).
 */
export function CanvasContent() {
  return (
    <div data-slot="canvas" className="flex h-full flex-col overflow-hidden">
      <CanvasBody />
    </div>
  );
}

/**
 * Resizable right-side canvas pane for agent-driven content.
 *
 * Desktop: renders inside a `PanelGroup` alongside the `ChatPanel` with a
 * thin resize handle. Mobile: renders as a full-width Sheet from the right.
 * Returns null when the canvas is closed — no DOM footprint.
 */
export function AgentCanvas() {
  const canvasOpen = useAppStore((s) => s.canvasOpen);
  const setCanvasOpen = useAppStore((s) => s.setCanvasOpen);
  const isMobile = useIsMobile();

  if (!canvasOpen) return null;

  const handleClose = () => setCanvasOpen(false);

  // Mobile: full-width Sheet from the right (mirrors sidebar mobile pattern)
  if (isMobile) {
    return (
      <Sheet open onOpenChange={(open) => !open && handleClose()}>
        <SheetContent
          side="right"
          showCloseButton={false}
          className="bg-sidebar text-sidebar-foreground flex w-full flex-col gap-0 p-0 sm:max-w-full"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Canvas</SheetTitle>
            <SheetDescription>Agent-driven content pane.</SheetDescription>
          </SheetHeader>
          <CanvasBody />
        </SheetContent>
      </Sheet>
    );
  }

  // Desktop: resizable panel with thin separator
  return (
    <>
      <PanelResizeHandle className="group relative flex w-2 items-center justify-center">
        <div className="bg-border group-hover:bg-ring h-full w-px transition-colors" />
      </PanelResizeHandle>
      <Panel
        id="agent-canvas"
        order={2}
        defaultSize={50}
        minSize={20}
        collapsible
        onCollapse={handleClose}
      >
        <div className="bg-sidebar text-sidebar-foreground flex h-full flex-col overflow-hidden rounded-lg border">
          <CanvasBody />
        </div>
      </Panel>
    </>
  );
}
