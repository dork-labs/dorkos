import type { TurnStarter } from '@dorkos/shared/agent-runtime';

/** Classify the envelope subject for display, not identity: local publishers can choose it. */
export function relayMessageStarter(from: string): TurnStarter {
  if (from.startsWith('relay.human.telegram.')) return 'telegram';
  if (from.startsWith('relay.human.slack.')) return 'slack';
  if (from.startsWith('relay.webhook.')) return 'webhook';
  if (from.startsWith('relay.agent.') || from.startsWith('relay.session.')) return 'agent-message';
  if (from === 'relay.human.console' || from.startsWith('relay.human.console.')) return 'unknown';
  return 'outside-message';
}
