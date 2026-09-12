/**
 * A document on a room's table that names a file rather than carrying one (spec
 * `room-canvas` §8, §8.1, §10).
 *
 * Two answers, and the difference is whether this app has a route to the bytes:
 *
 * - **The room's own files.** The card opens them in the source editor the Room
 *   tab's Files section already uses — the file's own text, saved as one commit
 *   with the person's name on it. Never a rich editor: a room's files are a git
 *   repo whose whole point is honest diffs, and a round-trip through a document
 *   model would commit a reformat nobody typed.
 * - **Somebody else's copy.** The card says so in one sentence and offers
 *   nothing, because a canvas document must never become a way to read a tree
 *   you could not already read.
 *
 * @module features/canvas/ui/room/RoomCanvasFileCard
 */
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FileCode } from 'lucide-react';
import type { CanvasDocument } from '@dorkos/shared/room-schemas';
import { createRoomFilesSource, FilePreviewDialog } from '@/layers/features/file-explorer';
import { useTransport } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import type { RoomDocumentReading } from '../../lib/room-canvas-reading';

/** What {@link RoomCanvasFileCard} shows. */
export interface RoomCanvasFileCardProps {
  /** The room the document is on. */
  roomId: string;
  /** The document. */
  document: CanvasDocument;
  /** Which of the two answers this is — decided by {@link roomDocumentReading}. */
  reading: Extract<RoomDocumentReading, { kind: 'room-file' | 'elsewhere' }>;
}

/**
 * The card for a file document, with the door into the room's file editor when
 * there is one.
 *
 * @param props - The room, the document, and what this viewer may do with it.
 */
export function RoomCanvasFileCard({ roomId, document, reading }: RoomCanvasFileCardProps) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [openPath, setOpenPath] = useState<string | null>(null);

  const source = useMemo(
    () => createRoomFilesSource({ transport, queryClient, roomId }),
    [transport, queryClient, roomId]
  );

  return (
    <div className="flex h-full items-start justify-center p-6">
      <div className="bg-card shadow-soft w-full max-w-md space-y-3 rounded-lg border p-4">
        <div className="flex items-center gap-2">
          <FileCode className="text-muted-foreground size-4 shrink-0" />
          <span className="truncate text-sm font-medium">
            {document.title || reading.sourcePath}
          </span>
        </div>
        <p className="text-muted-foreground font-mono text-xs break-all">{reading.sourcePath}</p>
        {reading.kind === 'elsewhere' ? (
          <p className="text-muted-foreground text-sm leading-relaxed">{reading.sentence}</p>
        ) : (
          <>
            <p className="text-muted-foreground text-sm leading-relaxed">
              This file is in the room’s files. Changes you save here become one commit with your
              name on it.
            </p>
            <Button type="button" size="sm" onClick={() => setOpenPath(reading.sourcePath)}>
              Open file
            </Button>
          </>
        )}
      </div>
      {reading.kind === 'room-file' && (
        <FilePreviewDialog source={source} path={openPath} onClose={() => setOpenPath(null)} />
      )}
    </div>
  );
}
