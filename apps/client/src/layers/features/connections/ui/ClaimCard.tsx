import { useState } from 'react';
import type { UnclaimedChat } from '@dorkos/shared/relay-schemas';
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui';
import { getAgentDisplayName } from '@/layers/shared/lib';

/**
 * The headline for one waiting chat.
 *
 * Names only what the platform already told us about who is on the other end —
 * a display name and, for a group, its title. The message itself is never
 * stored, never sent here, and never shown, so a stranger cannot put words in
 * front of you or in front of a model by writing to a bot they found.
 */
function claimHeadline(chat: UnclaimedChat): string {
  const who = chat.senderName?.trim() || 'Someone';
  if (chat.chatKind === 'group') {
    const where = chat.chatTitle?.trim();
    return where ? `${who} added your bot to “${where}”` : `${who} added your bot to a group`;
  }
  return `${who} messaged your bot`;
}

/** The question each kind of chat is really asking. */
function claimQuestion(chat: UnclaimedChat): string {
  return chat.chatKind === 'group' ? 'Which agent should join?' : 'Which agent should answer?';
}

interface ClaimCardProps {
  chat: UnclaimedChat;
  agentOptions: { id: string; name: string }[];
  onClaim: (agentId: string) => void;
  onIgnore: () => void;
  onBlock: () => void;
  /** True while any decision on this chat is in flight. */
  isDeciding?: boolean;
}

/**
 * One waiting chat, and the three ways to answer it.
 *
 * Nothing has run: an unclaimed chat never starts a turn, so no agent has read
 * it, no money has been spent, and the bot has said nothing back. Picking an
 * agent is what starts any of that.
 *
 * @param props - The chat, the agents that could take it, and the decisions.
 */
export function ClaimCard({
  chat,
  agentOptions,
  onClaim,
  onIgnore,
  onBlock,
  isDeciding = false,
}: ClaimCardProps) {
  const [agentId, setAgentId] = useState(
    agentOptions.length === 1 ? (agentOptions[0]?.id ?? '') : ''
  );

  return (
    <div
      data-testid={`claim-card-${chat.id}`}
      className="bg-card shadow-soft space-y-3 rounded-lg border p-4"
    >
      <div className="space-y-1">
        <p className="text-sm font-medium">{claimHeadline(chat)}</p>
        <p className="text-muted-foreground text-xs">
          {chat.messageCount === 1
            ? 'One message so far.'
            : `${chat.messageCount} messages so far.`}{' '}
          Nobody has answered, and nothing has been read.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={agentId} onValueChange={setAgentId} disabled={isDeciding}>
          <SelectTrigger
            className="w-full sm:w-56"
            aria-label={claimQuestion(chat)}
            data-testid={`claim-agent-${chat.id}`}
          >
            <SelectValue placeholder={claimQuestion(chat)} />
          </SelectTrigger>
          <SelectContent>
            {agentOptions.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {getAgentDisplayName(agent)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button size="sm" disabled={!agentId || isDeciding} onClick={() => onClaim(agentId)}>
          {chat.chatKind === 'group' ? 'Join' : 'Answer'}
        </Button>
        <Button size="sm" variant="ghost" disabled={isDeciding} onClick={onIgnore}>
          Ignore
        </Button>
        <Button size="sm" variant="ghost" disabled={isDeciding} onClick={onBlock}>
          Block
        </Button>
      </div>

      <p className="text-muted-foreground text-xs">
        Ignore hides this and stays quiet. Block stops anything from this chat being recorded again.
      </p>
    </div>
  );
}
