/**
 * Resolve who a message is from, for the message list's identity gutter.
 *
 * @module features/chat/lib/resolve-message-author
 */
import { runtimeDisplayName } from '@dorkos/shared/agent-runtime';
import type { ChatMessage, MessageAuthor } from '@/layers/shared/model';

/** Name for the human participant when the caller supplies none. */
const DEFAULT_HUMAN_NAME = 'You';

/** Identity key for the local human. There is one human today (multi-human identity is a later phase). */
const HUMAN_AUTHOR_ID = 'human';

/** Identity for messages the system emits rather than a participant. */
const SYSTEM_AUTHOR_ID = 'system';
const SYSTEM_AUTHOR_NAME = 'System';

/**
 * Last-resort assistant identity, used only when the caller knows neither an
 * agent nor a runtime. Plain but honest — and never the bare "Assistant" the
 * old role-only list rendered.
 */
const UNKNOWN_AGENT_ID = 'agent';
const UNKNOWN_AGENT_NAME = 'Agent';

/** Prefix for runtime-brand identity keys, keeping them distinct from agent ids. */
const RUNTIME_AUTHOR_ID_PREFIX = 'runtime:';

/**
 * The agent behind a session's assistant turns, when the session's directory
 * maps to a registered agent. Structural on purpose: the caller resolves it
 * (from the agents query plus the shared agent-visual resolver) and hands over
 * plain data, so this module stays free of entity and hook dependencies.
 */
export interface MessageAuthorAgent {
  /** Agent id — becomes the author's identity key, so each agent groups separately. */
  id: string;
  /** Human-readable agent name. */
  displayName: string;
  /** Emoji glyph for the avatar. */
  emoji?: string;
  /** CSS color for the avatar background. */
  color?: string;
}

/**
 * Everything {@link resolveMessageAuthor} needs, resolved by the caller.
 *
 * Deliberately plain data: the resolver never fetches, reads a store, or calls
 * a hook, so it is trivially testable and a later phase can swap where these
 * values come from without touching a UI component.
 */
export interface MessageAuthorContext {
  /** The session's agent, or null/undefined for an ad-hoc project session. */
  agent?: MessageAuthorAgent | null;
  /** Runtime type of the session (e.g. `'claude-code'`), used as the brand fallback. */
  runtime?: string | null;
  /** What to call the human. Defaults to "You". */
  humanName?: string | null;
}

/**
 * Whether a message is the system speaking rather than a participant.
 *
 * Local command output (`/context`, `/usage`, …) and compaction markers ride a
 * `user`-role message but are not something the human said.
 */
function isSystemMessage(message: ChatMessage): boolean {
  return message.messageType === 'local_command_output' || message.messageType === 'compaction';
}

/**
 * Resolve a message's author identity.
 *
 * Pure. Resolution order (spec `multi-participant-message-list`, D3): system
 * messages first, then the human, then the assistant — agent identity when the
 * session has one, otherwise the runtime's brand (Claude / Codex / OpenCode).
 * It never returns a bare "Assistant".
 *
 * @param message - The message being rendered.
 * @param ctx - Caller-resolved identity for this session.
 */
export function resolveMessageAuthor(
  message: ChatMessage,
  ctx: MessageAuthorContext
): MessageAuthor {
  if (isSystemMessage(message)) {
    return { kind: 'system', id: SYSTEM_AUTHOR_ID, displayName: SYSTEM_AUTHOR_NAME };
  }

  if (message.role === 'user') {
    return {
      kind: 'human',
      id: HUMAN_AUTHOR_ID,
      displayName: ctx.humanName?.trim() || DEFAULT_HUMAN_NAME,
    };
  }

  if (ctx.agent) {
    const { id, displayName, emoji, color } = ctx.agent;
    return { kind: 'agent', id, displayName, emoji, color };
  }

  const runtime = ctx.runtime?.trim();
  if (runtime) {
    return {
      kind: 'agent',
      id: `${RUNTIME_AUTHOR_ID_PREFIX}${runtime}`,
      displayName: runtimeDisplayName(runtime),
      runtime,
    };
  }

  return { kind: 'agent', id: UNKNOWN_AGENT_ID, displayName: UNKNOWN_AGENT_NAME };
}
