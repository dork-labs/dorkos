/**
 * Whether someone is using this computer from the web right now (spec
 * `everything-is-a-space` step B3, "remote session active"): the relay is
 * connected and the hub reports at least one chat of this computer open.
 *
 * The dialer reports each change of its connection and of the hub's viewer
 * count ({@link RelayPresence.update}); this keeps when the stretch began and
 * calls {@link RelayPresenceOptions.onChange} once per change of what the app
 * shows, which the live tracker puts on the global event stream. The browsers
 * listed are the ones seen since the stretch began, from the device store.
 *
 * @module services/core/session-relay/relay-presence
 */
import type { SessionRelayPresence } from '@dorkos/shared/session-relay-link';
import type { RelayDeviceStore } from './relay-devices.js';

/** What the dialer reports. */
export interface RelayLinkState {
  /** Whether the relay connection is open and proved. */
  connected: boolean;
  /** Chats of this computer open on the hub, as it last reported. */
  viewers: number;
}

/** What the tracker reads and calls. */
export interface RelayPresenceOptions {
  /** The devices seen here. */
  devices: Pick<RelayDeviceStore, 'list'>;
  /** Told the new presence each time it changes. */
  onChange?: (presence: SessionRelayPresence) => void;
  /** The clock; injectable for tests. */
  now?: () => number;
}

/** Tracks whether a remote session is active on this computer. */
export class RelayPresence {
  private since: string | null = null;
  /** The devices already shown in this stretch, so a repeat request says nothing new. */
  private readonly shown = new Set<string>();

  /**
   * Hold the tracker's options.
   *
   * @param options - See {@link RelayPresenceOptions}.
   */
  constructor(private readonly options: RelayPresenceOptions) {}

  /** Whether a remote session is active now. */
  get active(): boolean {
    return this.since !== null;
  }

  /**
   * The dialer's connection or viewer count changed.
   *
   * @param state - The connection and the hub's viewer count now.
   */
  update(state: RelayLinkState): void {
    const active = state.connected && state.viewers > 0;
    if (active === this.active) return;
    this.since = active ? new Date((this.options.now ?? Date.now)()).toISOString() : null;
    this.shown.clear();
    this.changed();
  }

  /**
   * A relayed request named a device, already recorded in the store. While
   * active, the first request from each device in the stretch changes the list.
   *
   * @param deviceId - The device's id.
   */
  deviceSeen(deviceId: string): void {
    if (!this.active || this.shown.has(deviceId)) return;
    this.shown.add(deviceId);
    this.changed();
  }

  /** What the app shows now. */
  snapshot(): SessionRelayPresence {
    const since = this.since;
    if (since === null) return { active: false, devices: [] };
    return {
      active: true,
      since,
      devices: this.options.devices.list().filter((device) => device.lastSeenAt >= since),
    };
  }

  private changed(): void {
    this.options.onChange?.(this.snapshot());
  }
}
