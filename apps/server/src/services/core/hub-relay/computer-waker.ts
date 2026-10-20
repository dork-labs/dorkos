/**
 * Waking a linked computer that is not connected (B1, DOR-2944): when the
 * owner opens one of its chats on the hub, DorkOS Cloud tells the computer a
 * viewer is open, and it dials its pinned hub.
 *
 * The call to Cloud is injected through {@link setHubRelayWaker}, the same way
 * the signing key is, so this module never holds a Cloud client or a key.
 * Until it is set, nothing is woken and the page just hears "waking". Each
 * computer is woken at most once per {@link HUB_RELAY_WAKE_DEBOUNCE_MS}, so a
 * page that retries every few seconds does not become a stream of wakes.
 *
 * @module services/core/hub-relay/computer-waker
 */
import { logger } from '../../../lib/logger.js';

/** The shortest time between two wakes of one computer. */
export const HUB_RELAY_WAKE_DEBOUNCE_MS = 10_000;

/** Asks DorkOS Cloud to tell one computer that a viewer is open. */
export type HubRelayWake = (computerId: string) => Promise<void>;

/** What the waker reads, injectable for tests. */
export interface ComputerWakerDeps {
  /** The injected wake, or `null` while there is none. */
  wake: () => HubRelayWake | null;
  /** The clock; defaults to `Date.now`. */
  now?: () => number;
}

/** Wakes computers, at most once per computer per debounce window. */
export class ComputerWaker {
  private readonly lastWake = new Map<string, number>();

  /**
   * Start with no computer woken yet.
   *
   * @param deps - The wake to call, and the clock.
   */
  constructor(private readonly deps: ComputerWakerDeps) {}

  /**
   * Wake a computer unless it was woken within the debounce window. Never
   * throws and never waits: a failed wake is logged by its error name only.
   *
   * @param computerId - The computer to wake.
   * @returns Whether a wake was sent.
   */
  wake(computerId: string): boolean {
    const wake = this.deps.wake();
    if (!wake) return false;
    const now = (this.deps.now ?? Date.now)();
    const last = this.lastWake.get(computerId);
    if (last !== undefined && now - last < HUB_RELAY_WAKE_DEBOUNCE_MS) return false;
    this.lastWake.set(computerId, now);
    try {
      void wake(computerId).catch(logWakeFailure);
    } catch (error) {
      logWakeFailure(error);
    }
    return true;
  }
}

function logWakeFailure(error: unknown): void {
  logger.warn('[HubRelay] Could not wake a linked computer', {
    error: error instanceof Error ? error.name : 'unknown',
  });
}

let injectedWake: HubRelayWake | null = null;

/**
 * Give the relay the call that wakes a computer through DorkOS Cloud. **The
 * one wiring point for waking**: until it is called, a computer that is not
 * connected is not woken. Pass `null` to withdraw it.
 *
 * @param wake - Tells DorkOS Cloud that a viewer is open for this computer.
 */
export function setHubRelayWaker(wake: HubRelayWake | null): void {
  injectedWake = wake;
}

/** The live waker, reading whatever {@link setHubRelayWaker} set. */
export const hubComputerWaker = new ComputerWaker({ wake: () => injectedWake });
