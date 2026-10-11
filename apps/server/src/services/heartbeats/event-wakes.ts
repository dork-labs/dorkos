/**
 * Event wakes (spec `heartbeats` §3.3): something happened that an agent should
 * look at, so it beats now rather than at its next timed beat.
 *
 * Each source is hooked where the fact already exists, with a one-line call to
 * {@link wakeAgent} (or {@link wakeAgentAt} when the source knows the agent by
 * its home directory). This module is the hub: light enough for any domain to
 * import, and a no-op until the runner {@link EventWakes.install}s itself, so a
 * source never has to know whether heartbeats are running.
 *
 * - **Coalesced.** Events for one agent within {@link WAKE_COALESCE_MS} become
 *   one beat, run when the window closes.
 * - **Failures wake once a day.** A failure source (a failed run, a failed turn,
 *   a lost connection) wakes an agent at most once per source per local day, so
 *   a schedule failing every hour wakes it once, not hourly (§7.5).
 * - **Strangers never wake a beat.** A source decides that before calling: the
 *   room hook only fires for a local author, and nothing else here reads a
 *   message from outside.
 *
 * @module services/heartbeats/event-wakes
 */
import type { BeatWake } from './beat-runner.js';
import type { BeatClock } from './beat-scheduler.js';

/** How long events for one agent are gathered into one beat. */
export const WAKE_COALESCE_MS = 60_000;

/** What woke an agent. */
export type WakeEventType =
  | 'room-mention'
  | 'commitment-due'
  | 'run-failed'
  | 'turn-failed'
  | 'connection-lost'
  | 'reports-to-changed';

/** Sources that wake an agent at most once per source per local day. */
const FAILURE_TYPES: ReadonlySet<WakeEventType> = new Set([
  'run-failed',
  'turn-failed',
  'connection-lost',
]);

/** One event for one agent. */
export interface WakeEvent {
  /** What happened. */
  type: WakeEventType;
  /** The fact's id (an entry, a run, a commitment), for the record's `causedBy`. */
  eventId?: string;
  /** For a failure: which source failed (a schedule id, a connection id). */
  source?: string;
  /** For `reports-to-changed`: the stored `reportsTo` before and after. */
  managerChange?: { before: string | null; after: string | null };
}

/** What the hub needs from the running server. */
export interface EventWakeDeps {
  /** The clock. */
  clock: BeatClock;
  /** The agent's local day (`YYYY-MM-DD`) at a moment, in its chain person's zone. */
  localDay(agentId: string, at: number): string;
  /** Run the beat. */
  beat(agentId: string, wake: BeatWake): void;
  /** The agent living at a home directory, or undefined. */
  agentIdAt(agentPath: string): string | undefined;
  /** The agents a connection is attached to. */
  agentsForConnection(connectionId: string): string[];
  /**
   * Note that the agent's manager changed: its next beat opens with it, and the
   * old and new manager each get a line in its next report (§4.2).
   */
  noteNewManager(agentId: string, event: WakeEvent): void;
  /** Re-arm the agent's timer after its `HEARTBEAT.md` changed. */
  refresh(agentId: string): void;
}

/** One agent's gathering window. */
interface Pending {
  handle: unknown;
  first: WakeEvent;
}

/** The running hub. */
export class EventWakes {
  private readonly pending = new Map<string, Pending>();
  /** Per agent: the local day, and the failure sources that woke it that day. */
  private readonly failureDays = new Map<string, { day: string; keys: Set<string> }>();

  /**
   * Build the hub.
   *
   * @param deps - What it reaches.
   */
  constructor(private readonly deps: EventWakeDeps) {}

  /** Make this the hub every source's call reaches. */
  install(): void {
    setActiveHub(this);
  }

  /** Stop: clear every window and stop answering sources. */
  uninstall(): void {
    for (const pending of this.pending.values()) this.deps.clock.clearTimeout(pending.handle);
    this.pending.clear();
    if (active === this) setActiveHub(undefined);
  }

  /** How many windows are open. */
  get openWindows(): number {
    return this.pending.size;
  }

  /**
   * An event for an agent.
   *
   * @param agentId - The agent.
   * @param event - What happened.
   */
  wake(agentId: string, event: WakeEvent): void {
    const now = this.deps.clock.now();
    if (FAILURE_TYPES.has(event.type) && !this.firstFailureToday(agentId, event, now)) return;
    if (event.type === 'reports-to-changed') this.deps.noteNewManager(agentId, event);
    if (this.pending.has(agentId)) return;
    const handle = this.deps.clock.setTimeout(() => {
      const held = this.pending.get(agentId);
      this.pending.delete(agentId);
      if (!held) return;
      this.deps.beat(agentId, {
        wake: `event:${held.first.type}`,
        ...(held.first.eventId ? { causedBy: held.first.eventId } : {}),
      });
    }, WAKE_COALESCE_MS);
    this.pending.set(agentId, { handle, first: event });
  }

  /**
   * Whether this failure source has not woken the agent yet today. A new day
   * starts the agent's set afresh, so the map holds one day per agent.
   *
   * @param agentId - The agent.
   * @param event - The failure.
   * @param now - Epoch ms.
   */
  private firstFailureToday(agentId: string, event: WakeEvent, now: number): boolean {
    const day = this.deps.localDay(agentId, now);
    let today = this.failureDays.get(agentId);
    if (today?.day !== day) {
      today = { day, keys: new Set() };
      this.failureDays.set(agentId, today);
    }
    const key = `${event.type}\u0000${event.source ?? ''}`;
    if (today.keys.has(key)) return false;
    today.keys.add(key);
    return true;
  }

  /**
   * An event for the agent living at a home directory.
   *
   * @param agentPath - Its home directory.
   * @param event - What happened.
   */
  wakeAt(agentPath: string, event: WakeEvent): void {
    const agentId = this.deps.agentIdAt(agentPath);
    if (agentId) this.wake(agentId, event);
  }

  /**
   * An agent's `HEARTBEAT.md` changed through DorkOS: re-arm its timer now, so
   * `wake: timed` starts beating without waiting for an event.
   *
   * @param agentId - The agent.
   */
  fileChanged(agentId: string): void {
    this.deps.refresh(agentId);
  }

  /**
   * A connection lost access: wake every agent it is attached to.
   *
   * @param connectionId - The connection.
   */
  connectionLost(connectionId: string): void {
    for (const agentId of this.deps.agentsForConnection(connectionId)) {
      this.wake(agentId, { type: 'connection-lost', source: connectionId });
    }
  }
}

/** The hub sources reach, once the runner installed one. */
let active: EventWakes | undefined;

/** Room entries the outbox posted for a beat, so they never wake a beat back. */
const beatRoomPosts = new Set<string>();

/** The most beat post ids remembered; the oldest go first. */
const BEAT_ROOM_POSTS_MAX = 1000;

/**
 * Remember that a room entry was posted by a beat (the outbox's `room` rung).
 *
 * @param entryId - The posted entry.
 */
export function noteBeatRoomPost(entryId: string): void {
  beatRoomPosts.add(entryId);
  if (beatRoomPosts.size > BEAT_ROOM_POSTS_MAX) {
    beatRoomPosts.delete(beatRoomPosts.values().next().value as string);
  }
}

/**
 * Whether a room entry was posted by a beat's outbox.
 *
 * @param entryId - The entry.
 */
export function isBeatRoomPost(entryId: string): boolean {
  return beatRoomPosts.has(entryId);
}

/**
 * Swap the hub sources reach.
 *
 * @param hub - The running hub, or undefined to stop answering.
 */
function setActiveHub(hub: EventWakes | undefined): void {
  active = hub;
}

/**
 * Wake an agent: what every event source calls. Does nothing while heartbeats
 * are not running.
 *
 * @param agentId - The agent's Mesh id.
 * @param event - What happened.
 */
export function wakeAgent(agentId: string, event: WakeEvent): void {
  active?.wake(agentId, event);
}

/**
 * Wake the agent living at a home directory, for sources that know it that way.
 *
 * @param agentPath - Its home directory.
 * @param event - What happened.
 */
export function wakeAgentAt(agentPath: string, event: WakeEvent): void {
  active?.wakeAt(agentPath, event);
}

/**
 * A connection lost access (expired or revoked): wake the agents it serves.
 *
 * @param connectionId - The connection.
 */
export function wakeAgentsForConnection(connectionId: string): void {
  active?.connectionLost(connectionId);
}

/**
 * An agent's `HEARTBEAT.md` was written through DorkOS: its rhythm may have
 * changed, so its timer is re-armed. Does nothing while heartbeats are off.
 *
 * @param agentId - The agent's Mesh id.
 */
export function heartbeatFileChanged(agentId: string): void {
  active?.fileChanged(agentId);
}
