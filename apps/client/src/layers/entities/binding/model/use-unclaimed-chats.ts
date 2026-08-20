import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClaimUnclaimedChatRequest, UnclaimedChatStatus } from '@dorkos/shared/relay-schemas';
import { useEventSubscription, useTransport } from '@/layers/shared/model';
import { BINDINGS_QUERY_KEY } from './use-bindings';

/** Query key root for the claim feed. */
export const UNCLAIMED_CHATS_QUERY_KEY = ['relay', 'unclaimed-chats'] as const;

/** Query key for one slice of the claim feed. */
export function unclaimedChatsKey(status: UnclaimedChatStatus) {
  return [...UNCLAIMED_CHATS_QUERY_KEY, status] as const;
}

/**
 * Read the chats that reached an adapter with no agent set to answer them.
 *
 * The rows carry who wrote and when, never what they wrote — an unclaimed
 * chat never starts a turn, so nothing a stranger sends is ever read by a
 * model or rendered as content.
 *
 * @param status - Which slice to read. Defaults to the undecided ones.
 * @param enabled - Skip the request entirely when messaging is turned off.
 */
export function useUnclaimedChats(status: UnclaimedChatStatus = 'pending', enabled = true) {
  const transport = useTransport();
  return useQuery({
    queryKey: unclaimedChatsKey(status),
    queryFn: () => transport.listUnclaimedChats(status),
    enabled,
  });
}

/**
 * Keep the claim feed fresh across clients and tabs.
 *
 * The server broadcasts `relay_chat_unclaimed` once per newly-seen chat (repeat
 * messages from a chat already listed are counted silently, so this does not
 * fire per message) and `relay_chat_unclaimed_burst` once per window when many
 * different chats arrive at once. Both mean the same thing here: refetch.
 *
 * Mount once, on the surface that renders the feed.
 */
export function useUnclaimedChatsSync(): void {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: [...UNCLAIMED_CHATS_QUERY_KEY] });
  };
  useEventSubscription('relay_chat_unclaimed', invalidate);
  useEventSubscription('relay_chat_unclaimed_burst', invalidate);
}

/**
 * Invalidate every claim-feed slice — a decision on one chat moves it between
 * slices, so no single key is enough.
 */
function invalidateFeed(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: [...UNCLAIMED_CHATS_QUERY_KEY] });
}

/**
 * Set the agent that answers an unclaimed chat, creating the binding that
 * routes it. Rejects with `CHAT_ALREADY_BOUND` when another binding took the
 * chat in the meantime — the same refusal any binding create would give.
 *
 * `input.bridge: true` is "Answer in a channel" — the claim, the binding, and
 * the bridge happen in one call, and the resolved binding's `roomId` is where
 * to land the person. The claim always resolves even when the bridge step
 * cannot complete; a `bridgeError` on the result names why, rather than the
 * mutation rejecting over a chat that was, in fact, answered.
 */
export function useClaimUnclaimedChat() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ClaimUnclaimedChatRequest }) =>
      transport.claimUnclaimedChat(id, input),
    // A chat already claimed by someone else is a question, not a failure —
    // `ClaimFeed.tsx`'s own onError tells the two apart and opens
    // `MoveChatDialog` for the former, so the shared mutation toast has to
    // stay out of it entirely rather than firing underneath that dialog. A
    // genuine failure still gets exactly one report: `ClaimFeed`'s own
    // fallback toast, same words this used to hand the shared one.
    meta: { suppressErrorToast: true },
    onSuccess: () => {
      invalidateFeed(queryClient);
      void queryClient.invalidateQueries({ queryKey: [...BINDINGS_QUERY_KEY] });
    },
  });
}

/** Mute an unclaimed chat: it stops surfacing, its traffic is still counted. */
export function useIgnoreUnclaimedChat() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => transport.ignoreUnclaimedChat(id),
    meta: { errorLabel: "Couldn't ignore this chat" },
    onSuccess: () => invalidateFeed(queryClient),
  });
}

/** Block an unclaimed chat: nothing further from it is recorded at all. */
export function useBlockUnclaimedChat() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => transport.blockUnclaimedChat(id),
    meta: { errorLabel: "Couldn't block this chat" },
    onSuccess: () => invalidateFeed(queryClient),
  });
}

/**
 * Leave an unclaimed chat's group on its platform — the group-add claim
 * flow's "Leave" action (DOR-883). A real removal: the bot stops being a
 * member of the chat, and no room or binding was ever created for it.
 * Rejects, rather than settling, when the underlying adapter cannot leave a
 * chat — the card is left exactly as it was rather than being dismissed over
 * a leave that did not happen.
 */
export function useLeaveUnclaimedChat() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => transport.leaveUnclaimedChat(id),
    meta: { errorLabel: "Couldn't leave this chat" },
    onSuccess: () => invalidateFeed(queryClient),
  });
}
