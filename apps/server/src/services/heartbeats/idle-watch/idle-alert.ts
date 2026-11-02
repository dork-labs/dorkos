/**
 * "Nothing is running" (DOR-3675): one line in the team room when no agent chat on this computer
 * has run for {@link IDLE_ALERT_AFTER_MS} while open work is still there.
 *
 * On 2026-11-02, from about 08:00Z to 13:06Z, no chat ran while 10 PRs were open, and nobody
 * noticed until Dorian looked. The beats (DOR-3674) wake one agent at a time; this is the
 * computer-wide backstop a person sees.
 *
 * - **What counts as running:** any agent chat mid-turn on this computer, a beat's turn
 *   included, since that is work running too.
 * - **What counts as open work:** chats a `session_start` opened in the last three days, and
 *   open promises. There is no PR count yet: that waits on Security's ruling on reading GitHub
 *   from the server.
 * - **Once per stall:** after it posts, it stays quiet until a chat has run in between.
 * - **What it says:** one fixed line, with counts and minutes only. Never a chat's reason or a
 *   promise's words, which can come from a room (Security on DOR-3675).
 * - **Who says it:** DorkOS, as a room notice. It names no one, so it starts and wakes nothing.
 * - **Where:** the room in `heartbeats.idleAlertRoomId`, a setting only a person can change,
 *   or the team room when none is set. An archived or missing room gets no post.
 *
 * A restart forgets when a chat last ran, so the clock then starts at the restart and never
 * claims idleness it did not see.
 *
 * @module services/heartbeats/idle-watch/idle-alert
 */

/** How long nothing may run, with work open, before the room hears it. */
export const IDLE_ALERT_AFTER_MS = 30 * 60 * 1000;

/** How often the watch looks. */
export const IDLE_ALERT_CHECK_MS = 5 * 60 * 1000;

/** The open work the line counts. */
export interface OpenWorkCounts {
  /** Chats a `session_start` opened in the last three days. */
  lanes: number;
  /** Open promises, every agent's. */
  promises: number;
}

/** What the watch reads and does. */
export interface IdleAlertDeps {
  /** Whether heartbeats are on: off, the watch says nothing. */
  enabled: () => boolean;
  /**
   * Whether an agent chat on this computer is mid-turn now (`'running'`), else when one was
   * last seen active (ms), or undefined when this process saw none.
   */
  chatActivity: () => 'running' | number | undefined;
  /** The open work now. */
  openWork: () => Promise<OpenWorkCounts>;
  /** The room to post in, or null when there is none to post in. */
  targetRoom: () => string | null;
  /** Post one DorkOS notice in a room. */
  postNotice: (roomId: string, text: string) => void;
  /** The clock (ms). */
  now: () => number;
}

/**
 * The one line it posts: counts and minutes only.
 *
 * @param idleMs - How long nothing has run.
 * @param counts - The open work.
 */
export function idleAlertText(idleMs: number, counts: OpenWorkCounts): string {
  const minutes = Math.floor(idleMs / 60_000);
  const lanes = `${counts.lanes} ${counts.lanes === 1 ? 'chat' : 'chats'} started in the last 3 days`;
  const promises = `${counts.promises} open ${counts.promises === 1 ? 'promise' : 'promises'}`;
  return `No agent chat has run on this computer for ${minutes} min. Open work: ${lanes}, ${promises}.`;
}

/** One watch: call `check` on a timer. */
export interface IdleAlertWatch {
  /** Look once; posts at most one line. */
  check(): Promise<void>;
}

/**
 * Build the watch.
 *
 * @param deps - What it reads and how it posts.
 */
export function createIdleAlertWatch(deps: IdleAlertDeps): IdleAlertWatch {
  let lastRunSeen = deps.now();
  let alerted = false;
  return {
    async check() {
      const now = deps.now();
      const activity = deps.chatActivity();
      if (activity === 'running') {
        lastRunSeen = now;
        alerted = false;
        return;
      }
      // A chat that ran and ended between two looks still counts as having run.
      if (activity !== undefined && activity > lastRunSeen) {
        lastRunSeen = activity;
        alerted = false;
      }
      if (alerted || !deps.enabled() || now - lastRunSeen < IDLE_ALERT_AFTER_MS) return;
      const counts = await deps.openWork();
      if (counts.lanes + counts.promises === 0) return;
      const roomId = deps.targetRoom();
      if (roomId === null) return;
      deps.postNotice(roomId, idleAlertText(now - lastRunSeen, counts));
      alerted = true;
    },
  };
}
