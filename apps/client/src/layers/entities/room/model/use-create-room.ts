/**
 * Open a new room — a channel, or a direct message with one agent or several.
 *
 * @module entities/room/model/use-create-room
 */
import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import { toast } from 'sonner';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';

/**
 * Re-read every room list, roster and thread — and nothing else.
 *
 * A new room changes what the sidebar holds, so something has to refetch. It
 * used to be `roomKeys.all`, and that was a quiet data-loss bug: `all` is the
 * PREFIX `['rooms']`, which matches `['rooms','entries',<id>]` as well. So
 * creating a channel while a room was open discarded that room's history and
 * refetched it — and the read answers with the trailing page, so every entry
 * the live stream had merged beyond it was simply gone, with nothing that would
 * ever re-send it.
 *
 * The three keys below are every room read that a create can actually change.
 * A room's history is not one of them: it belongs to that room's own stream.
 *
 * @param queryClient - The cache to refresh.
 */
function invalidateRoomReads(queryClient: QueryClient): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: roomKeys.lists() }),
    queryClient.invalidateQueries({ queryKey: roomKeys.details() }),
    queryClient.invalidateQueries({ queryKey: roomKeys.threads() }),
  ]).then(() => undefined);
}

/** What a new channel is called, and who is in it from the start. */
export interface CreateChannelInput {
  /** What to call it. The server derives the `#slug` from this. */
  title: string;
  /**
   * The agents' directories — each one's stable identity across
   * re-registration. Empty is allowed and makes an empty channel, which is a
   * channel nothing will answer in until somebody is added to it.
   */
  agentPaths: string[];
}

/** Who a new direct message is with. */
export interface StartDirectMessageInput {
  /**
   * The agents' directories — each one's stable identity across
   * re-registration. One gives a one-to-one, several give a group.
   */
  agentPaths: string[];
  /** What to call the conversation; see `directMessageTitle`. */
  title: string;
}

/** Options for {@link useCreateChannel}. */
export interface UseCreateChannelOptions {
  /**
   * Whether the dialog's name field is still on screen to render a name
   * conflict inline.
   *
   * Read at failure time via a live callback rather than a snapshot, the same
   * contract as `useForkShape`'s `isInlineErrorVisible`: the mutation can
   * settle after its caller has unmounted, and a stale `true` closed over at
   * render time would swallow a failure nobody is left to show.
   */
  isInlineErrorVisible: () => boolean;
}

/**
 * True when `error` is the server's "that name is taken" refusal
 * (`SLUG_TAKEN`) — exported so the dialog can tell a conflict apart from
 * every other failure and render it inline at the field instead of leaving
 * it to the toast this hook falls back to.
 *
 * A type predicate rather than a plain boolean, so a caller that has already
 * checked it can read `error.message` without a second, redundant narrowing.
 *
 * @param error - The mutation's caught error, or `null`/`undefined`.
 */
export function isChannelNameConflict(error: unknown): error is Error & { code: string } {
  return (error as { code?: string } | null)?.code === 'SLUG_TAKEN';
}

/**
 * Create a channel, with the agents that are to be in it.
 *
 * The caller joins it, and its `#slug` is derived from the name unless the
 * server finds nothing sluggable in it.
 *
 * **One call, however many agents are named.** `POST /api/rooms` resolves every
 * agent path before it writes anything and then writes the room and its whole
 * roster in one transaction (`RoomService.createRoom`), which is the same
 * guarantee the direct-message flow relies on. So an agent that has since been
 * unregistered fails the request while the channel does not exist yet, and the
 * obvious retry works — rather than leaving behind a named, empty channel
 * holding a `#slug` that a retry would then collide with.
 *
 * **This hook reports its own failures**, `useForkShape`-style: a name
 * conflict is a validation error about the field the dialog is still showing,
 * so it belongs inline next to that field rather than in a toast — but
 * `meta.suppressErrorToast` is all-or-nothing per mutation, so there is no way
 * to suppress the shared toast for ONE error code and keep it for the rest.
 * The mutation opts out entirely and its own `onError` decides: stay quiet
 * when the field can still show the conflict, otherwise toast — every other
 * failure (a dropped connection, a 500) always toasts, matching what the
 * shared handler would have said.
 *
 * @param options - Whether the caller can still render a conflict inline.
 */
export function useCreateChannel({
  isInlineErrorVisible,
}: UseCreateChannelOptions): UseMutationResult<RoomWithRoster, Error, CreateChannelInput> {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ title, agentPaths }: CreateChannelInput) =>
      transport.createRoom({ kind: 'channel', title, members: [], agentPaths }),
    onSuccess: () => invalidateRoomReads(queryClient),
    meta: { suppressErrorToast: true },
    onError: (error) => {
      if (isChannelNameConflict(error) && isInlineErrorVisible()) return;
      toast.error(`Couldn't create that channel — ${error.message}`);
    },
  });
}

/**
 * Start a direct message with one agent, or with several at once.
 *
 * One call however many agents are in it. It used to be two — create, then join
 * by directory — because the create endpoint only seeded a roster from author
 * ids, and an agent that has never spoken has no author row to name. That made
 * a failed second call leave a direct message with nobody in it: a room named
 * after an agent the agent was not in, which retrying could not repair because
 * the room already existed. `agentPaths` resolves inside the same transaction,
 * so either the whole conversation exists or none of it does.
 *
 * Asking twice for the same people is safe: the server matches a direct message
 * on its exact member set and answers with the conversation you already have
 * rather than a second one beside it (`RoomService.createRoom`). So nothing here
 * has to know which conversations exist before offering to open one.
 *
 * **The failure is reported from the mutation, not from the call site**
 * (DOR-1391). It used to suppress the shared toast so that `NewMenu` could name
 * the people in its own `mutate(vars, { onError })` callback — richer wording,
 * and a report that could simply not arrive: TanStack dispatches a per-call
 * callback only while the observer still has listeners, so closing the sidebar
 * sheet on a phone mid-flight left the failure entirely unsaid. `meta.errorLabel`
 * runs on the mutation itself and always reaches the person; the server's own
 * sentence follows it ("Couldn't start that conversation — …"), which is more
 * than the name would have added.
 */
export function useStartDirectMessage(): UseMutationResult<
  RoomWithRoster,
  Error,
  StartDirectMessageInput
> {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ agentPaths, title }: StartDirectMessageInput) =>
      transport.createRoom({ kind: 'dm', title, members: [], agentPaths }),
    onSettled: () => invalidateRoomReads(queryClient),
    meta: { errorLabel: "Couldn't start that conversation" },
  });
}
