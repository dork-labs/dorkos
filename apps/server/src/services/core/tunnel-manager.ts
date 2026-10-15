/**
 * Opt-in ngrok tunnel lifecycle manager (singleton).
 *
 * Wraps `@ngrok/ngrok` SDK with dynamic import for zero cost when disabled.
 * Extends EventEmitter to broadcast `status_change` events for SSE and
 * cross-tab sync. What to start it WITH is resolved elsewhere, from the
 * environment and the stored config together — see `tunnel-settings.ts`. Tunnel
 * failure is non-blocking.
 *
 * It owns BOTH kinds of remote access, and is the one place that guarantees
 * they never run together (`getMode()`: `off | byo | managed`):
 *
 * - **BYO** — the person's own ngrok account: {@link TunnelManager.start} /
 *   {@link TunnelManager.stop}, one `ngrok.forward` listener at the main port.
 *   Unchanged by managed access.
 * - **Managed** — DorkOS remote access: {@link TunnelManager.startManaged} hands
 *   it to `services/core/remote/managed-forwarding.ts`, which holds its OWN
 *   ngrok session (never the SDK's global one BYO uses), one listener per
 *   hostname the credential allows, all forwarding into the managed ingress
 *   rather than the main port, so every managed request passes the edge-proof
 *   and host checks first. This class keeps the queue both kinds share.
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
import type { RemoteAccessMode } from '@dorkos/shared/config-schema';
import type { ManagedIngress } from './remote/managed-ingress.js';
import {
  ManagedForwarding,
  type ManagedCloseOptions,
  type ManagedDrain,
  type ManagedHostsResult,
  type ManagedPhase,
  type ManagedStartInput,
  type ManagedStartResult,
} from './remote/managed-forwarding.js';

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

/** What the manager needs from outside, injectable for tests. */
export interface TunnelManagerDeps {
  /** The exposure guard. Defaults to `canExpose` from `auth/exposure-guard.ts`. */
  canExpose?: () => boolean | Promise<boolean>;
}

/** The person's own-account ngrok listener, as far as this manager uses it. */
type ByoListener = { close(): Promise<void>; url(): string | null };

/** Singleton manager for ngrok tunnel lifecycle (start, stop, status). */
export class TunnelManager extends EventEmitter {
  private listener: ByoListener | null = null;
  /**
   * An own-account listener ngrok refused to close, by its own close and by
   * `disconnect` alike. It may still be forwarding, so managed access stays
   * closed — and the mode stays `byo` — until a later close of it succeeds.
   */
  private byoUnclosed: ByoListener | null = null;
  private _status: StoredStatus = { ...DEFAULT_STATUS };
  private readonly managedForwarding = new ManagedForwarding({
    exposureAllowed: () => this.exposureAllowed(),
    ownTunnelOpen: () => this.listener !== null || this.byoUnclosed !== null,
    closeOwnTunnel: () => this.closeByo(),
    emitStatus: () => this.emit('status_change', this.status),
    managedClosed: (event) => this.emit('managed_closed', event),
  });
  /** Bumped by every own-account close, so an open a stop overtook can tell. */
  private byoEpoch = 0;
  /** Opens of either kind and host changes run one at a time; closes never wait. */
  private openQueue: Promise<unknown> = Promise.resolve();
  private readonly deps: TunnelManagerDeps;

  constructor(deps: TunnelManagerDeps = {}) {
    super();
    this.deps = deps;
  }

  get status(): TunnelStatus {
    return (
      this.managedForwarding.status() ?? {
        ...this._status,
        isRunning: this.isRunning,
        mode: this.getMode(),
      }
    );
  }

  /**
   * Which forwarding is open: none, the person's own tunnel, or managed access.
   * An own tunnel ngrok would not close counts as open, because it may be.
   */
  getMode(): RemoteAccessMode {
    if (this.listener || this.byoUnclosed) return 'byo';
    if (this.managedForwarding.isOpen) return 'managed';
    return 'off';
  }

  /** Where the managed session is, or `null` when managed access is not open. */
  getManagedPhase(): ManagedPhase | null {
    return this.managedForwarding.phase;
  }

  /** The generation of the open managed session, or `null`. */
  getManagedGeneration(): number | null {
    return this.managedForwarding.generation;
  }

  /** The gentle close under way, or `null` when none has named a deadline. */
  getManagedDrain(): ManagedDrain | null {
    return this.managedForwarding.drain;
  }

  /**
   * Every hostname managed access serves (or is opening) right now, lower case.
   * Read by `lib/trusted-origins.ts`, so each joins the trusted origins, the
   * host guard and CORS while it is served, and leaves them when it is not.
   */
  get managedHosts(): readonly string[] {
    return this.managedForwarding.hosts;
  }

  /**
   * Attach the managed ingress the managed session forwards into. Called once,
   * by `index.ts`, after the app exists; until then managed access refuses to open.
   *
   * @param ingress - The ingress listener.
   */
  attachManagedIngress(ingress: ManagedIngress): void {
    this.managedForwarding.attachIngress(ingress);
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
    return this.listener !== null || this.managedForwarding.isOpen;
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
  start(config: TunnelConfig): Promise<string> {
    // The same queue as managed opens, so the two can never both be opening
    // and both end up open. The close count is read NOW: a stop() issued while
    // this waits in the queue still wins.
    const epoch = this.byoEpoch;
    return this.enqueue(() => this.openByo(config, epoch));
  }

  private byoForwardOptions(config: TunnelConfig): NgrokForwardOpts {
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
    return forwardOpts;
  }

  private async openByo(config: TunnelConfig, epoch: number): Promise<string> {
    if (this.listener) throw new Error('Tunnel is already running');
    // Never both: the person's own tunnel does not open over managed access.
    if (this.managedForwarding.isOpen)
      throw new Error('DorkOS remote access is open. Close it first.');
    if (epoch !== this.byoEpoch) throw new Error('The tunnel was closed while it was opening.');

    const ngrok = await import('@ngrok/ngrok');
    const listener = await ngrok.forward(this.byoForwardOptions(config));
    const url = listener.url();

    // A listener with no URL is not a tunnel anyone can reach, and reporting it
    // as one is worse than failing: the app would show Remote Access as on, with
    // an empty address, and every later start would be refused because something
    // unusable was already "running". Close it and say so.
    if (!url) {
      await listener.close().catch(() => {});
      throw new Error('ngrok returned no public URL for the tunnel');
    }
    // A stop() while ngrok was answering wins: the tunnel it stopped stays shut.
    if (epoch !== this.byoEpoch || this.managedForwarding.isOpen) {
      await listener.close().catch(() => {});
      throw new Error('The tunnel was closed while it was opening.');
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
   *
   * Closes managed access too, at once: shutdown relies on this closing
   * everything. To close only the person's own tunnel, use {@link stopOwnTunnel}.
   */
  async stop(): Promise<void> {
    try {
      // Unconditionally: a managed open still waiting in the queue must be
      // cancelled too, not only one that has already started.
      await this.closeManaged({ immediate: true, reason: 'stopped' });
    } finally {
      // Even when managed access would not close: the own tunnel still closes,
      // and an own-account open waiting in the queue is still cancelled.
      await this.closeByo();
    }
  }

  /**
   * Close the person's own tunnel only, leaving managed access alone — what
   * `POST /api/tunnel/stop` does. Like {@link stop}, the local state is reset
   * even when ngrok fails to close, and the error still propagates.
   */
  stopOwnTunnel(): Promise<void> {
    return this.closeByo();
  }

  /**
   * Close the person's own tunnel, and any earlier one ngrok refused to close.
   * The listener is let go of whatever ngrok says (DOR-1738); one that would
   * not close by `close()` or `disconnect` is kept as {@link byoUnclosed}.
   */
  private async closeByo(): Promise<void> {
    this.byoEpoch += 1;
    const listeners = [this.listener, this.byoUnclosed].filter(
      (listener): listener is ByoListener => listener !== null
    );
    let unclosed: ByoListener | null = null;
    let failure: unknown = null;
    try {
      for (const listener of listeners) {
        const error = await this.closeByoListener(listener);
        if (error !== null) {
          unclosed = listener;
          failure ??= error;
        }
      }
    } finally {
      this.listener = null;
      this.byoUnclosed = unclosed;
      this.updateStatus({ ...DEFAULT_STATUS });
    }
    if (failure !== null) throw failure;
  }

  /** Close one own-account listener, falling back to `disconnect`; the error, or `null` when it closed. */
  private async closeByoListener(listener: ByoListener): Promise<unknown> {
    try {
      await listener.close();
      return null;
    } catch (err) {
      try {
        const url = listener.url();
        if (!url) return err;
        const ngrok = await import('@ngrok/ngrok');
        await ngrok.disconnect(url);
        return null;
      } catch {
        return err;
      }
    }
  }

  // ---------- Managed remote access ----------

  /** Run every open (own-account or managed) and host change one at a time, in order. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.openQueue.then(work, work);
    this.openQueue = run.catch(() => undefined);
    return run;
  }

  private async exposureAllowed(): Promise<boolean> {
    if (this.deps.canExpose) return this.deps.canExpose();
    // Loaded lazily: the exposure guard reads config and the auth store, and
    // this module is imported by `lib/trusted-origins.ts` long before either.
    const { canExpose } = await import('./auth/exposure-guard.js');
    return canExpose();
  }

  /**
   * Open managed remote access, or bring an open one up to date.
   *
   * Refuses — and opens nothing — without a usable edge proof, without a
   * hostname, or when `canExpose()` says no. Closes the person's own tunnel
   * first, and opens nothing if that fails, so the two never overlap. Repeating
   * an open with the same credential opens no second listener for any host: it
   * applies the host set and the proof to what is already open.
   *
   * A different credential replaces the session; the ingress keeps accepting
   * the old edge proof for the contract's overlap window.
   *
   * All-or-nothing: if ngrok refuses the session or any hostname, everything
   * this open started is closed and the result says why.
   *
   * @param input - The credential, its hostnames and edge proof, and the generation.
   */
  startManaged(input: ManagedStartInput): Promise<ManagedStartResult> {
    // Read NOW, so a closeManaged() issued while this waits in the queue wins.
    const closes = this.managedForwarding.closeCount;
    return this.enqueue(() => this.managedForwarding.open(input, closes));
  }

  /**
   * Serve exactly `hosts` on the open managed session: open listeners for new
   * hostnames, close those for removed ones, leave the rest alone. A hostname
   * ngrok refuses is reported in `failed` and not admitted by the ingress.
   *
   * @param hosts - The complete hostname set; compared without regard to case.
   */
  applyHosts(hosts: string[]): Promise<ManagedHostsResult> {
    return this.enqueue(() => this.managedForwarding.applyHosts(hosts));
  }

  /**
   * Stop admitting new managed requests (they get 503) while those already
   * admitted finish. Does not close anything: {@link closeManaged} does.
   */
  beginDrain(): void {
    this.managedForwarding.beginDrain();
  }

  /**
   * Close managed access. `immediate: false` drains first — new requests get
   * 503, admitted ones finish — then closes the listeners; `immediate: true`
   * closes everything now and outranks a drain already under way. Never waits
   * behind a pending open: the open notices and closes what it made.
   *
   * The local state is reset even when ngrok fails to close; the error still
   * propagates so the caller can report the actual outcome. When the session
   * ends, `managed_closed` is emitted with its generation and the reason the
   * first closer named (`ManagedClosedEvent`).
   *
   * @param options - Whether to cut admitted requests rather than let them
   *   finish; for a gentle close, how long they may run (omitted, a bounded
   *   local default applies, and the report says so); and why.
   */
  closeManaged(options: ManagedCloseOptions): Promise<void> {
    return this.managedForwarding.close(options);
  }
}

export const tunnelManager = new TunnelManager();
