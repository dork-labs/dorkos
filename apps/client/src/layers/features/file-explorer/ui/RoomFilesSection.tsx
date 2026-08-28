/**
 * A room's own files, in the room panel (spec `project-rooms` §3.9).
 *
 * The same explorer the Files tab is, over a different source: read-only,
 * because what it lists is the commit `main` points at rather than files on a
 * disk, and carrying the provenance a commit can answer and a filesystem
 * cannot.
 *
 * **A room without files of its own shows nothing at all** — not an empty
 * state, not a "no files yet" invitation. Most rooms are conversations and
 * always will be; a section explaining its own absence in every one of them is
 * worse than the absence. The room says so itself, with `ROOM_HAS_NO_REPO`, and
 * that answer is the whole gate.
 *
 * @module features/file-explorer/ui/RoomFilesSection
 */
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderGit2 } from 'lucide-react';
import { useTransport } from '@/layers/shared/model';
import { useFileExplorerStore } from '../model/file-explorer-store';
import { createRoomFilesSource } from '../model/room-files-source';
import { explorerDirQueryOptions } from '../model/source';
import { ROOT_KEY } from '../model/tree';
import { errorCodeOf, ROOM_HAS_NO_REPO_CODE } from '../lib/error-code';
import { FileExplorer } from './FileExplorer';
import { HiddenEntriesToggle } from './HiddenEntriesToggle';

/** What {@link RoomFilesSection} browses. */
export interface RoomFilesSectionProps {
  /** The room whose files to show. */
  roomId: string;
}

/**
 * The Files section of the room panel, or nothing at all.
 *
 * @param props - The room.
 */
export function RoomFilesSection({ roomId }: RoomFilesSectionProps) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const showHidden = useFileExplorerStore((s) => s.showHidden);

  const source = useMemo(
    () => createRoomFilesSource({ transport, queryClient, roomId }),
    [transport, queryClient, roomId]
  );

  // The same query the explorer's own root level asks, by the same options — so
  // this is one request answering two questions rather than a probe of its own:
  // "does this room have files" and "what is in them" have the same answer.
  const root = useQuery(explorerDirQueryOptions(source, ROOT_KEY, showHidden, queryClient));

  // Only "this room has no files of its own" hides the section. Anything else
  // — the room is unreachable, this machine has no git — is a real failure, and
  // the section stays to say so where the tree would have been.
  const answered =
    root.isSuccess || (root.isError && errorCodeOf(root.error) !== ROOM_HAS_NO_REPO_CODE);

  // Sticky, and it has to be. The listing below is the SAME cache entry this
  // query is, so mounting the tree adds a second reader of it — and a second
  // reader arriving on a stale entry refetches, which puts the entry back into
  // pending. Re-deciding on that would unmount the tree, which would settle the
  // entry, which would mount it again: a loop with no fixed point. Once a room
  // has answered that it has files, it has files.
  //
  // Adjusted during render rather than in an effect, which is what React asks
  // for when new state is derived from new props: the extra pass happens before
  // anything is committed, so nothing renders with the stale answer.
  const [answeredRoomId, setAnsweredRoomId] = useState<string | null>(null);
  if (answered && answeredRoomId !== roomId) setAnsweredRoomId(roomId);
  if (!answered && answeredRoomId !== roomId) return null;

  return (
    <section aria-label="Room files" className="space-y-2">
      <header className="flex items-center gap-2">
        <FolderGit2 className="text-muted-foreground size-(--size-icon-sm) flex-shrink-0" />
        <h3 className="text-muted-foreground flex-1 text-xs font-medium tracking-wide uppercase">
          Files
        </h3>
        <HiddenEntriesToggle />
      </header>
      {/* Bounded rather than free-growing: this is one section of a scrolling
          panel, so a repo with three hundred files must not push the roster and
          the limits off the bottom of it. The scroll lives HERE rather than on
          the tree — this box has a max height and no fixed one, so the tree
          inside it has no definite height to scroll within, and clipping it
          without scrolling would put the three hundredth file out of reach. */}
      <div className="border-border/60 max-h-72 min-h-16 overflow-y-auto rounded-lg border">
        <FileExplorer source={source} />
      </div>
    </section>
  );
}
