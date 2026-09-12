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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { CanvasDocument } from '@dorkos/shared/room-schemas';
import type { UiCanvasContent } from '@dorkos/shared/types';
import {
  useFollowedView,
  useRoom,
  useRoomFollowClaim,
  useRoomOpenThreadStore,
  useRoomViewPublish,
} from '@/layers/entities/room';
import type { CanvasView } from '@/layers/shared/lib';
import { roomDocumentsInView, useAppStore, useTransport } from '@/layers/shared/model';
import { CanvasHeader, canvasPanelId, canvasTabDomId } from '../CanvasHeader';
import { CanvasErrorBoundary } from '../CanvasErrorBoundary';
import { CanvasRenderer } from '../CanvasRenderer';
import { CanvasSplash } from '../CanvasSplash';
import { RoomCanvasChrome, type FollowableMember } from './RoomCanvasChrome';
import { RoomCanvasFileCard } from './RoomCanvasFileCard';
import { RoomCanvasMarkdown } from './RoomCanvasMarkdown';
import { roomDocumentReading } from '../../lib/room-canvas-reading';
import { roomCanvasRefusal, useRoomCanvasActions } from '../../model/use-room-canvas';

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
  /** Replace what this document shows, answering whether the room took it. */
  onUpdate: (documentId: string, content: UiCanvasContent) => Promise<boolean>;
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
  const transport = useTransport();
  const viewerAuthorId = room.data?.viewerAuthorId ?? null;
  const editingDocumentId = useAppStore((s) => s.roomCanvasEditing[roomId] ?? null);
  const openThread = useRoomOpenThreadStore((s) => s.openThread);
  const [discussing, setDiscussing] = useState(false);

  // Following is the BROWSER tab's control: it is somebody's browser you follow,
  // and the Canvas tab is where the other twelve kinds of document live. Passing
  // `null` on the Canvas tab is what keeps the claim from being held twice by
  // the two bodies this component renders.
  const followRoomId = view === 'browser' ? roomId : null;
  const { following, follow, stop } = useRoomFollowClaim(followRoomId);
  const followedView = useFollowedView(followRoomId);

  /**
   * The panel the document scrolls in — read to share a position, written to
   * apply one.
   *
   * A ref rather than a `getElementById`, so two views rendering the same
   * component never reach into each other's panel.
   */
  const panel = useRef<HTMLDivElement>(null);

  /**
   * Run one write, say so if the room refused it, and tell the caller which
   * happened.
   *
   * A toast rather than something in the strip: these are pressed on a tab that
   * may be GONE a moment later (a close that half-worked, a pin on a document
   * somebody else just took away), so a message anchored to the tab would have
   * nowhere to live. The refusal is the server's own sentence.
   *
   * **It resolves to whether the write landed, and never rejects.** A caller
   * holding something the person cannot get back — an editor holding a draft —
   * has to know, and a rejected promise from a click handler would be an
   * unhandled rejection for every caller that does not.
   */
  const attempt = useCallback(async (what: string, run: () => Promise<void>): Promise<boolean> => {
    try {
      await run();
      return true;
    } catch (error) {
      toast.error(what, { description: roomCanvasRefusal(error) });
      return false;
    }
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

  /** Everybody else in this room who is a person. Agents never appear. */
  const people = useMemo<FollowableMember[]>(
    () =>
      (room.data?.members ?? [])
        .map((member) => member.author)
        .filter((author) => author.kind === 'human' && author.id !== viewerAuthorId)
        .map((author) => ({
          id: author.id,
          displayName: author.displayName,
          kind: author.kind,
          emoji: author.emoji,
          color: author.color,
          imageUrl: author.imageUrl,
        })),
    [room.data, viewerAuthorId]
  );

  // What this viewer's own browser is showing, which is not the same as the
  // document's stored page: Back and Forward move inside the frame without
  // telling the room, and a follower should go where the person really is.
  const shownUrl = useAppStore((s) => {
    if (activeDocumentId === null) return undefined;
    const held = s.browserHistories[activeDocumentId];
    return held ? held.stack[held.cursor] : undefined;
  });

  const readScrollY = useCallback(() => panel.current?.scrollTop ?? 0, []);
  const subscribeToScroll = useCallback((onMoved: () => void) => {
    const element = panel.current;
    if (!element) return () => {};
    element.addEventListener('scroll', onMoved, { passive: true });
    return () => element.removeEventListener('scroll', onMoved);
  }, []);

  useRoomViewPublish({
    roomId: followRoomId,
    viewerAuthorId,
    documentId: activeDocumentId,
    url: shownUrl,
    readScrollY,
    subscribe: subscribeToScroll,
  });

  // Go where the person being followed is. Two rules bound it: a document this
  // viewer cannot see in this view is not somewhere to go, and a viewer who is
  // EDITING is never moved off what they are typing in — room-canvas §9.3
  // outranks following, because losing a draft is worse than losing the thread.
  const documentIds = useMemo(() => inView.map((d) => d.id).join('\u0000'), [inView]);
  useEffect(() => {
    if (followedView === null || editingDocumentId !== null) return;
    if (
      followedView.documentId !== activeDocumentId &&
      documentIds.split('\u0000').includes(followedView.documentId)
    ) {
      activate(roomId, followedView.documentId);
    }
    if (followedView.scrollY !== undefined && panel.current) {
      panel.current.scrollTop = followedView.scrollY;
    }
  }, [followedView, editingDocumentId, activeDocumentId, documentIds, activate, roomId]);

  /**
   * Open the open document's discussion, and show it.
   *
   * The server decides whether this starts a thread or opens the one that is
   * already there, so pressing it twice — or two people pressing it at once —
   * lands everybody in one conversation.
   */
  const discuss = useCallback(() => {
    if (active === null) return;
    setDiscussing(true);
    void transport
      .discussCanvasDocument(roomId, active.id)
      .then((thread) => openThread(roomId, thread.threadRootEntryId, false))
      .catch((error: unknown) => {
        toast.error('Couldn’t start a discussion.', { description: roomCanvasRefusal(error) });
      })
      .finally(() => setDiscussing(false));
  }, [active, transport, roomId, openThread]);

  const panelId = canvasPanelId(view);

  return (
    <>
      <CanvasHeader
        view={view}
        documents={headerDocs}
        activeDocumentId={activeDocumentId}
        onActivate={(id) => activate(roomId, id)}
        onClose={(id) =>
          void attempt('Couldn’t take that off the canvas.', () => actions.close(id))
        }
        onPin={(id, pinned) =>
          void attempt(pinned ? 'Couldn’t pin that.' : 'Couldn’t unpin that.', () =>
            actions.pin(id, pinned)
          )
        }
      />
      <RoomCanvasChrome
        sourceLabel={active?.sourceLabel}
        people={view === 'browser' ? people : []}
        following={following}
        onFollow={follow}
        onStopFollowing={stop}
        onDiscuss={active === null ? undefined : discuss}
        discussing={discussing}
      />
      <div
        id={panelId}
        ref={panel}
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
              void attempt('Couldn’t put that on the canvas.', () => actions.open(content))
            }
          />
        )}
      </div>
    </>
  );
}
