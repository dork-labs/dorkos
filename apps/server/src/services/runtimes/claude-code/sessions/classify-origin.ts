import type { SessionOrigin } from '@dorkos/shared/types';

const RELAY_CONTEXT_START = '<relay_context>';
const RELAY_CONTEXT_END = '</relay_context>';
const TASK_SCHEDULER_MARKER = '=== TASK SCHEDULER CONTEXT ===';
const AGENT_LABEL_MAX_LENGTH = 24;
/** Maximum length of a composed channel origin label ("<Platform> · <chat-or-sender>"). */
const CHANNEL_LABEL_MAX_LENGTH = 60;
/** The " · " separator (U+00B7 MIDDLE DOT with spaces) joining a channel platform and identity. */
const CHANNEL_LABEL_SEPARATOR = ' · ';

/** Extract a single `<label>: <value>` line from inside a `<relay_context>` block, or `undefined` if absent. */
function extractRelayLine(text: string, label: string): string | undefined {
  const end = text.indexOf(RELAY_CONTEXT_END);
  const block = end === -1 ? text : text.slice(0, end);
  const match = new RegExp(`^${label}: (.*)$`, 'm').exec(block);
  return match?.[1];
}

/** Extract the `From: <value>` line from inside a `<relay_context>` block, or `undefined` if absent. */
function extractRelayFrom(text: string): string | undefined {
  return extractRelayLine(text, 'From');
}

/**
 * Compose a channel origin label from the plain platform label plus the
 * sender/chat identity forwarded by the producer (DOR-411). The chat title
 * wins when both are present (group chats), the sender name otherwise (DMs);
 * neither present falls back to the plain platform label. The result is
 * capped at {@link CHANNEL_LABEL_MAX_LENGTH} characters.
 *
 * @param platformLabel - The plain platform label (e.g. "Telegram")
 * @param sender - The sender's display name, if forwarded
 * @param chat - The chat/channel title, if forwarded
 */
function composeChannelLabel(platformLabel: string, sender?: string, chat?: string): string {
  const identity = chat ?? sender;
  if (identity === undefined) return platformLabel;
  const label = `${platformLabel}${CHANNEL_LABEL_SEPARATOR}${identity}`;
  return label.slice(0, CHANNEL_LABEL_MAX_LENGTH);
}

/** Classify a `<relay_context>` block's `From:` value into an origin + label, first-match-wins. */
function classifyRelayFrom(from: string): { origin?: SessionOrigin; originLabel?: string } {
  if (from === 'a2a-gateway') {
    return { origin: 'external', originLabel: 'A2A client' };
  }
  if (from === 'relay.external.mcp') {
    return { origin: 'external', originLabel: 'External MCP client' };
  }
  if (from.startsWith('relay.system.tasks.')) {
    return { origin: 'task', originLabel: 'Scheduled task' };
  }
  if (from === 'relay.human.console' || from.startsWith('relay.human.console.')) {
    // Suffixed principals exist for the same human operator — e.g.
    // `relay.human.console.inferred` (routes/relay.ts) and
    // `relay.human.console.user` (test-mode) — and must stay classified
    // as the operator, not fall through to the relay.human.* channel bucket.
    return {};
  }
  const lower = from.toLowerCase();
  if (lower.includes('telegram')) {
    return { origin: 'channel', originLabel: 'Telegram' };
  }
  if (lower.includes('slack')) {
    return { origin: 'channel', originLabel: 'Slack' };
  }
  if (lower.includes('webhook')) {
    return { origin: 'channel', originLabel: 'Webhook' };
  }
  if (from.startsWith('relay.human.')) {
    return { origin: 'channel', originLabel: 'Channel' };
  }
  if (from.startsWith('relay.agent.') || from.startsWith('relay.session.')) {
    const segment = from.slice(from.lastIndexOf('.') + 1).slice(0, AGENT_LABEL_MAX_LENGTH);
    return { origin: 'agent', originLabel: `${segment} (agent)` };
  }
  return { origin: 'external', originLabel: 'Relay' };
}

/**
 * Classify what initiated a session from the raw text of its first user
 * message, using durable markers already present in the transcript head:
 * the Relay `<relay_context>` block (server-injected, names the caller in
 * its `From:` line) and the Pulse `=== TASK SCHEDULER CONTEXT ===` append.
 *
 * Pure and synchronous — no IO. Absent `origin` in the result means
 * user-initiated, the unmarked default. Best-effort and advisory only: this
 * is a UX affordance, never a security boundary (the raw relay publish route
 * lets callers assert `from`).
 *
 * For channel-origin sessions (Telegram/Slack/Webhook/Channel), when the
 * block also carries `Sender:`/`Chat:` lines (DOR-411 producer), the origin
 * label is enriched to `"<Platform> · <chat-or-sender>"`; legacy transcripts
 * without those lines keep today's plain platform label. Agent/task/external
 * branches ignore the identity lines even when present.
 *
 * @param firstRawUserMessageRaw - Raw text of the session's first user message, before any title-derivation stripping
 */
export function classifyOrigin(firstRawUserMessageRaw: string): {
  origin?: SessionOrigin;
  originLabel?: string;
} {
  if (!firstRawUserMessageRaw.startsWith(RELAY_CONTEXT_START)) {
    if (firstRawUserMessageRaw.startsWith(TASK_SCHEDULER_MARKER)) {
      return { origin: 'task' };
    }
    return {};
  }

  const from = extractRelayFrom(firstRawUserMessageRaw);
  if (from === undefined) {
    return { origin: 'external', originLabel: 'Relay' };
  }

  const classified = classifyRelayFrom(from);
  if (classified.origin !== 'channel' || classified.originLabel === undefined) {
    return classified;
  }

  const sender = extractRelayLine(firstRawUserMessageRaw, 'Sender');
  const chat = extractRelayLine(firstRawUserMessageRaw, 'Chat');
  return {
    ...classified,
    originLabel: composeChannelLabel(classified.originLabel, sender, chat),
  };
}
