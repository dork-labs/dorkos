/**
 * Opt-in ngrok tunnel lifecycle manager (singleton).
 *
 * Wraps `@ngrok/ngrok` SDK with dynamic import for zero cost when disabled.
 * Extends EventEmitter to broadcast `status_change` events for SSE and
 * cross-tab sync. What to start it WITH is resolved elsewhere, from the
 * environment and the stored config together — see `tunnel-settings.ts`. Tunnel
 * failure is non-blocking.
 *
 * @module services/tunnel-manager
 */
import { EventEmitter } from 'node:events';
// Types only, so the SDK is still loaded lazily and costs nothing when the
// tunnel is off. It is the SDK's OWN option type rather than a hand-written
// copy on purpose: the copy had drifted to `on_status_change`, a key the SDK
// never reads, so DorkOS was never told a tunnel had dropped and reported it as
// connected until someone stopped it (DOR-1738). A misspelled key is now a
// compile error.
import type { Config as NgrokForwardOpts } from '@ngrok/ngrok';
import type { TunnelStatus } from '@dorkos/shared/types';

/** Configuration for starting an ngrok tunnel. */
export interface TunnelConfig {
  port: number;
  authtoken?: string;
  basicAuth?: string;
  domain?: string;
}

/**
 * The stored half of the status — everything except `isRunning`, which is never
 * stored because it is not a fact about the tunnel this object could get wrong:
 * it is whether {@link TunnelManager.listener} exists, composed in on every read.
 */
type StoredStatus = Omit<TunnelStatus, 'isRunning'>;

const DEFAULT_STATUS: StoredStatus = {
  enabled: false,
  connected: false,
  url: null,
  port: null,
  startedAt: null,
  authEnabled: false,
  tokenConfigured: false,
  domain: null,
};

/** Singleton manager for ngrok tunnel lifecycle (start, stop, status). */
export class TunnelManager extends EventEmitter {
  private listener: { close(): Promise<void>; url(): string | null } | null = null;
  private _status: StoredStatus = { ...DEFAULT_STATUS };

  get status(): TunnelStatus {
    return { ...this._status, isRunning: this.isRunning };
  }

  /**
   * Whether a listener is open — the question {@link start} itself answers when
   * it refuses a second one.
   *
   * Not the same as `status.connected`, and the gap is the point.
   * `status.connected` tracks ngrok's own `onStatusChange`, so it goes false
   * for as long as a tunnel is dropped and reconnecting, while the listener
   * stays open and `start()` still throws. A caller deciding whether it may open
   * a tunnel has to read this; reading `status.connected` instead turns a
   * momentary reconnect into a failure (DOR-1738).
   *
   * It rides {@link status} too, so anything reading the tunnel over HTTP or SSE
   * can tell "reconnecting" from "off" — the two look identical through
   * `connected` alone. Composed there rather than stored, so the field and the
   * listener cannot drift apart.
   */
  get isRunning(): boolean {
    return this.listener !== null;
  }

  private updateStatus(partial: Partial<StoredStatus>): void {
    this._status = { ...this._status, ...partial };
    this.emit('status_change', this.status);
  }

  /**
   * Open the tunnel and report its public URL.
   *
   * @param config - Port to forward and the optional ngrok credentials.
   * @throws When a tunnel is already open, when ngrok refuses, or when ngrok
   *   returns a listener with no URL — see below.
   */
  async start(config: TunnelConfig): Promise<string> {
    if (this.listener) throw new Error('Tunnel is already running');

    const ngrok = await import('@ngrok/ngrok');

    const forwardOpts: NgrokForwardOpts = {
      addr: config.port,
      authtoken_from_env: true,
    };

    if (config.authtoken) {
      forwardOpts.authtoken = config.authtoken;
      delete forwardOpts.authtoken_from_env;
    }
    if (config.basicAuth) forwardOpts.basic_auth = [config.basicAuth];
    if (config.domain) forwardOpts.domain = config.domain;

    // The SDK's own spelling — it reads `onStatusChange` and nothing else, and
    // hands it ONE argument (`'connected'`, or `'closed'` on a disconnect).
    forwardOpts.onStatusChange = (status: string) => {
      if (status === 'connected') {
        this.updateStatus({ connected: true });
      } else if (status === 'closed') {
        this.updateStatus({ connected: false });
      }
    };

    const listener = await ngrok.forward(forwardOpts);
    const url = listener.url();

    // A listener with no URL is not a tunnel anyone can reach, and reporting it
    // as one is worse than failing: the app would show Remote Access as on, with
    // an empty address, and every later start would be refused because something
    // unusable was already "running". Close it and say so.
    if (!url) {
      await listener.close().catch(() => {});
      throw new Error('ngrok returned no public URL for the tunnel');
    }

    this.listener = listener;
    this.updateStatus({
      enabled: true,
      connected: true,
      url,
      port: config.port,
      startedAt: new Date().toISOString(),
      authEnabled: !!config.basicAuth,
      tokenConfigured: !!config.authtoken,
      domain: config.domain ?? null,
    });
    return url;
  }

  /**
   * Close the tunnel, and leave this manager closed whether or not ngrok
   * cooperated.
   *
   * The reset is in a `finally` because a failing `close()` used to strand the
   * manager: the listener stayed non-null and the status stayed connected, so
   * the tunnel origin went on being trusted, every later `stop()` retried the
   * same doomed close, and every `start()` was refused as already running
   * (DOR-1738). The error still propagates — the caller decides what to say
   * about it — but the local state is no longer hostage to it.
   */
  async stop(): Promise<void> {
    const listener = this.listener;
    if (!listener) {
      this.updateStatus({ ...DEFAULT_STATUS });
      return;
    }

    try {
      await listener.close();
    } finally {
      this.listener = null;
      this.updateStatus({ ...DEFAULT_STATUS });
    }
  }
}

export const tunnelManager = new TunnelManager();
