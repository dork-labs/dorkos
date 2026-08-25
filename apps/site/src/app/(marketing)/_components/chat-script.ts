import { AGENTS_BY_KEY, type AgentKey } from './cast';
import type { IntegrationId } from './integrations';

/** Who a chat line comes from. */
export type Sender = 'you' | 'system' | AgentKey;

/** One line of the simulated conversation. */
export interface ChatLine {
  from: Sender;
  text: string;
  /** Slack-style timestamp shown next to the sender name. */
  time: string;
  /** Teammate name highlighted at the start of the message, if any. */
  mention?: string;
  /** App whose icon flies from the dock into this message. */
  integration?: IntegrationId;
}

/**
 * The one conversation the whole page revolves around. Part one plays in the
 * "talk" beat; the lines from `PART_ONE_COUNT` on play once the apps join in
 * the "yours" beat — one message per app on the dock.
 */
export const CHAT_SCRIPT: readonly ChatLine[] = [
  { from: 'system', text: 'Rosie, Johnny 5, and WALL·E joined #launch-day', time: '9:41' },
  { from: 'you', text: 'Can we ship the new page today?', time: '9:41' },
  { from: 'rosie', text: 'On it! Running the last tests now.', time: '9:41' },
  { from: 'rosie', text: 'can you double-check my work?', time: '9:42', mention: '@Johnny 5' },
  { from: 'johnny', text: 'Checked. Looks good ✓', time: '9:42' },
  { from: 'walle', text: 'Emailed the waitlist. 214 people.', time: '9:43', integration: 'email' },
  { from: 'johnny', text: 'Launch call booked for Friday.', time: '9:43', integration: 'calendar' },
  { from: 'rosie', text: 'Merged the release. All green.', time: '9:44', integration: 'git' },
  { from: 'walle', text: 'Launch notes written and shared.', time: '9:44', integration: 'docs' },
  { from: 'johnny', text: 'Told the team in #general.', time: '9:45', integration: 'slack' },
  { from: 'system', text: '🚀 Rosie shipped the site', time: '9:45' },
];

/** How many lines belong to the "talk" beat. */
export const PART_ONE_COUNT = 5;

/** True when the line is spoken by an agent (not you, not the room itself). */
export function isAgentLine(line: ChatLine): boolean {
  return line.from !== 'you' && line.from !== 'system';
}

/** Display name for a sender. */
export function senderName(sender: Sender): string {
  if (sender === 'you') return 'You';
  return AGENTS_BY_KEY[sender]?.name ?? sender;
}

/** Identity color for a sender's name in the chat. */
export function senderColor(sender: Sender): string {
  if (sender === 'you') return '#f5f0e6';
  return AGENTS_BY_KEY[sender]?.color ?? '#f5f0e6';
}

/** Shared layout id that carries an agent's avatar from its hero card into the chat. */
export function agentLayoutId(key: AgentKey): string {
  return `agent-${key}`;
}
