/**
 * "Somebody changed this room's files outside DorkOS" — the warning, and the
 * two ways out of it (spec `project-rooms` §3.10).
 *
 * A room's own copy has exactly one writer and it is the server. Anything
 * uncommitted in it therefore came from somewhere else — a person with a
 * terminal — and while it is there, every save in this room and every agent's
 * merge into it refuses. **Nothing else in the app would say so.** The explorer
 * keeps listing the files happily, because a listing is read from the last
 * commit and a stray edit does not move one; the only other signal is a refusal
 * a person meets after typing a page of text.
 *
 * So it is drawn where the files are, above them, and it says what is different
 * rather than only that something is. Loud degradation, never quiet corruption.
 *
 * **The two actions are asymmetric on purpose, and the asymmetry is the safety
 * rule.** Keeping loses nothing, so it sweeps up whatever is there and needs no
 * list. Discarding is the only irreversible act on this surface, so it destroys
 * nothing it was not handed by name — and every name has to be a change the
 * room is reporting right now, which is what stops a screen drawn ten minutes
 * ago from deleting something that arrived since.
 *
 * **Shown to whoever is looking, and refused by the server if they may not.**
 * This client cannot tell the install's owner from any other person — the same
 * gap `RoomLimitsSection` writes down, for the same reason — so hiding this on
 * a guess would hide it from the one person who can act on it. The refusal
 * becomes a sentence naming who can.
 *
 * @module features/file-explorer/ui/RoomMainWarning
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import type { RoomMainRepairRequest, RoomStrayChange } from '@dorkos/shared/room-repo';
import { useTransport } from '@/layers/shared/model';
import { Button, Checkbox } from '@/layers/shared/ui';
import { errorCodeOf } from '../lib/error-code';
import { roomKeys } from '@/layers/entities/room';
import { roomRepoStatusQueryOptions } from '../model/pending-work';

/** What each kind of stray change is called, in words a person uses. */
const STRAY_KIND_LABEL: Record<RoomStrayChange['kind'], string> = {
  added: 'added',
  modified: 'changed',
  deleted: 'deleted',
  untracked: 'new',
};

/** The sentence for each refusal a repair can come back with. */
const REPAIR_REFUSAL_COPY = new Map<string, string>([
  [
    'OPERATOR_ONLY',
    'Only the person who owns this DorkOS can decide what happens to those changes.',
  ],
  [
    'ROOM_FILE_NOT_FOUND',
    'One of those changes is not there any more, so nothing was discarded. The list below has been refreshed.',
  ],
  [
    'MERGE_IN_FLIGHT',
    'Something else is writing to this room’s files right now. Nothing was changed — try again in a moment.',
  ],
  [
    'MAIN_CHECKOUT_DIRTY',
    'This room’s files are on another branch, which DorkOS will not move for you. Put them back on main yourself.',
  ],
  [
    'ROOM_REPO_GIT_UNAVAILABLE',
    'This computer doesn’t have git installed, and a room’s files are a git repository.',
  ],
  ['ROOM_HAS_NO_REPO', 'This room does not have files of its own any more.'],
  ['ROOM_REPOS_DISABLED', 'Rooms cannot have files of their own on this install right now.'],
]);

/** What {@link RoomMainWarning} watches. */
export interface RoomMainWarningProps {
  /** The room whose own copy to check. */
  roomId: string;
}

/**
 * The room-level warning, or nothing at all when the room's files are as DorkOS
 * left them — which is nearly always.
 *
 * @param props - The room.
 */
export function RoomMainWarning({ roomId }: RoomMainWarningProps) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const status = useQuery(roomRepoStatusQueryOptions(transport, roomId));

  /** Which stray changes are ticked for discarding. Paths, as the room spells them. */
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const repair = useMutation({
    mutationFn: (req: RoomMainRepairRequest) => transport.repairRoomMain(roomId, req),
    onSuccess: () => {
      setChosen([]);
      setConfirmingDiscard(false);
      setRefusal(null);
      // `clean` is in the answer, and it is deliberately not what this reads:
      // the room is asked again instead, because a discard that named some of
      // the changes and not others leaves a shorter list to draw, not a
      // boolean.
      void queryClient.invalidateQueries({ queryKey: roomKeys.repoStatus(roomId) });
    },
    onError: (error) => {
      setConfirmingDiscard(false);
      const known = REPAIR_REFUSAL_COPY.get(errorCodeOf(error) ?? '');
      setRefusal(known ?? 'That didn’t work. Try again in a moment.');
      // A refusal is very often about the list being out of date — a path that
      // is no longer changed, a room somebody has since fixed — so the list is
      // re-asked whatever the reason.
      void queryClient.invalidateQueries({ queryKey: roomKeys.repoStatus(roomId) });
    },
  });

  // **A status this client could not read is not a clean room.** Drawing
  // nothing here would be indistinguishable from "everything is fine" — and a
  // save refused MAIN_CHECKOUT_DIRTY says in so many words that "the warning
  // above the files says how", which would be pointing at an empty space. So
  // the one thing that IS known gets said.
  //
  // `absent` is NOT this case and must never reach it: a room with no files of
  // its own is the ordinary answer, and it draws nothing at all.
  if (status.data?.kind === 'unavailable') {
    return (
      <p
        role="alert"
        data-slot="room-main-warning"
        className="border-border/60 text-muted-foreground rounded-lg border px-3 py-2.5 text-xs"
      >
        DorkOS couldn’t check whether this room’s files are in order. If saving here is refused,
        this is why — try again in a moment.
      </p>
    );
  }

  const main = status.data?.kind === 'ok' ? status.data.status.main : undefined;
  if (main === undefined || !main.dirty) return null;

  const wrongBranch = main.branch !== 'main';
  // Only ticks that still name something the room is reporting. The list is
  // re-read while this is open — a merge lands, somebody fixes their own
  // terminal edit — and a discard naming a path that has gone is refused
  // outright, which would lose the rest of the request with it.
  const selected = chosen.filter((path) => main.strays.some((stray) => stray.path === path));
  /**
   * Whether the "throw these away" question is actually up.
   *
   * Derived from the ask AND what is still ticked, not stored alone: the list
   * is re-read while this panel is open, and a refetch that empties the
   * selection left the question standing over nothing — pressing it sent
   * `paths: []`, which the schema refuses as a 400 nobody wrote copy for.
   * "Discard nothing" is not an action, so the question closes with its answer.
   */
  const askingDiscard = confirmingDiscard && selected.length > 0;
  const toggle = (path: string) =>
    setChosen((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]));

  return (
    <div
      role="alert"
      data-slot="room-main-warning"
      className="border-border/60 bg-muted/40 space-y-3 rounded-lg border px-3 py-2.5 text-sm"
    >
      <div className="flex gap-2">
        <AlertTriangle className="text-muted-foreground mt-0.5 size-(--size-icon-sm) flex-shrink-0" />
        <div className="min-w-0 space-y-1">
          <p className="font-medium">Somebody changed this room&apos;s files outside DorkOS</p>
          <p className="text-muted-foreground text-xs">
            {wrongBranch
              ? `This room’s files are on ${main.branch ?? 'no branch'} instead of main. Nobody can save a file here and no agent can merge into it until they are back on main — and DorkOS will not move a branch it did not move, in case there is work on it.`
              : 'Nobody can save a file here, and no agent can merge its work in, until these are dealt with.'}
          </p>
        </div>
      </div>

      {!wrongBranch && (
        <>
          <ul className="space-y-1.5">
            {main.strays.map((stray) => (
              <li key={stray.path} className="flex items-center gap-2">
                <Checkbox
                  id={`stray-${roomId}-${stray.path}`}
                  checked={selected.includes(stray.path)}
                  onCheckedChange={() => toggle(stray.path)}
                  disabled={repair.isPending}
                />
                <label
                  htmlFor={`stray-${roomId}-${stray.path}`}
                  className="min-w-0 flex-1 cursor-pointer truncate font-mono text-xs"
                  title={stray.path}
                >
                  {stray.path}
                </label>
                <span className="text-muted-foreground flex-shrink-0 text-xs">
                  {STRAY_KIND_LABEL[stray.kind]}
                </span>
              </li>
            ))}
          </ul>
          {main.strayCount > main.strays.length && (
            <p className="text-muted-foreground text-xs">
              …and {main.strayCount - main.strays.length} more, not listed here. Keeping them all
              still keeps every one.
            </p>
          )}

          {askingDiscard ? (
            <div className="space-y-2">
              <p className="text-xs">
                {selected.length === 1
                  ? 'Throw away that change? It cannot be brought back.'
                  : `Throw away those ${selected.length} changes? They cannot be brought back.`}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={repair.isPending}
                  onClick={() => setConfirmingDiscard(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={repair.isPending}
                  onClick={() => repair.mutate({ action: 'discard', paths: [...selected] })}
                >
                  Yes, discard
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={repair.isPending}
                onClick={() => repair.mutate({ action: 'commit' })}
              >
                Keep them all
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={repair.isPending || selected.length === 0}
                onClick={() => setConfirmingDiscard(true)}
              >
                {selected.length === 0 ? 'Discard…' : `Discard ${selected.length}`}
              </Button>
            </div>
          )}
        </>
      )}

      {refusal !== null && <p className="text-destructive text-xs">{refusal}</p>}
    </div>
  );
}
