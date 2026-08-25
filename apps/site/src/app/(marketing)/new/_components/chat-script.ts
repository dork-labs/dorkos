import { SPEAKERS, type CastKey, type SpeakerKey } from './cast';
import type { DockAppId } from './dock-apps';

/** Who a chat line comes from. */
export type Sender = SpeakerKey | 'system';

/** One line of the simulated conversation. */
export interface ChatLine {
  from: Sender;
  text: string;
  /** Timestamp shown next to the sender name. */
  time: string;
  /** Teammate name highlighted at the start of the message, if any. */
  mention?: string;
  /** Dock tile whose icon flies from the dock into this message. */
  dockApp?: DockAppId;
}

/**
 * The one conversation the whole page revolves around, played by the film's
 * cast. Part one runs in the "talk" beat; the lines from `PART_ONE_COUNT` on
 * play once the dock arrives in the "yours" beat, one message per tile.
 *
 * Four things in here are load-bearing rather than flavour:
 *
 *  1. **Dave asks, the agents do.** Twice, an agent proposes and Dave answers
 *     before anything happens. The film makes the same promise in its own chat
 *     ("Wanna buy flowers?" then "Oh, nice! Yeah — do that."), Tool Approval
 *     and Action Approvals are what actually ships, and a script of completed
 *     actions off one instruction would sell autonomy the product does not
 *     claim.
 *  2. **Every capability named here ships.** Each `dockApp` resolves to a `ga`
 *     entry in the feature catalog, checked by `__tests__/home-copy.test.ts`.
 *     The film can show email and calendar; this page cannot, because those run
 *     through Connections, which is beta.
 *  3. **The four voices stay four voices.** Otto is the doer, cheerful and no
 *     fuss. Pip is fast and over-excited. Hal is formal, dry and reluctant, and
 *     is funnier for being underplayed — in the whole film he says eleven
 *     words. Four identical replies would be one sound repeated.
 *  4. **Nothing here touches the flowers.** That joke belongs to the film and
 *     only works cold.
 */
export const CHAT_SCRIPT: readonly ChatLine[] = [
  { from: 'system', text: 'Otto, Pip, and Hal joined #launch-day', time: '9:41' },
  { from: 'dave', text: 'Hey, team. Can we ship the new page today?', time: '9:41' },
  { from: 'otto', text: 'Morning, Dave. Tests are green. Want me to deploy?', time: '9:41' },
  { from: 'dave', text: 'Go ahead.', time: '9:42' },
  { from: 'pip', text: 'Heyheyhey! I can double-check it after!', time: '9:42' },
  { from: 'hal', text: 'Good morning... Dave.', time: '9:42' },
  { from: 'otto', text: 'Want the release-notes skill for this?', time: '9:43', dockApp: 'skills' },
  { from: 'dave', text: 'Yes.', time: '9:43' },
  {
    from: 'pip',
    text: 'Morning checks are on the schedule now!',
    time: '9:44',
    dockApp: 'schedule',
  },
  { from: 'otto', text: 'Updates will land in #launch-day.', time: '9:44', dockApp: 'slack' },
  { from: 'hal', text: 'I will notify you on Telegram.', time: '9:45', dockApp: 'telegram' },
  { from: 'pip', text: 'Watch from your phone if you step out!', time: '9:45', dockApp: 'phone' },
  { from: 'system', text: '🚀 Otto shipped the site', time: '9:46' },
];

/** How many lines belong to the "talk" beat. */
export const PART_ONE_COUNT = 6;

/** True when the line is spoken by an agent (not Dave, not the room itself). */
export function isAgentLine(line: ChatLine): boolean {
  return line.from !== 'dave' && line.from !== 'system';
}

/** Display name for a sender. */
export function senderName(sender: Sender): string {
  return sender === 'system' ? 'system' : SPEAKERS[sender].name;
}

/** Identity colour for a sender's name in the chat. */
export function senderColor(sender: Sender): string {
  return sender === 'system' ? '#7a756a' : SPEAKERS[sender].ring;
}

/** Shared layout id that carries an agent's face from its hero card into the chat. */
export function agentLayoutId(key: CastKey): string {
  return `agent-${key}`;
}
