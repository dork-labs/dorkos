import { Panel, PanelResizeHandle } from 'react-resizable-panels';
import { useAppStore } from '@/layers/shared/model';
import { CanvasHeader } from './CanvasHeader';
import { CanvasUrlContent } from './CanvasUrlContent';
import { CanvasMarkdownContent } from './CanvasMarkdownContent';
import { CanvasJsonContent } from './CanvasJsonContent';
import { CanvasSplash } from './CanvasSplash';

/**
 * Resizable right-side canvas pane for agent-driven content.
 *
 * Renders inside a `PanelGroup` alongside the `ChatPanel`. Returns null when
 * the canvas is closed — no DOM footprint until the agent opens it.
 * Shows a splash screen when open without content.
 */
export function AgentCanvas() {
  const canvasOpen = useAppStore((s) => s.canvasOpen);
  const canvasContent = useAppStore((s) => s.canvasContent);
  const setCanvasOpen = useAppStore((s) => s.setCanvasOpen);
  const setCanvasContent = useAppStore((s) => s.setCanvasContent);

  if (!canvasOpen) return null;

  return (
    <>
      <PanelResizeHandle className="bg-border hover:bg-ring w-1.5 transition-colors" />
      <Panel
        id="agent-canvas"
        order={2}
        defaultSize={50}
        minSize={20}
        collapsible
        onCollapse={() => setCanvasOpen(false)}
      >
        <div className="bg-card flex h-full flex-col overflow-hidden rounded-lg border">
          {canvasContent ? (
            <>
              <CanvasHeader
                title={canvasContent.title}
                contentType={canvasContent.type}
                onClose={() => setCanvasOpen(false)}
              />
              <div className="flex-1 overflow-auto">
                {canvasContent.type === 'url' && <CanvasUrlContent content={canvasContent} />}
                {canvasContent.type === 'markdown' && (
                  <CanvasMarkdownContent content={canvasContent} />
                )}
                {canvasContent.type === 'json' && <CanvasJsonContent content={canvasContent} />}
              </div>
            </>
          ) : (
            <>
              <CanvasHeader onClose={() => setCanvasOpen(false)} />
              <div className="flex-1 overflow-auto">
                <CanvasSplash onAction={setCanvasContent} />
              </div>
            </>
          )}
        </div>
      </Panel>
    </>
  );
}
