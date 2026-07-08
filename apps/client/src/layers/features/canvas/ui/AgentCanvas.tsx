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
import { CanvasSplash } from './CanvasSplash';

/** Shared canvas body — rendered in both desktop Panel and mobile Sheet. */
function CanvasBody({
  canvasContent,
  onSetContent,
}: {
  canvasContent: UiCanvasContent | null;
  onSetContent: (content: UiCanvasContent | null) => void;
}) {
  if (canvasContent) {
    return (
      <>
        <CanvasHeader title={canvasContent.title} contentType={canvasContent.type} />
        {/* Single scroll container for all content types. min-h-0 keeps the
            flex item from sizing to its content, which would clip instead of
            scroll (DOR-96). */}
        <div className="min-h-0 flex-1 overflow-auto">
          {canvasContent.type === 'url' && <CanvasUrlContent content={canvasContent} />}
          {canvasContent.type === 'markdown' && (
            // Key per source file so the editor + its save state remount fresh
            // when the canvas swaps to a different document (defense in depth).
            <CanvasMarkdownContent
              key={canvasContent.sourcePath ?? 'generated'}
              content={canvasContent}
              onContentChange={onSetContent}
            />
          )}
          {canvasContent.type === 'json' && <CanvasJsonContent content={canvasContent} />}
          {canvasContent.type === 'image' && <CanvasImageContent content={canvasContent} />}
          {canvasContent.type === 'pdf' && <CanvasPdfContent content={canvasContent} />}
        </div>
      </>
    );
  }

  return (
    <>
      <CanvasHeader />
      <div className="min-h-0 flex-1 overflow-auto">
        <CanvasSplash onAction={onSetContent} />
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
  const canvasContent = useAppStore((s) => s.canvasContent);
  const setCanvasContent = useAppStore((s) => s.setCanvasContent);

  return (
    <div data-slot="canvas" className="flex h-full flex-col overflow-hidden">
      <CanvasBody canvasContent={canvasContent} onSetContent={setCanvasContent} />
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
  const canvasContent = useAppStore((s) => s.canvasContent);
  const setCanvasOpen = useAppStore((s) => s.setCanvasOpen);
  const setCanvasContent = useAppStore((s) => s.setCanvasContent);
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
          <CanvasBody canvasContent={canvasContent} onSetContent={setCanvasContent} />
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
          <CanvasBody canvasContent={canvasContent} onSetContent={setCanvasContent} />
        </div>
      </Panel>
    </>
  );
}
