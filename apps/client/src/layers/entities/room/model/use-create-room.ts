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
 */
export function useCreateChannel(): UseMutationResult<RoomWithRoster, Error, CreateChannelInput> {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ title, agentPaths }: CreateChannelInput) =>
      transport.createRoom({ kind: 'channel', title, members: [], agentPaths }),
    onSuccess: () => invalidateRoomReads(queryClient),
    // The shared mutation toast (`query-client.ts`) reads this with the
    // server's own sentence after it — the dialog's own onError used to
    // duplicate the same message in a second toast.
    meta: { errorLabel: "Couldn't create that channel" },
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
    // Its one caller (`NewMenu.tsx`, outside this task's remit) names who the
    // conversation was with in its own onError — richer than a static label —
    // so this opts the shared mutation toast out rather than duplicating it.
    meta: { suppressErrorToast: true },
  });
}
