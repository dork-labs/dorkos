import { useState } from 'react';
import type { UnclaimedChat } from '@dorkos/shared/relay-schemas';
import {
  Button,
  Card,
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

/**
 * Whether this row is a broadcast channel rather than a two-way group — a
 * Telegram `channel`, folded into `chatKind: 'group'` for routing but kept
 * distinct here on `platformChatType` (DOR-907). A broadcast is one-way: there
 * is nobody in it for an agent to answer, so it never offers to join, only to
 * be ignored or left (design-decisions D-3 item 4, DOR-883). A row with no
 * recorded platform type (an older sighting, or an adapter that reports none)
 * is treated as an ordinary group rather than a broadcast — the conservative
 * direction, since the server's own bridge refusal (`BROADCAST_NOT_BRIDGEABLE`)
 * still catches a genuine broadcast if this ever guesses wrong.
 */
function isBroadcastChannel(chat: UnclaimedChat): boolean {
  return chat.chatKind === 'group' && chat.platformChatType === 'channel';
}

interface ClaimCardProps {
  chat: UnclaimedChat;
  agentOptions: { id: string; name: string }[];
  /**
   * @param agentId - The agent to answer.
   * @param bridge - `true` for the primary action, "Answer in a channel"
   *   (claims, binds, and bridges atomically, landing in a room); `false` for
   *   the secondary action, "Answer privately" (today's behaviour, no room).
   *   A group's "Join" always passes `true` — a group has no private,
   *   room-less mode to fall back to (DOR-883).
   */
  onClaim: (agentId: string, bridge: boolean) => void;
  onIgnore: () => void;
  onBlock: () => void;
  /**
   * Leave the chat's group on its platform (DOR-883) — a real removal, not a
   * mute. Only ever shown for a group or a broadcast channel; a DM has
   * nothing to leave.
   */
  onLeave: () => void;
  /** True while any decision on this chat is in flight. */
  isDeciding?: boolean;
}

/**
 * One waiting chat, and the ways to answer it.
 *
 * Nothing has run: an unclaimed chat never starts a turn, so no agent has read
 * it, no money has been spent, and the bot has said nothing back. Picking an
 * agent is what starts any of that.
 *
 * Three shapes, three cards:
 *
 * - A **direct message** offers two ways to answer: "Answer in a channel"
 *   (the primary action, a room to see and reply from) or "Answer privately"
 *   (today's session-per-chat behaviour, no room).
 * - A **group** (added-to-a-group is a claim like any other, D-3 item 4)
 *   offers "Join", which always lands in a room mention-gated by default
 *   (chats-as-channels §3.4) — a group has no private, room-less mode the way
 *   a DM does. Leave really leaves the group on the platform; Ignore only
 *   mutes the card.
 * - A **broadcast channel** offers no agent at all: it is one-way, so there
 *   is nobody in it for an agent to answer. Only Ignore and Leave remain.
 *
 * @param props - The chat, the agents that could take it, and the decisions.
 */
export function ClaimCard({
  chat,
  agentOptions,
  onClaim,
  onIgnore,
  onBlock,
  onLeave,
  isDeciding = false,
}: ClaimCardProps) {
  const [agentId, setAgentId] = useState(
    agentOptions.length === 1 ? (agentOptions[0]?.id ?? '') : ''
  );
  const isGroup = chat.chatKind === 'group';
  const isBroadcast = isBroadcastChannel(chat);

  return (
    <Card data-testid={`claim-card-${chat.id}`} gap="sm">
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
        {!isBroadcast && (
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
        )}

        {isBroadcast ? null : isGroup ? (
          <Button
            size="sm"
            disabled={!agentId || isDeciding}
            onClick={() => onClaim(agentId, true)}
          >
            Join
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              disabled={!agentId || isDeciding}
              onClick={() => onClaim(agentId, true)}
            >
              Answer in a channel
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!agentId || isDeciding}
              onClick={() => onClaim(agentId, false)}
            >
              Answer privately
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" disabled={isDeciding} onClick={onIgnore}>
          Ignore
        </Button>
        {isGroup ? (
          <Button size="sm" variant="ghost" disabled={isDeciding} onClick={onLeave}>
            Leave
          </Button>
        ) : (
          <Button size="sm" variant="ghost" disabled={isDeciding} onClick={onBlock}>
            Block
          </Button>
        )}
      </div>

      <p className="text-muted-foreground text-xs">
        {isBroadcast ? (
          "This is a broadcast channel, not a conversation, so there's no one here for an agent " +
          'to answer. Ignore hides this and stays quiet. Leave removes the bot from the channel.'
        ) : isGroup ? (
          'Ignore hides this and stays quiet. Leave removes the bot from the group, so nothing ' +
          'further can arrive from it.'
        ) : (
          <>
            A channel gives you a room to see and reply from; answering privately keeps this chat as
            it is today. Ignore hides this and stays quiet. Block stops anything from this chat
            being recorded again.
          </>
        )}
      </p>
    </Card>
  );
}
