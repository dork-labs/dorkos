/**
 * Manners: how a beat's raise reaches its reader (spec `heartbeats` §9, the
 * PR 3 items).
 *
 * - **Rungs** (§9.1). `room` posts now, as the agent, through the rooms
 *   service's agent path, so room etiquette applies in full — unless the post
 *   reaches a person directly (a DM room, or a message that names a person),
 *   which waits for their hours like a `dm`. A refused room post becomes a held
 *   `dm` to the manager. `dm` goes to the agent's in-app DM with the person.
 *   `note` goes the way `relay_notify_user` goes: a bound Telegram or Slack
 *   chat, else the in-app DM. `report` has no report to ride yet (PR 4), so it
 *   is delivered as a held `dm`: nothing a beat raises is lost.
 * - **Agents have no quiet hours.** A raise whose reader is an agent becomes a
 *   `report`-kind chat message to it at once, retried like any other delivery
 *   when it fails.
 * - **Hours** (§9.2). A message to a person outside their working hours, or
 *   while they are away, waits for the next start of their hours unless it is
 *   `urgent`. That is the agent's own judgment carried out, not a cap: urgent
 *   goes now (P6), and every urgent raise is recorded with its text. The one
 *   ceiling is per person across all agents and every rung, room posts
 *   included: at most {@link URGENT_PER_PERSON_PER_HOUR} urgent raises reach
 *   them in any hour (`urgent-ceiling.ts`), the rest held to the first moment
 *   one fits and recorded.
 * - **Batching per agent.** When a person's held raises come due, everything
 *   due to them from one agent goes as one message. Several agents' messages
 *   due at once arrive in the same minute, one per agent; a roll-up across
 *   agents is a follow-up and nothing here claims it. A raise re-sent while its
 *   earlier version is still held replaces it — only the same raise to the same
 *   reader on the same rung, into the same room, so a DM's words never land in
 *   a channel.
 * - **Open raises** are the ones delivered and not yet resolved, for 14 days;
 *   every beat prompt lists them (§7.2), and `end_beat.resolved` closes them.
 * - **Delivery** runs on a one-minute tick that reads due rows only, and only
 *   while heartbeats are on. A failed delivery is retried at 1, 5, 15 and 60
 *   minutes, then dropped with a record line. Delivery is at-least-once: a row
 *   is closed after its send succeeds, so a crash between the two can send it
 *   again after a restart; within one process a row is never sent twice.
 *
 * @module services/heartbeats/outbox
 */
import { randomUUID } from 'node:crypto';
import type { EndBeatRaise } from '@dorkos/shared/heartbeat-schemas';
import {
  isWithinWorkingHours,
  nextWorkingStart,
  type ResolvedWorkingHours,
} from '@dorkos/shared/working-hours';
import type { HeartbeatOutboxRow } from '@dorkos/db';
import type { BeatAgent, BeatOutboxPort } from './beat-runner.js';
import { systemClock, type BeatClock } from './beat-scheduler.js';
import type { HeartbeatStore, NewOutboxRow } from './heartbeat-store.js';
import { recordHeartbeatEvent } from './record.js';
import type { OpenRaise } from './beat-prompt.js';
import { HOUR_MS, URGENT_PER_PERSON_PER_HOUR, urgentDeliveryTime } from './urgent-ceiling.js';

export { URGENT_PER_PERSON_PER_HOUR };

/** How often held raises are checked. */
export const OUTBOX_TICK_MS = 60_000;

/** How often an away person with no return date is checked again. */
const AWAY_RECHECK_MS = HOUR_MS;

/** What separates batched raises in one message. */
const BATCH_SEPARATOR = '\n\n';

/** How long a delivered raise stays open in the agent's prompt. */
const OPEN_RAISE_MS = 14 * 24 * HOUR_MS;

/** The most open raises one prompt lists. */
const OPEN_RAISES_MAX = 20;

/** When a failed delivery is tried again, by attempt; the next failure drops it. */
export const DELIVERY_BACKOFF_MS = [1, 5, 15, 60].map((minutes) => minutes * 60_000);

/** Where a delivered message landed. */
export type DeliveryResult = { ok: true; entryId?: string } | { ok: false; reason: string };

/** A person's hours and away state, as delivery reads them. */
export interface PersonPresence {
  /** Their working hours, in their zone. */
  hours: ResolvedWorkingHours;
  /** That they are away, or null. `until: null` is away until they say otherwise. */
  away: { until: string | null } | null;
}

/** What the outbox is built from. */
export interface OutboxDeps {
  /** The heartbeat tables. */
  store: HeartbeatStore;
  /** Who a raise with no `to` goes to: the agent's manager (§4.1). */
  managerOf(agentId: string): string;
  /** The first person up the agent's chain. */
  chainPersonOf(agentId: string): string;
  /** Whether an account id names an agent (else it is a person). */
  isAgent(accountId: string): boolean;
  /** A person's hours and away state. */
  presenceOf(personAccountId: string): PersonPresence;
  /** Whether a post in this room reaches a person directly: a DM, or a person named. */
  roomReachesPerson(roomId: string, text: string): boolean;
  /** Post in a room now, as the agent. */
  postToRoom(agent: BeatAgent, roomId: string, text: string, chatSessionId: string): DeliveryResult;
  /** The agent's in-app DM with the person. */
  deliverDm(agent: BeatAgent, to: string, text: string): Promise<DeliveryResult>;
  /** `relay_notify_user`'s way: a bound chat, else the in-app DM. */
  deliverNote(agent: BeatAgent, to: string, text: string): Promise<DeliveryResult>;
  /** A `report`-kind chat message to another agent. */
  sendToAgent(
    agent: BeatAgent,
    chatSessionId: string,
    toAgentId: string,
    text: string
  ): Promise<DeliveryResult>;
  /** An agent by id, for delivering held rows after a restart. */
  agentOf(agentId: string): BeatAgent | undefined;
  /** `heartbeats.enabled`: off delivers nothing and arms nothing. */
  enabled(): boolean;
  /** The clock. */
  clock?: BeatClock;
  /** Mints ids. */
  mintId?(): string;
}

/**
 * When a message to a person may be delivered, at or after `now`.
 *
 * @param presence - Their hours and away state.
 * @param now - Epoch ms.
 * @returns Epoch ms; `now` when it may go now.
 */
export function deliveryTime(presence: PersonPresence, now: number): number {
  const { hours, away } = presence;
  let from = now;
  if (away) {
    const until = away.until ? Date.parse(away.until) : NaN;
    if (Number.isNaN(until)) return now + AWAY_RECHECK_MS;
    if (until > now) from = until;
  }
  if (hours.days.length === 0 || isWithinWorkingHours(new Date(from), hours)) return from;
  return nextWorkingStart(new Date(from), hours)?.getTime() ?? from;
}

/**
 * A raise's stable key: the one it names, else its `about` keys sorted, else a
 * hash of its text (§8).
 *
 * @param raise - The raise.
 */
export function raiseKey(raise: EndBeatRaise): string {
  if (raise.key) return raise.key;
  if (raise.about?.length) return [...raise.about].sort().join('|');
  let hash = 0;
  for (const char of raise.text) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `text:${(hash >>> 0).toString(36)}`;
}

/** What one beat hands the outbox. */
interface Handover {
  agent: BeatAgent;
  beatId: string;
  chatSessionId: string;
}

/** The outbox. */
export class BeatOutbox implements BeatOutboxPort {
  private readonly clock: BeatClock;
  private tickHandle: unknown;
  private ticking: Promise<void> | null = null;
  private tickAgain = false;
  /** Rows sent by this process, so a resend after a failed close never repeats one. */
  private readonly sent = new Set<string>();
  /** The beat chat a held report to an agent is sent from, by row. */
  private readonly reportChats = new Map<string, string>();

  /**
   * Build the outbox.
   *
   * @param deps - What it is built from.
   */
  constructor(private readonly deps: OutboxDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /** Start the one-minute tick. */
  start(): void {
    if (this.tickHandle !== undefined) return;
    this.arm();
  }

  /**
   * Arm the next tick. A tick re-arms only while its own timer is still the
   * current one: stopped and started again mid-tick, the new start owns the
   * chain, and the old tick ends it.
   */
  private arm(): void {
    const handle = this.clock.setTimeout(() => {
      void this.tick().finally(() => {
        if (this.tickHandle === handle) this.arm();
      });
    }, OUTBOX_TICK_MS);
    this.tickHandle = handle;
  }

  /** Stop the tick. Held rows stay held. */
  stop(): void {
    if (this.tickHandle !== undefined) this.clock.clearTimeout(this.tickHandle);
    this.tickHandle = undefined;
  }

  /** Whether the tick is armed. */
  get running(): boolean {
    return this.tickHandle !== undefined;
  }

  /**
   * Take a beat's raises: post the room ones, send the agent ones, and queue the
   * person ones for their hours. Anything already due goes out before this
   * resolves.
   *
   * @param input - The agent, its beat, the beat chat and the raises.
   */
  async accept(input: Handover & { raises: readonly EndBeatRaise[] }): Promise<number> {
    let taken = 0;
    for (const raise of input.raises) {
      this.acceptOne(input, raise);
      taken += 1;
    }
    await this.tick();
    return taken;
  }

  /** One raise: the room rung now, everything else through a held row. */
  private acceptOne(handover: Handover, raise: EndBeatRaise): void {
    const { agent } = handover;
    if (raise.rung === 'room' && raise.roomId) {
      this.acceptRoom(handover, raise, raise.roomId);
      return;
    }
    const to = raise.to ?? this.deps.managerOf(agent.id);
    if (this.deps.isAgent(to)) {
      // Due at once; held as a row so a failed send is retried, not lost.
      this.hold(handover, raise, to, 'report', null);
      return;
    }
    // A report has nothing to ride until PR 4: it goes as a held DM.
    this.hold(handover, raise, to, raise.rung === 'note' ? 'note' : 'dm', null);
  }

  /**
   * A room raise: now, unless it reaches a person directly outside their
   * hours, or it is urgent and their hour's share is spent.
   */
  private acceptRoom(handover: Handover, raise: EndBeatRaise, roomId: string): void {
    const { agent } = handover;
    const person = this.deps.chainPersonOf(agent.id);
    const now = this.clock.now();
    const waits =
      raise.urgent === true
        ? this.urgentTime(person, now) > now
        : this.deps.roomReachesPerson(roomId, raise.text) &&
          deliveryTime(this.deps.presenceOf(person), now) > now;
    if (waits) {
      this.hold(handover, raise, person, 'room', roomId);
      return;
    }
    const posted = this.deps.postToRoom(agent, roomId, raise.text, handover.chatSessionId);
    this.recordNow(
      agent,
      posted,
      'Posted a raise in a room.',
      raise.urgent ? raise.text : undefined
    );
    if (posted.ok) {
      const at = new Date(now).toISOString();
      this.deps.store.insertDelivered(
        {
          ...this.rowFields(handover, raise, at),
          id: (this.deps.mintId ?? randomUUID)(),
          agentId: agent.id,
          toAccount: person,
          rung: 'room',
          key: raiseKey(raise),
          roomId,
          createdAt: at,
        },
        at,
        posted.entryId
      );
      return;
    }
    // Refused: what it wanted to say reaches its manager instead, in their hours.
    const manager = this.deps.managerOf(agent.id);
    const fallback = this.deps.isAgent(manager) ? person : manager;
    this.hold(handover, { ...raise, urgent: false }, fallback, 'dm', null, posted.reason);
  }

  /** Queue a raise to a person: now if it may go now, else at the start of their hours. */
  private hold(
    handover: Handover,
    raise: EndBeatRaise,
    to: string,
    rung: NewOutboxRow['rung'],
    roomId: string | null,
    fallbackReason?: string
  ): void {
    const { agent } = handover;
    const now = this.clock.now();
    const urgent = raise.urgent === true;
    const key = raiseKey(raise);
    const earlier = this.deps.store.findHeld({
      agentId: agent.id,
      toAccount: to,
      key,
      rung,
      roomId,
    });
    const { deliverAfter, ceiling } = this.timeFor(to, rung, urgent, now, earlier?.id);
    const row = this.rowFields(handover, raise, new Date(deliverAfter).toISOString());
    const id = earlier?.id ?? (this.deps.mintId ?? randomUUID)();
    if (earlier) this.deps.store.refreshHeld(id, row);
    else {
      this.deps.store.insertOutbox({
        ...row,
        id,
        agentId: agent.id,
        toAccount: to,
        rung,
        key,
        roomId,
        state: 'held',
        createdAt: new Date(now).toISOString(),
      });
    }
    if (rung === 'report') this.reportChats.set(id, handover.chatSessionId);
    this.recordHeld(agent, {
      urgent,
      ceiling,
      deliverAfter,
      now,
      text: raise.text,
      fallbackReason,
    });
  }

  /** The fields a raise's row carries, whatever its rung. */
  private rowFields(handover: Handover, raise: EndBeatRaise, deliverAfter: string) {
    return {
      text: raise.text,
      urgent: raise.urgent === true ? 1 : 0,
      deliverAfter,
      about: raise.about ? JSON.stringify(raise.about) : null,
      beatId: handover.beatId,
    };
  }

  /** When a held raise may go: at once to an agent, else by urgency or hours. */
  private timeFor(
    to: string,
    rung: NewOutboxRow['rung'],
    urgent: boolean,
    now: number,
    replacing?: string
  ): { deliverAfter: number; ceiling: boolean } {
    if (rung === 'report') return { deliverAfter: now, ceiling: false };
    if (!urgent)
      return { deliverAfter: deliveryTime(this.deps.presenceOf(to), now), ceiling: false };
    const deliverAfter = this.urgentTime(to, now, replacing);
    return { deliverAfter, ceiling: deliverAfter > now };
  }

  /** When an urgent message to a person may go: now, unless their hour's share is spent. */
  private urgentTime(to: string, now: number, replacing?: string): number {
    const since = new Date(now - HOUR_MS).toISOString();
    return urgentDeliveryTime(this.deps.store.urgentMoments(to, since, replacing), now);
  }

  /** The record line for a raise that was queued. */
  private recordHeld(
    agent: BeatAgent,
    held: {
      urgent: boolean;
      ceiling: boolean;
      deliverAfter: number;
      now: number;
      text: string;
      fallbackReason?: string;
    }
  ): void {
    if (held.urgent && !held.ceiling) {
      recordHeartbeatEvent({
        action: 'heartbeat.raised',
        agent,
        actAsAgent: true,
        summary: 'Raised something urgent.',
        reason: held.text,
      });
      return;
    }
    if (held.deliverAfter <= held.now && !held.fallbackReason) return;
    const when = new Date(held.deliverAfter).toISOString();
    recordHeartbeatEvent({
      action: 'heartbeat.held',
      agent,
      actAsAgent: true,
      summary: held.ceiling
        ? `Held an urgent message until ${when}: this person had six urgent messages this hour.`
        : held.fallbackReason
          ? 'A room refused its post, so it went to its manager instead.'
          : `Held a message for ${when}, the start of their hours.`,
      reason: held.ceiling ? 'ceiling' : held.fallbackReason,
    });
  }

  /**
   * Close earlier held raises the agent says are settled.
   *
   * @param agentId - The agent.
   * @param keys - The raise keys.
   */
  resolve(agentId: string, keys: readonly string[]): void {
    this.deps.store.resolveRaises(agentId, keys, new Date(this.clock.now()).toISOString());
  }

  /**
   * The raises an agent is still waiting on: delivered to people in the last
   * 14 days and not resolved, newest first. The beat prompt reads them through
   * {@link BeatOutboxPort.openRaises}, the one seam a richer raise store swaps.
   *
   * @param agentId - The agent.
   */
  openRaises(agentId: string): OpenRaise[] {
    const since = new Date(this.clock.now() - OPEN_RAISE_MS).toISOString();
    return this.deps.store.openRaises(agentId, since, OPEN_RAISES_MAX);
  }

  /**
   * The runner's own raise when an agent's beats keep failing (§7.5): once, to
   * its chain person, not urgent, with the error.
   *
   * @param agent - The agent.
   * @param beatId - The beat that tipped it over.
   * @param error - What the last failed turn said, when known.
   */
  async raiseFailing(agent: BeatAgent, beatId: string, error?: string): Promise<void> {
    await this.accept({
      agent,
      beatId,
      chatSessionId: '',
      raises: [
        {
          text: `${agent.name}'s beats are failing: ${error ?? 'its last three beat turns ended with an error.'}`,
          to: this.deps.chainPersonOf(agent.id),
          rung: 'dm',
          urgent: false,
          key: `beat-failing:${agent.id}`,
        },
      ],
    });
  }

  /**
   * Deliver every held raise that has come due, batched per agent and reader.
   * One that arrives mid-tick goes out in a second pass before this resolves.
   */
  tick(): Promise<void> {
    if (!this.deps.enabled()) return Promise.resolve();
    if (this.ticking) {
      this.tickAgain = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      do {
        this.tickAgain = false;
        await this.deliverDue();
      } while (this.tickAgain);
    })().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  /** The tick's body. */
  private async deliverDue(): Promise<void> {
    const now = this.clock.now();
    const groups = new Map<string, HeartbeatOutboxRow[]>();
    for (const row of this.deps.store.dueOutbox(new Date(now).toISOString())) {
      // Hours may have moved since the row was held (a new away, a new zone).
      // An agent keeps none.
      if (!row.urgent && row.rung !== 'report') {
        const when = deliveryTime(this.deps.presenceOf(row.toAccount), now);
        if (when > now) {
          this.deps.store.rescheduleOutbox(row.id, new Date(when).toISOString());
          continue;
        }
      }
      const groupKey = [row.agentId, row.toAccount, row.rung, row.roomId ?? ''].join('\u0000');
      groups.set(groupKey, [...(groups.get(groupKey) ?? []), row]);
    }
    for (const rows of groups.values()) await this.deliverGroup(rows, now);
  }

  /** Deliver one agent's due rows to one reader as one message. */
  private async deliverGroup(rows: HeartbeatOutboxRow[], now: number): Promise<void> {
    const first = rows[0]!;
    const at = new Date(now).toISOString();
    const ids = rows.map((row) => row.id);
    const agent = this.deps.agentOf(first.agentId);
    if (!agent) {
      this.deps.store.closeOutbox(ids, 'dropped', at);
      return;
    }
    const unsent = rows.filter((row) => !this.sent.has(row.id));
    const result: DeliveryResult =
      unsent.length === 0 ? { ok: true } : await this.send(agent, first, unsent);
    if (result.ok) {
      for (const id of ids) {
        this.sent.add(id);
        this.reportChats.delete(id);
      }
      this.deps.store.closeOutbox(ids, 'delivered', at, result.entryId);
      recordHeartbeatEvent({
        action: 'heartbeat.delivered',
        agent,
        actAsAgent: true,
        summary:
          rows.length === 1
            ? 'Delivered one message.'
            : `Delivered ${rows.length} raises as one message.`,
      });
      return;
    }
    this.retryOrDrop(agent, rows, now, result.reason);
  }

  /** Send rows by their rung. Never throws. */
  private async send(
    agent: BeatAgent,
    first: HeartbeatOutboxRow,
    rows: HeartbeatOutboxRow[]
  ): Promise<DeliveryResult> {
    const text = rows.map((row) => row.text).join(BATCH_SEPARATOR);
    try {
      if (first.rung === 'room' && first.roomId) {
        return this.deps.postToRoom(agent, first.roomId, text, '');
      }
      if (first.rung === 'report') {
        // From the beat chat that raised it; after a restart, today's beat chat.
        const chat =
          this.reportChats.get(first.id) ?? this.deps.store.getState(agent.id)?.beatChatId ?? '';
        return await this.deps.sendToAgent(agent, chat, first.toAccount, text);
      }
      return first.rung === 'note'
        ? await this.deps.deliverNote(agent, first.toAccount, text)
        : await this.deps.deliverDm(agent, first.toAccount, text);
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** A failed delivery: try again later, or drop it after the last try. */
  private retryOrDrop(
    agent: BeatAgent,
    rows: HeartbeatOutboxRow[],
    now: number,
    reason: string
  ): void {
    const ids = rows.map((row) => row.id);
    const attempt = Math.max(...rows.map((row) => row.attempts)) + 1;
    const backoff = DELIVERY_BACKOFF_MS[attempt - 1];
    if (backoff !== undefined) {
      this.deps.store.failedAttempt(ids, new Date(now + backoff).toISOString());
      return;
    }
    this.deps.store.closeOutbox(ids, 'dropped', new Date(now).toISOString());
    for (const id of ids) this.reportChats.delete(id);
    recordHeartbeatEvent({
      action: 'heartbeat.raised',
      agent,
      actAsAgent: true,
      outcome: 'failed',
      summary: 'A message could not be delivered after five tries, so it was dropped.',
      reason,
    });
  }

  /** Record a raise that went out at once (a room post, a message to an agent). */
  private recordNow(
    agent: BeatAgent,
    result: DeliveryResult,
    summary: string,
    urgentText?: string
  ): void {
    recordHeartbeatEvent({
      action: result.ok ? 'heartbeat.delivered' : 'heartbeat.raised',
      agent,
      actAsAgent: true,
      outcome: result.ok ? 'ok' : 'failed',
      summary,
      ...(urgentText ? { reason: urgentText } : result.ok ? {} : { reason: result.reason }),
    });
  }
}
