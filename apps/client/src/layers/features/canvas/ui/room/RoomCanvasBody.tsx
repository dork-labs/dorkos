/**
 * One room's shared table, in the Canvas or Browser tab (spec `room-canvas` §9).
 *
 * The same tab strip and the same viewers a private session canvas uses, over
 * documents the SERVER owns: every member sees the same set, a reload restores
 * it from the room's own stream, and closing something here takes it off
 * everybody's table rather than this browser's.
 *
 * Three differences from the session body, and each is the point:
 *
 * - **Every write is a request, never a local mutation.** Opening, changing,
 *   pinning and closing all go to the room and come back as a `canvas` frame.
 *   Nothing here patches the slice, so what this viewer sees is always what
 *   everyone else sees.
 * - **A tab says who put it there** — the author's face, and for a file the line
 *   saying whose copy of the files it came out of.
 * - **Nothing steals focus.** Arriving on this tab marks what arrived as looked
 *   at; while the reader is elsewhere, an arrival lights a dot and moves no tab.
 *
 * @module features/canvas/ui/room/RoomCanvasBody
 */
import { useEffect, useMemo } from 'react';
import type { CanvasDocument } from '@dorkos/shared/room-schemas';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { useRoom } from '@/layers/entities/room';
import type { CanvasView } from '@/layers/shared/lib';
import { roomDocumentsInView, useAppStore } from '@/layers/shared/model';
import { CanvasHeader, canvasPanelId, canvasTabDomId } from '../CanvasHeader';
import { CanvasErrorBoundary } from '../CanvasErrorBoundary';
import { CanvasRenderer } from '../CanvasRenderer';
import { CanvasSplash } from '../CanvasSplash';
import { RoomCanvasFileCard } from './RoomCanvasFileCard';
import { RoomCanvasMarkdown } from './RoomCanvasMarkdown';
import { roomDocumentReading } from '../../lib/room-canvas-reading';
import { useRoomCanvasActions } from '../../model/use-room-canvas';

/** What a document's tab says it is, when nothing named it. */
function tabLabel(document: CanvasDocument): string {
  return document.title || document.contentType;
}

/**
 * Draw one document of a room's table.
 *
 * A shape whose content travelled in the row goes straight to the shared viewer
 * dispatch. A shape that names a FILE does not: its bytes live in a tree, and
 * which tree decides whether this member may open it at all (§8.1).
 */
function RoomCanvasDocumentBody({
  roomId,
  document,
  onUpdate,
}: {
  roomId: string;
  document: CanvasDocument;
  onUpdate: (documentId: string, content: UiCanvasContent) => void;
}) {
  const reading = roomDocumentReading(document);
  if (reading.kind !== 'inline') {
    return <RoomCanvasFileCard roomId={roomId} document={document} reading={reading} />;
  }
  // Markdown is the one shape a person can change in place here, so it has its
  // own surface: the save goes to the room rather than to a file, and holds the
  // edit lock while it is open.
  if (document.content.type === 'markdown') {
    return (
      <RoomCanvasMarkdown
        roomId={roomId}
        document={document}
        content={document.content}
        onSave={onUpdate}
      />
    );
  }
  return (
    <CanvasRenderer
      documentId={document.id}
      content={document.content}
      // Everything else on a room's table is read-only here: its content is the
      // server's, and the two surfaces that CAN change one — the markdown editor
      // above and the Browser tab's address bar — write to the room instead.
      onContentChange={() => {}}
    />
  );
}

/** What {@link RoomCanvasBody} draws. */
export interface RoomCanvasBodyProps {
  /** The room whose table this is. */
  roomId: string;
  /** Which of the two views is rendering. */
  view: CanvasView;
}

/**
 * The Canvas or Browser tab over one room's shared table.
 *
 * @param props - The room and the view.
 */
export function RoomCanvasBody({ roomId, view }: RoomCanvasBodyProps) {
  const documents = useAppStore((s) => s.roomCanvasDocuments[roomId]);
  const activeDocumentId = useAppStore((s) => s.roomCanvasActive[roomId]?.[view] ?? null);
  const unreadIds = useAppStore((s) => s.roomCanvasUnread[roomId]?.[view]);
  const activate = useAppStore((s) => s.activateRoomCanvasDocument);
  const clearUnread = useAppStore((s) => s.clearRoomCanvasUnread);
  const actions = useRoomCanvasActions(roomId);
  const room = useRoom(roomId);

  const inView = useMemo(() => roomDocumentsInView(documents ?? [], view), [documents, view]);
  const active = inView.find((d) => d.id === activeDocumentId) ?? null;

  // Looking at the tab IS reading it. The dot exists to say "something arrived
  // while you were elsewhere", so it has no business surviving the moment the
  // reader is here — and this body only mounts while its tab is the open one.
  const unreadCount = unreadIds?.length ?? 0;
  useEffect(() => {
    if (unreadCount > 0) clearUnread(roomId, view);
  }, [unreadCount, clearUnread, roomId, view]);

  const headerDocs = useMemo(() => {
    const members = new Map(room.data?.members.map((m) => [m.author.id, m.author]) ?? []);
    return inView.map((d) => {
      const author = members.get(d.authorId);
      return {
        id: d.id,
        sourceLabel: tabLabel(d),
        contentType: d.content.type,
        pinned: d.pinned,
        unread: unreadIds?.includes(d.id) ?? false,
        ...(author
          ? {
              author: {
                id: author.id,
                displayName: author.displayName,
                kind: author.kind,
                ...(author.emoji ? { emoji: author.emoji } : {}),
                ...(author.color ? { color: author.color } : {}),
                ...(author.imageUrl ? { imageUrl: author.imageUrl } : {}),
              },
            }
          : {}),
      };
    });
  }, [inView, room.data, unreadIds]);

  const panelId = canvasPanelId(view);

  return (
    <>
      <CanvasHeader
        view={view}
        documents={headerDocs}
        activeDocumentId={activeDocumentId}
        onActivate={(id) => activate(roomId, id)}
        onClose={actions.close}
        onPin={actions.pin}
      />
      {/* Whose copy of the files this document came out of — a snapshot taken
          when it was opened, never a live count, which is why it is stated
          rather than refreshed. Nothing is drawn for a document in the room's
          own shared copy: that is the ordinary case. */}
      {active?.sourceLabel && (
        <p className="text-muted-foreground border-b px-3 py-1 text-xs">{active.sourceLabel}</p>
      )}
      <div
        id={panelId}
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-auto focus-visible:outline-none"
        {...(active ? { role: 'tabpanel', 'aria-labelledby': canvasTabDomId(active.id) } : {})}
      >
        {active ? (
          <CanvasErrorBoundary key={active.id} documentId={active.id}>
            <RoomCanvasDocumentBody roomId={roomId} document={active} onUpdate={actions.update} />
          </CanvasErrorBoundary>
        ) : (
          // The same starting points a private canvas offers, with one
          // difference the person can see the moment they use one: what they
          // pick lands on the room's table, for everybody.
          <CanvasSplash view={view} onAction={actions.open} />
        )}
      </div>
    </>
  );
}
