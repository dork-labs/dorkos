import type { SessionOrigin } from '@dorkos/shared/types';

const RELAY_CONTEXT_START = '<relay_context>';
const RELAY_CONTEXT_END = '</relay_context>';
const TASK_SCHEDULER_MARKER = '=== TASK SCHEDULER CONTEXT ===';
const AGENT_LABEL_MAX_LENGTH = 24;

/** Extract the `From: <value>` line from inside a `<relay_context>` block, or `undefined` if absent. */
function extractRelayFrom(text: string): string | undefined {
  const end = text.indexOf(RELAY_CONTEXT_END);
  const block = end === -1 ? text : text.slice(0, end);
  const match = /^From: (.*)$/m.exec(block);
  return match?.[1];
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
  if (from === 'relay.human.console') {
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
  return classifyRelayFrom(from);
}
