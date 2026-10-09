/**
 * The `chat` capability domain (spec `spin-off-chats` §1): `chat_send`,
 * `chat_read` and `chat_stop`, declared once each so every runtime gets them
 * through the DorkOS tools: Claude Code through its in-session server, Codex,
 * OpenCode and Doe through the authenticated runtime listener.
 *
 * ## The caller is the verified turn
 *
 * No tool takes a "from". The sending chat is `context.sessionId` and its
 * agent is `context.identity`, both read off the verified turn, so a message
 * can never claim another chat sent it. They are `in-session` only for the
 * same reason: the external `/mcp` server has no calling chat, so a sender
 * stamp there would be a lie, and a tool that could only refuse is not listed.
 *
 * ## Permission
 *
 * Area `messages` ("Message other agents, and message you"), tier `act`,
 * Allowed in every preset, as the relay tools they replace were. Agents can
 * do what people can (Dorian 2026-10-08): stopping another chat is the same
 * act as pressing its Stop button, recorded in the audit trail.
 *
 * @module services/session/chat-messages/chat-capabilities
 */
import { z } from 'zod';
import {
  CHAT_READ_TOOL,
  CHAT_SEND_TOOL,
  CHAT_STOP_TOOL,
  ChatDeliverySchema,
  ChatMessageKindSchema,
  ChatMessageSenderSchema,
  ChatMessageStatusSchema,
} from '@dorkos/shared/chat-messages';
import {
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
  type CapabilityHandlerContext,
} from '../../core/capabilities/index.js';
import {
  CHAT_MESSAGE_MAX,
  CHAT_STOP_REASON_MAX,
  CHAT_SUMMARY_MAX,
  ChatMessageError,
  type ChatCaller,
  type ChatMessageService,
} from './chat-message-service.js';
import {
  CHAT_READ_MAX_LAST,
  CHAT_READ_MAX_MAX_CHARS,
  CHAT_READ_MIN_MAX_CHARS,
  readChat,
  type ChatReadDeps,
} from './chat-read.js';

declare module '../../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** Present when chats can message chats; gates the `chat` domain. */
    chatMessageDeps?: {
      /** Sends and stops. */
      service: Pick<ChatMessageService, 'send' | 'stopChat'>;
      /** Reads. */
      read: ChatReadDeps;
    };
  }
}

/** A refusal, as every chat tool answers one. */
const RefusalSchema = z.object({
  ok: z.literal(false),
  /** A stable code. */
  code: z.string(),
  /** A plain sentence for the calling agent. */
  error: z.string(),
});

/** Narrow the bag, throwing if the registry was composed without it. */
function requireChatDeps(deps: CapabilityDeps): NonNullable<CapabilityDeps['chatMessageDeps']> {
  if (!deps.chatMessageDeps) {
    throw new Error('Chat capability invoked without chatMessageDeps in the registry bag.');
  }
  return deps.chatMessageDeps;
}

/**
 * The calling chat, from the verified turn, or null when the call came from
 * somewhere with no chat or no agent.
 *
 * @param context - The invocation context.
 */
export function chatCallerOf(context: CapabilityHandlerContext): ChatCaller | null {
  if (!context.sessionId) return null;
  if (!context.identity || context.identity.inactive) return null;
  return { sessionId: context.sessionId, agentPath: context.identity.agentPath };
}

/** The refusal for a call with no calling chat. */
const NO_CHAT = {
  ok: false as const,
  code: 'NO_CHAT',
  error: 'Only an agent working in a chat can use this, so the other side knows who it is from.',
};

/** Run a chat tool, answering a {@link ChatMessageError} as a refusal. */
async function answer<T>(
  run: () => Promise<T>
): Promise<T | { ok: false; code: string; error: string }> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ChatMessageError) return { ok: false, code: err.code, error: err.message };
    throw err;
  }
}

/** The chat domain. */
export const chatDomain: CapabilityDomain = {
  name: 'chat',
  assertDeps: requireChatDeps,
  capabilities: [
    defineCapability({
      id: 'chat.send',
      title: 'Message another chat',
      description:
        'Send a message to another chat, the way a person types into it. `to` is a chat id ' +
        '(posts into that chat) or an agent id (posts into your own DM chat with that agent, ' +
        'started if needed). The other side sees it came from you and this chat, never from the ' +
        'person. It waits until that chat’s current turn ends (delivery `queue`, the default); ' +
        '`steer` joins its running turn now, `interrupt` stops its turn and runs this next. ' +
        'Waking an idle chat starts its turn at once. Give a short `summary` (a few words) for ' +
        'the card the person sees. Use `replyTo` with a message id to answer a message another ' +
        'chat sent you. Their reply comes back as a new message in this chat.',
      tier: 'act',
      area: 'messages',
      approvalDisplayFields: ['to', 'summary', 'message'],
      input: z.object({
        to: z.string().trim().min(1).max(200).describe('A chat id or an agent id.'),
        message: z
          .string()
          .min(1)
          .max(CHAT_MESSAGE_MAX)
          .describe('What to say (markdown). Write it for a busy reader.'),
        summary: z
          .string()
          .max(CHAT_SUMMARY_MAX)
          .optional()
          .describe('A few words on what it is about, for the card the person sees.'),
        delivery: ChatDeliverySchema.optional().describe(
          '`queue` (default): wait for the turn to end. `steer`: join the running turn. ' +
            '`interrupt`: stop the running turn and run this next.'
        ),
        replyTo: z
          .string()
          .min(1)
          .optional()
          .describe('The id of a message another chat sent you, when this answers it.'),
      }),
      output: z.union([
        z.object({
          ok: z.literal(true),
          messageId: z.string(),
          chatId: z.string(),
          status: ChatMessageStatusSchema,
          position: z.number().int().positive().optional(),
          note: z.string().optional(),
        }),
        RefusalSchema,
      ]),
      surfaces: {
        mcp: {
          toolName: CHAT_SEND_TOOL,
          servers: ['in-session'],
          annotations: { idempotentHint: false },
        },
      },
      invoke: async (deps, input, context) => {
        const caller = chatCallerOf(context);
        if (!caller) return NO_CHAT;
        return answer(async () => ({
          ok: true as const,
          ...(await requireChatDeps(deps).service.send(caller, input)),
        }));
      },
    }),
    defineCapability({
      id: 'chat.read',
      title: 'Read another chat',
      description:
        'Read a chat’s state (running, needs-you, done, failed, stopped, paused-at-limit, idle) ' +
        'and its messages, so you never read transcript files. By default you get only what is ' +
        'new since your last read (`since: "last-read"`), newest 10 at most. `last: n` reads the ' +
        'newest n instead; `since` also takes a message id or an ISO time. `include: "status"` ' +
        'is the cheapest check (no messages); `"tools"` adds one line per tool call. A long read ' +
        'is cut at `maxChars` (default 8000) and `cursor` continues it. `query` finds messages ' +
        'matching words. You can read your own chat, the chat that started you, chats you ' +
        'started, and chats you have messaged or that messaged you.',
      tier: 'observe',
      area: 'messages',
      input: z.object({
        chat: z.string().trim().min(1).max(200).describe('The chat id to read.'),
        since: z
          .string()
          .min(1)
          .optional()
          .describe('"last-read" (default), a message id, or an ISO time.'),
        last: z
          .number()
          .int()
          .min(1)
          .max(CHAT_READ_MAX_LAST)
          .optional()
          .describe('The newest n messages (default 10).'),
        include: z
          .enum(['text', 'tools', 'status'])
          .optional()
          .describe('"text" (default), "tools", or "status" (state only).'),
        maxChars: z
          .number()
          .int()
          .min(CHAT_READ_MIN_MAX_CHARS)
          .max(CHAT_READ_MAX_MAX_CHARS)
          .optional()
          .describe('A size budget in characters (default 8000).'),
        query: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe('Only messages matching these words.'),
        cursor: z
          .string()
          .min(1)
          .optional()
          .describe('The cursor a cut read returned, to continue it.'),
      }),
      output: z.union([
        z.object({
          ok: z.literal(true),
          chat: z.object({
            id: z.string(),
            title: z.string().nullable(),
            agent: z.string().nullable(),
            state: z.enum([
              'running',
              'needs-you',
              'done',
              'failed',
              'stopped',
              'paused-at-limit',
              'idle',
            ]),
          }),
          messages: z.array(
            z.object({
              id: z.string(),
              from: z.enum(['person', 'agent', 'chat']),
              sender: ChatMessageSenderSchema.optional(),
              kind: ChatMessageKindSchema.optional(),
              at: z.string().optional(),
              text: z.string(),
              tools: z.array(z.string()).optional(),
              trimmed: z.literal(true).optional(),
            })
          ),
          more: z.boolean(),
          cursor: z.string().optional(),
        }),
        RefusalSchema,
      ]),
      surfaces: {
        mcp: {
          toolName: CHAT_READ_TOOL,
          servers: ['in-session'],
          annotations: { idempotentHint: false },
        },
      },
      invoke: async (deps, input, context) => {
        const caller = chatCallerOf(context);
        if (!caller) return NO_CHAT;
        return answer(async () => ({
          ok: true as const,
          ...(await readChat(requireChatDeps(deps).read, caller, input)),
        }));
      },
    }),
    defineCapability({
      id: 'chat.stop',
      title: 'Stop another chat',
      description:
        'Stop another chat’s running turn, as its Stop button does. Messages other chats queued ' +
        'there are dropped; the person’s own queued messages stay and run next. The stopped chat ' +
        'shows "Stopped by <you> · <this chat>: <reason>", and the stop is in the audit trail. ' +
        'Give a short `reason`. You cannot stop your own chat: end your turn instead.',
      tier: 'act',
      area: 'messages',
      approvalDisplayFields: ['chat', 'reason'],
      input: z.object({
        chat: z.string().trim().min(1).max(200).describe('The chat id to stop.'),
        reason: z
          .string()
          .max(CHAT_STOP_REASON_MAX)
          .optional()
          .describe('Why, in a few plain words. The stopped chat shows it.'),
      }),
      output: z.union([
        z.object({
          ok: z.literal(true),
          stopped: z.boolean(),
          chatId: z.string(),
          droppedMessages: z.number().int().nonnegative(),
          note: z.string(),
        }),
        RefusalSchema,
      ]),
      surfaces: {
        mcp: {
          toolName: CHAT_STOP_TOOL,
          servers: ['in-session'],
          annotations: { idempotentHint: false },
        },
      },
      invoke: async (deps, input, context) => {
        const caller = chatCallerOf(context);
        if (!caller) return NO_CHAT;
        return answer(async () => ({
          ok: true as const,
          ...(await requireChatDeps(deps).service.stopChat(caller, input)),
        }));
      },
    }),
  ],
};
