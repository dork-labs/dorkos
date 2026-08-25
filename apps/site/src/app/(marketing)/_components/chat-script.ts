import { AGENTS_BY_KEY, type AgentKey } from './cast';
import type { DockAppId } from './dock-apps';

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
  /** Dock tile whose icon flies from the dock into this message. */
  dockApp?: DockAppId;
}

/**
 * The one conversation the whole page revolves around. Part one plays in the
 * "talk" beat; the lines from `PART_ONE_COUNT` on play once the dock arrives
 * in the "yours" beat, one message per tile.
 *
 * Two things in here are load-bearing rather than flavour, and a rewrite
 * should keep both:
 *
 *  1. **The agents ask, and you answer.** Twice, an agent proposes and "You"
 *     says go before anything happens. Tool Approval and Action Approvals are
 *     real shipped features, and the promo film this page hosts makes the same
 *     promise — the agents suggest, the person approves. A script of five
 *     completed actions and no approval would sell autonomy the product does
 *     not claim.
 *  2. **Every capability named here ships.** Each `dockApp` resolves to a `ga`
 *     entry in the feature catalog, checked by `__tests__/home-copy.test.ts`.
 */
export const CHAT_SCRIPT: readonly ChatLine[] = [
  { from: 'system', text: 'Rosie, Johnny 5, and WALL·E joined #launch-day', time: '9:41' },
  { from: 'you', text: 'Can we ship the new page today?', time: '9:41' },
  { from: 'rosie', text: 'Tests are green. Want me to merge and deploy?', time: '9:41' },
  { from: 'you', text: 'Go ahead.', time: '9:42' },
  { from: 'rosie', text: 'can you double-check my work?', time: '9:42', mention: '@Johnny 5' },
  { from: 'johnny', text: 'Checked. Looks good ✓', time: '9:42' },
  {
    from: 'walle',
    text: 'Want the release-notes skill for this?',
    time: '9:43',
    dockApp: 'skills',
  },
  { from: 'you', text: 'Yes.', time: '9:43' },
  {
    from: 'johnny',
    text: 'Morning checks are on the schedule now.',
    time: '9:44',
    dockApp: 'schedule',
  },
  { from: 'walle', text: 'Updates will land in #launch-day.', time: '9:44', dockApp: 'slack' },
  {
    from: 'johnny',
    text: 'And Telegram, the moment it ships.',
    time: '9:45',
    dockApp: 'telegram',
  },
  { from: 'rosie', text: 'Watch from your phone if you step out.', time: '9:45', dockApp: 'phone' },
  { from: 'system', text: '🚀 Rosie shipped the site', time: '9:46' },
];

/** How many lines belong to the "talk" beat. */
export const PART_ONE_COUNT = 6;

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
