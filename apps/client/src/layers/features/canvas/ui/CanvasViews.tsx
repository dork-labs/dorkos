/**
 * The right panel's two document views, over one store (ADR 260911-200304).
 *
 * {@link CanvasContent} is the Canvas tab and {@link BrowserContent} the Browser
 * tab. With a room on screen both draw that ROOM's shared table through
 * {@link RoomCanvasBody} — the same tab strip and the same viewers, over
 * documents the server owns and every member sees; everywhere else they draw the
 * private, per-session canvas through {@link CanvasBody}. Which documents belong
 * to which tab is `canvasViewForContent` either way: `url` and `browser` are the
 * Browser view, the other twelve are the Canvas view.
 *
 * **Which room, from the store rather than the route.** `roomCanvasLiveRoomId`
 * is written by the room stream, which is opened for exactly the room on screen;
 * resolving the route here instead would need the transport (Home's `#team` is
 * found by a lookup, not by a path), and these two components also render in the
 * Obsidian shell and in tests that have neither router nor transport.
 *
 * @module features/canvas/ui/CanvasViews
 */
import { useAppStore, documentsInView } from '@/layers/shared/model';
import type { CanvasView } from '@/layers/shared/lib';
import { CanvasHeader, canvasPanelId, canvasTabDomId } from './CanvasHeader';
import { CanvasErrorBoundary } from './CanvasErrorBoundary';
import { CanvasRenderer } from './CanvasRenderer';
import { CanvasHeldUpdateBanner } from './CanvasHeldUpdateBanner';
import { CanvasSplash } from './CanvasSplash';
import { RoomCanvasBody } from './room/RoomCanvasBody';

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
 * The Canvas tab's body — this session's own documents, or the room's, by route.
 *
 * The route is the only thing that decides: on a room route the tab draws the
 * table that room owns, live off its stream and identical for every member; on
 * `/session` it draws the private canvas that session persists in this browser.
 *
 * Its own full-height flex column, because the right-panel slot wrapper is a
 * plain block container and each contribution must establish the flex context
 * its body needs to lock height and scroll (the same contract the docked profile
 * follows).
 */
export function CanvasContent() {
  const roomId = useAppStore((s) => s.roomCanvasLiveRoomId);
  return (
    <div data-slot="canvas" className="flex h-full flex-col overflow-hidden">
      {roomId ? <RoomCanvasBody roomId={roomId} view="canvas" /> : <CanvasBody view="canvas" />}
    </div>
  );
}

/**
 * The Browser tab's body — the same surface over the documents the embedded
 * browser renders (`url` and `browser`), with its own active document, and on a
 * room route over that room's shared table rather than this session's canvas.
 *
 * Registered only under a transport that can serve or proxy a page, so the
 * Obsidian shell drops the tab rather than showing one that could only error
 * (ADR 260911-200304).
 */
export function BrowserContent() {
  const roomId = useAppStore((s) => s.roomCanvasLiveRoomId);
  return (
    <div data-slot="browser" className="flex h-full flex-col overflow-hidden">
      {roomId ? <RoomCanvasBody roomId={roomId} view="browser" /> : <CanvasBody view="browser" />}
    </div>
  );
}
