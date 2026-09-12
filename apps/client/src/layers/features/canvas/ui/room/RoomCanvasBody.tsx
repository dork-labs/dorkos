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
import { useCallback, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import type { CanvasDocument } from '@dorkos/shared/room-schemas';
import type { UiCanvasContent } from '@dorkos/shared/types';
import type { AuthorRef } from '@dorkos/shared/room-schemas';
import { useRoom } from '@/layers/entities/room';
import type { CanvasView } from '@/layers/shared/lib';
import { roomDocumentsInView, useAppStore } from '@/layers/shared/model';
import {
  CanvasHeader,
  canvasPanelId,
  canvasTabDomId,
  type CanvasDocumentAuthor,
} from '../CanvasHeader';
import { CanvasErrorBoundary } from '../CanvasErrorBoundary';
import { CanvasRenderer } from '../CanvasRenderer';
import { CanvasSplash } from '../CanvasSplash';
import { RoomCanvasFileCard } from './RoomCanvasFileCard';
import { RoomCanvasMarkdown } from './RoomCanvasMarkdown';
import { roomDocumentReading } from '../../lib/room-canvas-reading';
import {
  roomCanvasRefusal,
  useRoomCanvasActions,
  useRoomCanvasViewing,
} from '../../model/use-room-canvas';

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
  const presence = useAppStore((s) => s.roomCanvasPresence[roomId]);
  const actions = useRoomCanvasActions(roomId);
  const room = useRoom(roomId);
  const viewerAuthorId = room.data?.viewerAuthorId ?? null;

  /**
   * Run one write and say so if the room refused it.
   *
   * A toast rather than something in the strip: these are pressed on a tab that
   * may be GONE a moment later (a close that half-worked, a pin on a document
   * somebody else just took away), so a message anchored to the tab would have
   * nowhere to live. The refusal is the server's own sentence.
   */
  const attempt = useCallback((what: string, run: () => Promise<void>) => {
    void run().catch((error: unknown) => {
      toast.error(what, { description: roomCanvasRefusal(error) });
    });
  }, []);

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
    const face = (author: AuthorRef): CanvasDocumentAuthor => ({
      id: author.id,
      displayName: author.displayName,
      kind: author.kind,
      ...(author.emoji ? { emoji: author.emoji } : {}),
      ...(author.color ? { color: author.color } : {}),
      ...(author.imageUrl ? { imageUrl: author.imageUrl } : {}),
    });
    // Who is on each document right now, from the room's live presence. **Never
    // this reader**: a face telling you where you already are is noise, and it
    // would sit on the one tab that needs no explaining.
    const watchersByDocument = new Map<string, CanvasDocumentAuthor[]>();
    for (const [authorId, documentId] of Object.entries(presence ?? {})) {
      if (authorId === viewerAuthorId) continue;
      const author = members.get(authorId);
      if (!author) continue;
      const held = watchersByDocument.get(documentId);
      if (held) held.push(face(author));
      else watchersByDocument.set(documentId, [face(author)]);
    }
    return inView.map((d) => {
      const author = members.get(d.authorId);
      const watchers = watchersByDocument.get(d.id);
      return {
        id: d.id,
        sourceLabel: tabLabel(d),
        contentType: d.content.type,
        pinned: d.pinned,
        unread: unreadIds?.includes(d.id) ?? false,
        ...(author ? { author: face(author) } : {}),
        ...(watchers ? { watchers } : {}),
      };
    });
  }, [inView, room.data, unreadIds, presence, viewerAuthorId]);

  // Tell the room where this viewer is looking, so their face appears on the tab
  // for everybody else. Only while this body is mounted — which is only while
  // its tab is the open one — so looking away is expressed by the unmount.
  useRoomCanvasViewing(roomId, active?.id ?? null);

  const panelId = canvasPanelId(view);

  return (
    <>
      <CanvasHeader
        view={view}
        documents={headerDocs}
        activeDocumentId={activeDocumentId}
        onActivate={(id) => activate(roomId, id)}
        onClose={(id) => attempt('Couldn’t take that off the canvas.', () => actions.close(id))}
        onPin={(id, pinned) =>
          attempt(pinned ? 'Couldn’t pin that.' : 'Couldn’t unpin that.', () =>
            actions.pin(id, pinned)
          )
        }
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
            <RoomCanvasDocumentBody
              roomId={roomId}
              document={active}
              onUpdate={(id, content) =>
                attempt('Couldn’t save that for the room.', () => actions.update(id, content))
              }
            />
          </CanvasErrorBoundary>
        ) : (
          // The same starting points a private canvas offers, with one
          // difference the person can see the moment they use one: what they
          // pick lands on the room's table, for everybody.
          <CanvasSplash
            view={view}
            onAction={(content) =>
              attempt('Couldn’t put that on the canvas.', () => actions.open(content))
            }
          />
        )}
      </div>
    </>
  );
}
