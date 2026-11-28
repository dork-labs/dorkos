/**
 * What a caller that hands its run over at once hears back from the turn
 * port on this computer (spec `turns-survive-restarts` §3.5, T6): a spin-off's
 * first message and a message sent from the web, whose callers answer their
 * own asker at once. Plain data. It lives apart from the port's wire payloads
 * (`turn-port.ts`): the port's own answer stays `accepted` or a refusal, and
 * the receipt here is only ever this computer's launch path speaking.
 *
 * Shared, so a caller on either side of the computer wall can read it without
 * importing the run record (`services/runs`).
 *
 * @module shared/turn-hand-over
 */
import type { MessageDeliveryOutcome, SessionLaunchWarning } from './schemas.js';
import type { RefusalReason, WaitReason } from './turn-port.js';

/**
 * How many chats started from the web may have a turn going at once. One past
 * it waits for a slot (admission's `machine_full`), where the relay used to
 * refuse it. The relay answers a send long before its turn ends, so without a
 * limit a hub could start chats without end.
 */
export const WEB_NEW_CHATS_MAX = 4;

/** What this computer's launch path said when it took a run whose caller waits on it. */
export interface HandOverReceipt {
  /** The chat's canonical id, best effort (a new chat's may differ from the one asked for). */
  canonicalId?: string;
  /** Whether the words wait rather than run. */
  queued: boolean;
  /** Their place in the chat's queue, 1-based; 0 when they are on no queue. */
  queuePosition: number;
  /** What was asked for and what was applied. */
  outcome: MessageDeliveryOutcome;
  /** Tools the chat will not have, when the launch knew of any. */
  warnings?: SessionLaunchWarning[];
}

/** Why this computer's launch path refused a run, in the words the caller shows. */
export interface HandOverRefusal {
  /** Which check refused it (the launch path's own code, such as `DESK_NOT_OWN`). */
  code: string;
  /** The sentence a caller shows as-is. */
  message: string;
  /** With an agent's pause: the paused agent's Mesh id. */
  agentId?: string;
  /** With a place the caller may not use: which part of the rule refused it. */
  launcherRefused?: string;
}

/**
 * What became of a run handed over now:
 *
 * - `handed`: the computer face took it, with what the launch path said;
 * - `waiting`: admission holds it (a full machine, the web's slots, a paused
 *   agent) or its chat turned busy; it waits with its reason and its place
 *   among its chat's waiting runs, and starts by itself when it may;
 * - `refused`: the computer face refused it at the door; the run is cancelled.
 */
export type HandOverNowAnswer =
  | { kind: 'handed'; runId: string; receipt?: HandOverReceipt }
  | {
      kind: 'waiting';
      runId: string;
      /** Why it waits; absent while this computer's face is not wired yet. */
      waitReason?: WaitReason;
      /** Its 1-based place among its chat's waiting runs. */
      queuePosition: number;
    }
  | { kind: 'refused'; runId: string; reason: RefusalReason; refusal?: HandOverRefusal };
