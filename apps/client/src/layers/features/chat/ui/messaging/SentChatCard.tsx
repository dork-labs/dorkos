/**
 * The "Sent" card: what a chat's `chat_send`, `session_start` or `chat_stop`
 * call looks like in that chat (spec `spin-off-chats` §6).
 *
 * Messaging is conversation, not tool use, so this card is never a tool card:
 * it never fades with "Auto-hide tool calls", never folds into a run of tool
 * calls, and reads as a line of the conversation. Closed, it is one line: who
 * it went to, what it is about, when, and where it is now. Open, it is the
 * whole message, where it is in plain words, and a link to the other chat.
 *
 * @module features/chat/ui/messaging/SentChatCard
 */
import { useId, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ChevronDown, CircleStop, GitBranchPlus, Send } from 'lucide-react';
import type { SentChatMessage } from '@dorkos/shared/chat-messages';
import { cn, resolveAgentVisual, toSession } from '@/layers/shared/lib';
import { AgentAvatar } from '@/layers/entities/agent';
import { formatTime } from '@/layers/features/conversation';
import { StreamingText } from '../message/StreamingText';
import {
  chatFactsFor,
  deliveryLabel,
  readMessagingCall,
  sentRecordFor,
  sentSummary,
  shortReason,
  type MessagingCall,
} from '../../lib/chat-messaging';

/** What the card draws from. */
export interface SentChatCardProps {
  /** The messaging tool call. */
  part: { toolName: string; input?: string; result?: string; status: string };
  /** What this chat sent, as the server reported it. */
  sent: readonly SentChatMessage[];
  /** When the call was made, ISO 8601, when known. */
  at?: string;
  /** The chat this card is in, for widget fences in the message. */
  sessionId?: string;
}

/** The colour of the state words. */
const TONE: Record<ReturnType<typeof deliveryLabel>['tone'], string> = {
  muted: 'text-muted-foreground',
  active: 'text-foreground',
  done: 'text-muted-foreground',
  error: 'text-destructive',
};

/** The words with their first letter capitalized, for the start of a sentence. */
function sentenceCase(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Where the message is, in a plain sentence. */
function receiptSentence(
  call: MessagingCall,
  record: SentChatMessage | undefined,
  agent: string
): string {
  if (call.error) return call.error;
  if (call.waiting) return 'Waiting for a person to approve it.';
  if (call.tool === 'chat_stop') {
    return call.note ?? (call.notRunning ? 'Nothing was running there.' : 'Asked it to stop.');
  }
  if (!record) return call.note ?? 'Sent.';
  const Agent = sentenceCase(agent);
  switch (record.status) {
    case 'queued':
      return record.position
        ? `Waiting for ${agent} to finish its turn. Number ${record.position} in line.`
        : `Waiting for ${agent} to finish its turn.`;
    case 'steered':
      return `Joined ${agent}’s running turn.`;
    case 'working':
      return record.delivery === 'interrupt'
        ? `Stopped ${agent}’s turn. ${Agent} is on this now.`
        : `${Agent} is working on it.`;
    case 'delivered':
      return `${Agent} read it and finished its turn.`;
    case 'replied':
      return `${Agent} replied.`;
    case 'failed':
      return record.failureReason ?? 'It was not delivered.';
    default:
      return 'Sent.';
  }
}

/** The state words for a `chat_stop` call. */
function stopState(
  call: MessagingCall,
  pending: boolean
): { label: string; tone: 'muted' | 'done' | 'error' } {
  if (call.error) return { label: 'Failed', tone: 'error' };
  if (call.waiting) return { label: 'Waiting for approval', tone: 'muted' };
  if (pending) return { label: 'Stopping', tone: 'muted' };
  if (call.notRunning) return { label: 'Not running', tone: 'muted' };
  return { label: 'Stopped', tone: 'done' };
}

/**
 * One messaging call, drawn as conversation.
 *
 * @param props - The call, what the chat sent, and when.
 */
export function SentChatCard({ part, sent, at, sessionId }: SentChatCardProps) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const navigate = useNavigate();
  const call = readMessagingCall(part);
  if (!call) return null;

  const pending = part.status === 'pending' || part.status === 'running';
  const record = sentRecordFor(call, sent);
  // The chat it reached. Never the input's `to` for a send: that may name an
  // agent, not a chat. A stop's input always names a chat.
  const chatId =
    record?.to.chatId ?? call.chatId ?? (call.tool === 'chat_stop' ? call.to : undefined);
  // Who and what it reached, from its own record, else from anything else this
  // chat sent there (a stop carries no receipt of its own).
  const facts = record?.to ?? chatFactsFor(chatId, sent);
  const agentName = facts?.agentName ?? 'the agent';
  const chatTitle = facts?.chatTitle;
  // Seeded on the receiver, so the face does not change when the record lands.
  const visual = resolveAgentVisual({ id: facts?.agentId ?? call.to ?? chatId ?? 'chat' });
  const state =
    call.tool === 'chat_stop'
      ? stopState(call, pending)
      : deliveryLabel(record, { ...call, pending });
  const summary = sentSummary(record?.summary ?? call.summary, record?.text ?? call.message);
  const time = at ? formatTime(at) : record ? formatTime(record.sentAt) : '';
  // What it is about, beside who it went to — unless it only repeats the
  // chat's title. A call that did not happen says why instead.
  const failure = call.error ?? (record?.status === 'failed' ? record.failureReason : undefined);
  const aside = failure
    ? shortReason(failure)
    : call.tool === 'chat_stop'
      ? call.reason
      : summary !== chatTitle
        ? summary
        : '';
  const Icon =
    call.tool === 'session_start' ? GitBranchPlus : call.tool === 'chat_stop' ? CircleStop : Send;
  const verb =
    call.tool === 'session_start'
      ? 'Started spin-off chat'
      : call.tool === 'chat_stop'
        ? call.error || call.notRunning
          ? 'Tried to stop'
          : 'Stopped'
        : 'To';
  const target =
    call.tool === 'session_start'
      ? (chatTitle ?? (summary || 'a new chat'))
      : call.tool === 'chat_stop'
        ? (chatTitle ?? 'a chat')
        : (facts?.agentName ?? chatTitle ?? 'a chat');

  const openChat = () => {
    if (!chatId) return;
    void navigate(toSession({ session: chatId, ...(record ? { message: record.id } : {}) }));
  };

  return (
    <div
      data-testid="sent-chat-card"
      data-tool={call.tool}
      data-state={state.label}
      className="border-border/70 bg-background my-1.5 rounded-lg border text-sm"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        {...(open ? { 'aria-controls': bodyId } : {})}
        className="focus-ring hover:bg-muted/40 flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors duration-150"
      >
        <AgentAvatar size="xs" emoji={visual.emoji} color={visual.color} />
        <Icon aria-hidden className="text-muted-foreground hidden size-3.5 shrink-0 sm:block" />
        <span className="min-w-0 flex-1 truncate">
          <span className="text-muted-foreground">{verb} </span>
          <span className="font-medium">{target}</span>
          {call.tool === 'chat_send' && chatTitle && facts?.agentName && (
            <span className="text-muted-foreground"> · {chatTitle}</span>
          )}
          {aside && (call.tool !== 'session_start' || failure) && (
            <span
              data-testid="sent-chat-aside"
              className={cn('text-muted-foreground', !failure && 'hidden sm:inline')}
            >
              {' '}
              · {aside}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className={cn('text-xs', TONE[state.tone])} data-testid="sent-chat-state">
            {state.label}
          </span>
          {time && (
            <time className="text-muted-foreground hidden text-xs tabular-nums sm:inline">
              {time}
            </time>
          )}
          <ChevronDown
            aria-hidden
            className={cn(
              'text-muted-foreground size-3.5 transition-transform duration-200',
              open && 'rotate-180'
            )}
          />
        </span>
      </button>
      {open && (
        <div id={bodyId} className="border-border/60 space-y-2 border-t px-3 py-2">
          {(record?.text ?? call.message ?? call.reason) && (
            <div className="msg-prose">
              <StreamingText
                content={record?.text ?? call.message ?? call.reason ?? ''}
                isStreaming={false}
                {...(sessionId ? { sessionId } : {})}
              />
            </div>
          )}
          <p className="text-muted-foreground text-xs">
            {receiptSentence(call, record, agentName)}
            {call.note && call.tool !== 'chat_stop' && record ? ` ${call.note}` : ''}
          </p>
          {chatId && !call.error && !call.waiting && (
            <button
              type="button"
              onClick={openChat}
              className="focus-ring text-foreground text-xs font-medium underline-offset-4 hover:underline"
            >
              Open chat →
            </button>
          )}
        </div>
      )}
    </div>
  );
}
