import type { TurnStarter } from '@dorkos/shared/agent-runtime';

/** Classify the server-stamped sender for display only. Never inspect the payload. */
export function relayMessageStarter(from: string): TurnStarter {
  if (from.startsWith('relay.human.telegram.')) return 'telegram';
  if (from.startsWith('relay.human.slack.')) return 'slack';
  if (from.startsWith('relay.webhook.')) return 'webhook';
  if (from.startsWith('relay.agent.')) return 'agent-message';
  return 'outside-message';
}
