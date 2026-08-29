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
 * worse than the absence. The room says so itself, and that answer is the whole
 * gate — as a listing marked `absent` rather than as a refusal, so that opening
 * an ordinary room is not an error anything has to log.
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

  // Only "this room has no files of its own" hides the section, and it arrives
  // as a LISTING that says so rather than as a rejection — see the source's
  // `list`. Anything else — the room is unreachable, this machine has no git —
  // is a real failure, and the section stays to say so where the tree would
  // have been, with the retry the explorer offers.
  const answered = (root.isSuccess && root.data.absent !== true) || root.isError;

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
          the limits off the bottom of it.

          **The height is DEFINITE (`h-72`), not a maximum, and it has to be.**
          The tree inside owns its own scroll — that is where the saved offset
          is restored to and where the virtualizer measures its window — and
          `height: 100%` against an auto-height containing block computes to
          auto. Under `max-h-*` the tree would grow to its full content height
          and never scroll: past a hundred rows the virtualizer would render
          every one of them, and the offset a person left the panel at would
          have nowhere to be restored to. A fixed box costs an empty strip
          under a room with three files; the alternative costs correctness. */}
      <div
        data-slot="room-files-body"
        className="border-border/60 h-72 overflow-hidden rounded-lg border"
      >
        <FileExplorer source={source} />
      </div>
    </section>
  );
}
