/**
 * How many chats started from the web may have a turn going at once, as
 * admission reads it (spec `turns-survive-restarts` §3.5, T6). A message that
 * opens a chat through the session relay (`{ kind: 'session-relay', newChat:
 * true }`) and finds every slot taken waits as `machine_full`, and goes when one
 * frees, where the relay used to refuse it (`RELAY_TOO_MANY_NEW_CHATS`).
 *
 * The limit is the relay's own: a send is answered long before its turn ends,
 * so without it a hub could start chats without end. The slot mechanics are the
 * scheduler cap's (`schedule-cap.ts`): claimed in the same synchronous step as
 * admission's go, kept while the run is handed over, launching or running, and
 * let go when its turn is over, when it goes back in line, or when the
 * hand-over did not take.
 *
 * @module services/runs/web-chat-cap
 */
import type { RunStatus } from '@dorkos/shared/turn-port';
import { WEB_NEW_CHATS_MAX } from '@dorkos/shared/turn-hand-over';
import type { TurnRun } from './run-store.js';

/** The statuses a claimed slot is kept through: handed over, launching, running. */
const HOLDING: ReadonlySet<RunStatus> = new Set(['queued', 'starting', 'started', 'running']);

/** Whether a run opens a chat started from the web. */
export function opensWebChat(run: Pick<TurnRun, 'origin'>): boolean {
  return run.origin?.kind === 'session-relay' && run.origin.newChat === true;
}

/** The cap. See the module documentation. */
export class WebChatCap {
  private readonly claimed = new Set<string>();

  /**
   * Build the cap.
   *
   * @param freed - Called when a slot frees, so the runs waiting for one look again.
   * @param limit - The most such chats at once; the relay's own limit unless a test sets one.
   */
  constructor(
    private readonly freed: () => void,
    private readonly limit: () => number = () => WEB_NEW_CHATS_MAX
  ) {}

  /** Whether every slot is taken. */
  full(): boolean {
    return this.claimed.size >= this.limit();
  }

  /**
   * Take a slot for a run admission just let go. Only a run that opens a chat
   * from the web takes one.
   *
   * @param run - The run.
   */
  claim(run: Pick<TurnRun, 'id' | 'origin'>): void {
    if (opensWebChat(run)) this.claimed.add(run.id);
  }

  /**
   * Let a run's slot go: its hand-over did not take.
   *
   * @param runId - The run.
   */
  release(runId: string): void {
    if (this.claimed.delete(runId)) this.freed();
  }

  /**
   * A run moved: its slot goes once its turn is over, or when it went back in
   * line from a launch (it claims again when admission next lets it go).
   *
   * @param run - The run, as stored after the move.
   * @param from - The status it left.
   */
  onRunMoved(run: TurnRun, from: RunStatus): void {
    if (!this.claimed.has(run.id)) return;
    const backInLine = run.status === 'queued' && from !== 'queued';
    if (!HOLDING.has(run.status) || backInLine) this.release(run.id);
  }
}
