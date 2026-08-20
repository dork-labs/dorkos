import { useState } from 'react';
import { toast } from 'sonner';
import { useNavigate } from '@tanstack/react-router';
import { Skeleton } from '@/layers/shared/ui';
import {
  useUnclaimedChats,
  useUnclaimedChatsSync,
  useClaimUnclaimedChat,
  useIgnoreUnclaimedChat,
  useBlockUnclaimedChat,
  useLeaveUnclaimedChat,
  MoveChatDialog,
  readChatConflict,
  type ChatConflict,
} from '@/layers/entities/binding';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { ClaimCard } from './ClaimCard';

/**
 * Chats waiting on a decision.
 *
 * A bot on Telegram or Slack is findable by anyone, so a message can arrive
 * from someone you never set up. DorkOS records that it happened and stops
 * there: no agent runs, nothing is spent, and the bot stays silent until you
 * say who should answer. This is the list of those, and it renders nothing at
 * all when there is nothing waiting.
 *
 * @param props - Whether messaging is on at all.
 * @param props.enabled - False turns the whole feed off, request included.
 */
export function ClaimFeed({ enabled }: { enabled: boolean }) {
  useUnclaimedChatsSync();
  const { data: chats, isLoading } = useUnclaimedChats('pending', enabled);
  const { data: agentsData } = useRegisteredAgents();
  const claim = useClaimUnclaimedChat();
  const ignore = useIgnoreUnclaimedChat();
  const block = useBlockUnclaimedChat();
  const leave = useLeaveUnclaimedChat();
  const navigate = useNavigate();
  // A chat can be taken between the card rendering and the decision landing.
  // The refusal names who has it, so the answer is an offer to move it.
  const [conflict, setConflict] = useState<ChatConflict | null>(null);

  const agentOptions = agentsData?.agents ?? [];
  const pending = chats ?? [];
  const isDeciding = claim.isPending || ignore.isPending || block.isPending || leave.isPending;

  if (!enabled) return null;
  if (isLoading) return <Skeleton className="h-28 w-full rounded-lg" />;
  if (pending.length === 0) return null;

  return (
    <section aria-labelledby="connections-waiting" className="space-y-3">
      <div>
        <h3 id="connections-waiting" className="text-sm font-semibold">
          Waiting on you
        </h3>
        <p className="text-muted-foreground mt-1 text-sm">
          {pending.length === 1
            ? 'Someone reached a bot that has no agent set to answer.'
            : `${pending.length} chats reached a bot that has no agent set to answer.`}
        </p>
      </div>

      {pending.map((chat) => (
        <ClaimCard
          key={chat.id}
          chat={chat}
          agentOptions={agentOptions}
          isDeciding={isDeciding}
          onClaim={(agentId, bridge) => {
            const name = agentOptions.find((a) => a.id === agentId)?.name ?? agentId;
            claim.mutate(
              { id: chat.id, input: { agentId, bridge } },
              {
                onSuccess: ({ binding, bridgeError }) => {
                  if (bridgeError) {
                    // The claim itself stood — the chat is answered, just not
                    // in a channel yet — so this is a warning, not a failure.
                    toast.warning(`${name} will answer this chat privately: ${bridgeError}`);
                    return;
                  }
                  if (bridge && binding.roomId) {
                    toast.success(`${name} will answer this chat in a new channel.`);
                    void navigate({ to: '/channels', search: { id: binding.roomId } });
                    return;
                  }
                  toast.success(`${name} will answer this chat.`);
                },
                onError: (error) => {
                  // A chat already claimed by someone else is a question, not
                  // a failure — offer the move instead of apologising for it.
                  // The shared mutation toast is suppressed
                  // (`useClaimUnclaimedChat`'s `meta.suppressErrorToast`), so
                  // a genuine failure needs its own report here.
                  const found = readChatConflict(error, { id: agentId, name });
                  if (found) {
                    setConflict(found);
                    return;
                  }
                  toast.error(
                    error instanceof Error ? error.message : "Couldn't set an agent to answer"
                  );
                },
              }
            );
          }}
          onIgnore={() =>
            ignore.mutate(chat.id, {
              onSuccess: () => toast.success('Ignored. You will not see this chat again.'),
            })
          }
          onBlock={() =>
            block.mutate(chat.id, {
              onSuccess: () => toast.success('Blocked. Nothing from this chat is recorded now.'),
            })
          }
          onLeave={() =>
            leave.mutate(chat.id, {
              onSuccess: () => toast.success('Left the group. Nothing from it is recorded now.'),
            })
          }
        />
      ))}

      <MoveChatDialog conflict={conflict} onClose={() => setConflict(null)} />
    </section>
  );
}
