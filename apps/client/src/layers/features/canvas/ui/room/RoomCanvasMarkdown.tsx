/**
 * A room document made of markdown the room owns (spec `room-canvas` §10).
 *
 * These belong to the room rather than to a file — an agent's write-up, a set of
 * notes somebody started — so the rich editor is the right one and there is
 * somewhere for a save to go: the document itself, changed for every member at
 * once. A markdown document that names a FILE never reaches here; that is the
 * source editor's job, because a rich editor round-trips markdown through its
 * own document model and would commit a reformat nobody typed.
 *
 * **Editing takes the room's edit lock.** While it is held, an agent's update to
 * this same document is held rather than applied and the agent is told so, and a
 * heartbeat every fifteen seconds is what keeps it — so a browser that crashed
 * mid-edit stops being a lock on its own instead of wedging the document. Other
 * documents on the table stay agent-writable throughout.
 *
 * @module features/canvas/ui/room/RoomCanvasMarkdown
 */
import { lazy, Suspense, useState } from 'react';
import { Check, Pencil } from 'lucide-react';
import type { CanvasDocument } from '@dorkos/shared/room-schemas';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { Button } from '@/layers/shared/ui';
import { useRoomCanvasEditLock } from '../../model/use-room-canvas';

const BlintzCanvas = lazy(() =>
  import('../BlintzCanvas').then((m) => ({ default: m.BlintzCanvas }))
);

/** What {@link RoomCanvasMarkdown} shows. */
export interface RoomCanvasMarkdownProps {
  /** The room the document is on. */
  roomId: string;
  /** The document, as the room's table holds it. */
  document: CanvasDocument;
  /** The markdown it carries. */
  content: Extract<UiCanvasContent, { type: 'markdown' }>;
  /** Replace what this document shows, for every member. */
  onSave: (documentId: string, content: UiCanvasContent) => void;
}

/**
 * Markdown the room owns, read-only until somebody picks up the pencil.
 *
 * A document read out of a file is shown but never edited here — its editor is
 * the source one, and this component is only ever handed a generated document.
 *
 * @param props - The room, the document, its markdown, and where a save goes.
 */
export function RoomCanvasMarkdown({ roomId, document, content, onSave }: RoomCanvasMarkdownProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  // Read out of a file: shown, never edited here — the file's own tree is what
  // a save would have to reach, and this is not the editor that can.
  const editable = content.sourcePath === undefined;

  useRoomCanvasEditLock(roomId, editing ? document.id : null);

  const save = () => {
    if (draft !== null && draft !== content.content) {
      onSave(document.id, { ...content, content: draft });
    }
    setDraft(null);
  };

  return (
    <div className="flex h-full flex-col">
      {editable && (
        <div className="flex items-center justify-end gap-2 border-b px-2 py-1">
          {editing && (
            <span className="text-muted-foreground text-xs">Everyone sees your save.</span>
          )}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-label={editing ? 'Save for the room' : 'Edit this document'}
            onClick={() => (editing ? save() : setDraft(content.content))}
          >
            {editing ? <Check className="size-3.5" /> : <Pencil className="size-3.5" />}
          </Button>
        </div>
      )}
      {/* The same padded box the session's markdown viewer gives Blintz: the
          editor sizes to its own content, so a flex child with no padding draws
          a hard-edged white band across a grey panel. */}
      <div className="flex-1 px-2 pb-6">
        <Suspense fallback={<div className="text-muted-foreground p-4 text-sm">Loading…</div>}>
          <BlintzCanvas
            // Re-seed when the room's copy changes underneath a reader: the
            // document's own revision is what moved, and keying on it is what
            // makes another member's update land on screen.
            key={editing ? 'editing' : `rev-${document.rev}`}
            value={draft ?? content.content}
            editable={editing}
            onChange={setDraft}
          />
        </Suspense>
      </div>
    </div>
  );
}
