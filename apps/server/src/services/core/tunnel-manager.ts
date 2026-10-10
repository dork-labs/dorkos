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
 * - **Managed** — DorkOS remote access: {@link TunnelManager.startManaged} holds
 *   its OWN ngrok session (never the SDK's global one BYO uses), one listener per
 *   hostname the credential allows, all forwarding into the managed ingress
 *   (`services/core/remote/managed-ingress.ts`) rather than the main port, so
 *   every managed request passes the edge-proof and host checks first.
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
import type {
  Listener as NgrokListener,
  Config as NgrokForwardOpts,
  Session as NgrokSession,
} from '@ngrok/ngrok';
import { RemoteEdgeProofSchema, type RemoteEdgeProof } from '@dork-labs/cloud-api';
import type { TunnelMode, TunnelStatus } from '@dorkos/shared/types';
import type { ManagedIngress } from './remote/managed-ingress.js';
import { logger } from '../../lib/logger.js';

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

/** What {@link TunnelManager.startManaged} opens managed access with. */
export interface ManagedStartInput {
  /** The issued tunnel credential value. Never logged, never stored here. */
  value: string;
  /** Every hostname the credential allows; served as one case-insensitive set. */
  hosts: readonly string[];
  /**
   * The edge proof issued with the credential. Optional in the type only
   * because an older service may omit it: managed access is refused without one.
   */
  edgeProof: RemoteEdgeProof | undefined;
  /** The managed generation this open belongs to; timers key off it. */
  generation: number;
}

/** Why managed access did not open. */
export type ManagedStartRefusal =
  /** `canExpose()` said no: login is off or there is no owner account. */
  | 'exposure_not_allowed'
  /** The credential came without a usable edge proof. */
  | 'edge_proof_missing'
  /** The credential named no hostname to serve. */
  | 'no_hosts'
  /** The managed ingress was never attached (the server is not running). */
  | 'ingress_unavailable'
  /** The person's own tunnel could not be closed, so managed access was not opened. */
  | 'byo_close_failed'
  /** ngrok refused the session or a hostname; nothing managed is left open. */
  | 'forward_failed'
  /** A close or a newer open overtook this one; nothing from it is left open. */
  | 'superseded';

/** The outcome of {@link TunnelManager.startManaged}. */
export type ManagedStartResult =
  | { ok: true; url: string; hosts: string[]; generation: number }
  | { ok: false; reason: ManagedStartRefusal; message: string };

/** The outcome of {@link TunnelManager.applyHosts}. */
export interface ManagedHostsResult {
  /** Whether every requested hostname is now served and every other one is not. */
  ok: boolean;
  /** The hostnames served after the change. */
  hosts: string[];
  added: string[];
  removed: string[];
  /** Hostnames ngrok refused to open, or refused to close. */
  failed: string[];
}

/** Where a managed session is in its life. */
export type ManagedPhase = 'opening' | 'open' | 'draining';

/** The managed session's live state. One object per open; replaced, never reused. */
interface ManagedState {
  value: string;
  generation: number;
  phase: ManagedPhase;
  session: NgrokSession | null;
  /** The ingress URL this session forwards into, once open. */
  ingressUrl: string | null;
  /** Lower-case hostname → its ngrok listener. */
  listeners: Map<string, NgrokListener>;
  /** Every hostname served or being opened — what the ingress and trusted origins admit. */
  hosts: Set<string>;
  connected: boolean;
  startedAt: string;
}

/** What the manager needs from outside, injectable for tests. */
export interface TunnelManagerDeps {
  /** The exposure guard. Defaults to `canExpose` from `auth/exposure-guard.ts`. */
  canExpose?: () => boolean | Promise<boolean>;
}

/** Lower-case, trimmed, de-duplicated, order kept; the first is the primary address. */
function normalizeHosts(hosts: readonly string[]): string[] {
  return [...new Set(hosts.map((host) => host.trim().toLowerCase()).filter(Boolean))];
}

function managedRefusal(reason: ManagedStartRefusal, message: string): ManagedStartResult {
  return { ok: false, reason, message };
}

/** Singleton manager for ngrok tunnel lifecycle (start, stop, status). */
export class TunnelManager extends EventEmitter {
  private listener: { close(): Promise<void>; url(): string | null } | null = null;
  private _status: StoredStatus = { ...DEFAULT_STATUS };
  private managed: ManagedState | null = null;
  private ingress: ManagedIngress | null = null;
  /** Bumped by every managed open and close, so an overtaken open can tell. */
  private managedEpoch = 0;
  /** Bumped by every closeManaged(), so an open requested before it can tell. */
  private managedCloses = 0;
  /** Bumped by every own-account close, so an open a stop overtook can tell. */
  private byoEpoch = 0;
  /** Opens of either kind and host changes run one at a time; closes never wait. */
  private managedQueue: Promise<unknown> = Promise.resolve();
  private readonly deps: TunnelManagerDeps;

  constructor(deps: TunnelManagerDeps = {}) {
    super();
    this.deps = deps;
  }

  get status(): TunnelStatus {
    const managed = this.managed;
    if (managed) {
      const primary = [...managed.hosts][0] ?? null;
      return {
        enabled: true,
        connected: managed.phase !== 'opening' && managed.connected,
        isRunning: true,
        url: primary && managed.phase !== 'opening' ? `https://${primary}` : null,
        port: null,
        startedAt: managed.startedAt,
        authEnabled: false,
        tokenConfigured: false,
        domain: primary,
        mode: 'managed',
      };
    }
    return { ...this._status, isRunning: this.isRunning, mode: this.getMode() };
  }

  /** Which forwarding is open: none, the person's own tunnel, or managed access. */
  getMode(): TunnelMode {
    if (this.listener) return 'byo';
    if (this.managed) return 'managed';
    return 'off';
  }

  /** Where the managed session is, or `null` when managed access is not open. */
  getManagedPhase(): ManagedPhase | null {
    return this.managed?.phase ?? null;
  }

  /** The generation of the open managed session, or `null`. */
  getManagedGeneration(): number | null {
    return this.managed?.generation ?? null;
  }

  /**
   * Every hostname managed access serves (or is opening) right now, lower case.
   * Read by `lib/trusted-origins.ts`, so each joins the trusted origins, the
   * host guard and CORS while it is served, and leaves them when it is not.
   */
  get managedHosts(): readonly string[] {
    return this.managed ? [...this.managed.hosts] : [];
  }

  /**
   * Attach the managed ingress the managed session forwards into. Called once,
   * by `index.ts`, after the app exists; until then managed access refuses to open.
   *
   * @param ingress - The ingress listener.
   */
  attachManagedIngress(ingress: ManagedIngress): void {
    this.ingress = ingress;
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
    return this.listener !== null || this.managed !== null;
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
    if (this.managed) throw new Error('DorkOS remote access is open. Close it first.');
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
    if (epoch !== this.byoEpoch || this.managed) {
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
   * Closes managed access too, at once: stopping only ever narrows exposure,
   * and shutdown relies on this closing everything.
   */
  async stop(): Promise<void> {
    // Unconditionally: a managed open still waiting in the queue must be
    // cancelled too, not only one that has already started.
    await this.closeManaged({ immediate: true });
    await this.closeByo();
  }

  /** Close the person's own tunnel only; the reset survives a failing close. */
  private async closeByo(): Promise<void> {
    this.byoEpoch += 1;
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

  // ---------- Managed remote access ----------

  /** Run every open (own-account or managed) and host change one at a time, in order. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.managedQueue.then(work, work);
    this.managedQueue = run.catch(() => undefined);
    return run;
  }

  private async exposureAllowed(): Promise<boolean> {
    if (this.deps.canExpose) return this.deps.canExpose();
    // Loaded lazily: the exposure guard reads config and the auth store, and
    // this module is imported by `lib/trusted-origins.ts` long before either.
    const { canExpose } = await import('./auth/exposure-guard.js');
    return canExpose();
  }

  private emitStatus(): void {
    this.emit('status_change', this.status);
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
    const closes = this.managedCloses;
    return this.enqueue(() => this.openManaged(input, closes));
  }

  /** The refusal for an input that cannot open managed access, or `null`. */
  private async refusalFor(input: ManagedStartInput): Promise<ManagedStartResult | null> {
    if (!input.edgeProof || !RemoteEdgeProofSchema.safeParse(input.edgeProof).success) {
      return managedRefusal(
        'edge_proof_missing',
        'The credential has no edge proof, so managed access stays closed.'
      );
    }
    if (normalizeHosts(input.hosts).length === 0) {
      return managedRefusal('no_hosts', 'The credential names no address to serve.');
    }
    if (!this.ingress) {
      return managedRefusal('ingress_unavailable', 'Managed access is not ready yet.');
    }
    if (!(await this.exposureAllowed())) {
      return managedRefusal(
        'exposure_not_allowed',
        'Turn on login and create an owner account before opening remote access.'
      );
    }
    return null;
  }

  private async openManaged(
    input: ManagedStartInput,
    closesAtRequest: number
  ): Promise<ManagedStartResult> {
    const closedSince = () => this.managedCloses !== closesAtRequest;
    const supersededRefusal = () =>
      managedRefusal('superseded', 'Managed access was closed while opening.');
    const refusal = await this.refusalFor(input);
    if (refusal) return refusal;
    if (closedSince()) return supersededRefusal();
    const edgeProof = input.edgeProof!;
    const hosts = normalizeHosts(input.hosts);
    const ingress = this.ingress!;

    const current = this.managed;
    if (current && current.value === input.value && current.session && current.phase === 'open') {
      return this.refreshManaged(current, input, hosts);
    }

    // Never both: the person's own tunnel closes before any managed listener opens.
    if (this.listener) {
      try {
        await this.closeByo();
      } catch (err) {
        logger.warn('[Tunnel] Could not close the own-account tunnel before managed access', {
          error: err instanceof Error ? err.message : String(err),
        });
        return managedRefusal(
          'byo_close_failed',
          'Your own tunnel did not close, so managed access stayed closed.'
        );
      }
      if (closedSince()) return supersededRefusal();
    }

    if (current && current.phase === 'open') {
      // Another credential replaces this one: its ngrok side closes, and the
      // ingress stays up so the old edge proof keeps its overlap window.
      await this.closeManagedSession(current);
    } else if (current) {
      // Draining: a close is already owed, so finish it now and start clean
      // (a draining ingress must not carry over into a new open).
      await this.closeManaged({ immediate: true }).catch(() => undefined);
    }

    const state: ManagedState = {
      value: input.value,
      generation: input.generation,
      phase: 'opening',
      session: null,
      ingressUrl: null,
      listeners: new Map(),
      hosts: new Set(hosts),
      connected: false,
      startedAt: new Date().toISOString(),
    };
    this.managed = state;
    this.emitStatus();
    return this.connectManaged(state, ++this.managedEpoch, edgeProof, ingress);
  }

  /** The same credential again: new generation and proof, hosts diffed, nothing reopened. */
  private async refreshManaged(
    current: ManagedState,
    input: ManagedStartInput,
    hosts: string[]
  ): Promise<ManagedStartResult> {
    current.generation = input.generation;
    this.ingress!.setEdgeProof(input.edgeProof!);
    const applied = await this.reconcileHosts(current, hosts);
    if (!applied.ok) {
      return managedRefusal('forward_failed', 'Some addresses could not be opened.');
    }
    return {
      ok: true,
      url: `https://${hosts[0]}`,
      hosts: applied.hosts,
      generation: input.generation,
    };
  }

  /**
   * Undo an open that failed or was overtaken: close its session, and close the
   * ingress unless a newer managed open owns it. The ingress closes even when a
   * close already ran, because this open may have started it after that close.
   */
  private async abandonManaged(
    state: ManagedState,
    session: NgrokSession | null,
    reason: ManagedStartRefusal,
    message: string
  ): Promise<ManagedStartResult> {
    await session?.close().catch(() => undefined);
    if (this.managed === state || this.managed === null) {
      const wasOwner = this.managed === state;
      this.managed = null;
      await this.ingress?.close({ immediate: true }).catch(() => undefined);
      if (wasOwner) this.emitStatus();
    }
    return managedRefusal(reason, message);
  }

  /** Open the ingress, the ngrok session and one listener per host, checking for a close after each step. */
  private async connectManaged(
    state: ManagedState,
    epoch: number,
    edgeProof: RemoteEdgeProof,
    ingress: ManagedIngress
  ): Promise<ManagedStartResult> {
    const overtaken = () => epoch !== this.managedEpoch || this.managed !== state;
    const superseded = (session: NgrokSession | null) =>
      this.abandonManaged(state, session, 'superseded', 'Managed access was closed while opening.');
    const hosts = [...state.hosts];

    let session: NgrokSession | null = null;
    try {
      // Checked before the ingress opens, so a close that already ran is never
      // followed by a listener this open revived.
      if (overtaken()) return superseded(null);
      ingress.setEdgeProof(edgeProof);
      ingress.setHosts(hosts);
      state.ingressUrl = await ingress.open();
      if (overtaken()) return superseded(null);

      session = await this.connectSession(state);
      if (overtaken()) return superseded(session);
      state.session = session;

      for (const host of hosts) {
        const listener = await session
          .httpEndpoint()
          .domain(host)
          .listenAndForward(state.ingressUrl);
        state.listeners.set(host, listener);
        if (overtaken()) return superseded(session);
      }
    } catch (err) {
      logger.warn('[Tunnel] Managed access did not open', {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.abandonManaged(
        state,
        session,
        'forward_failed',
        'Managed access could not open.'
      );
    }

    state.phase = 'open';
    state.connected = true;
    this.emitStatus();
    return { ok: true, url: `https://${hosts[0]}`, hosts, generation: state.generation };
  }

  /** Connect managed access's own ngrok session, wired to report drops and recoveries. */
  private async connectSession(state: ManagedState): Promise<NgrokSession> {
    const ngrok = await import('@ngrok/ngrok');
    return new ngrok.SessionBuilder()
      .authtoken(state.value)
      .handleDisconnection(() => {
        if (this.managed === state && state.connected) {
          state.connected = false;
          this.emitStatus();
        }
        return true; // Keep reconnecting; a close is what ends a session.
      })
      .handleHeartbeat(() => {
        if (this.managed === state && !state.connected && state.phase !== 'opening') {
          state.connected = true;
          this.emitStatus();
        }
      })
      .connect();
  }

  /**
   * Serve exactly `hosts` on the open managed session: open listeners for new
   * hostnames, close those for removed ones, leave the rest alone. A hostname
   * ngrok refuses is reported in `failed` and not admitted by the ingress.
   *
   * @param hosts - The complete hostname set; compared without regard to case.
   */
  applyHosts(hosts: string[]): Promise<ManagedHostsResult> {
    return this.enqueue(async () => {
      const state = this.managed;
      const wanted = normalizeHosts(hosts);
      if (!state || state.phase !== 'open' || !state.session || wanted.length === 0) {
        return {
          ok: false,
          hosts: state ? [...state.hosts] : [],
          added: [],
          removed: [],
          failed: wanted,
        };
      }
      return this.reconcileHosts(state, wanted);
    });
  }

  private async reconcileHosts(state: ManagedState, wanted: string[]): Promise<ManagedHostsResult> {
    const wantedSet = new Set(wanted);
    const toAdd = wanted.filter((host) => !state.listeners.has(host));
    const toRemove = [...state.listeners.keys()].filter((host) => !wantedSet.has(host));
    const failed: string[] = [];

    const added = await this.addHosts(state, toAdd, failed);
    const removed = await this.removeHosts(state, toRemove, failed);

    // Only while this session still owns managed access: a close that ran
    // meanwhile already forgot the hosts, and must stay that way.
    if (this.managed === state) this.ingress!.setHosts([...state.hosts]);
    if (added.length || removed.length) this.emitStatus();
    return { ok: failed.length === 0, hosts: [...state.hosts], added, removed, failed };
  }

  /** Open a listener for each new host. Never opens the ingress: it targets the URL this session opened. */
  private async addHosts(
    state: ManagedState,
    toAdd: string[],
    failed: string[]
  ): Promise<string[]> {
    const added: string[] = [];
    const session = state.session;
    const target = state.ingressUrl;
    if (!session || !target || toAdd.length === 0) return added;
    // Admit a new hostname at the ingress before its listener exists, so its
    // first request is not refused.
    for (const host of toAdd) state.hosts.add(host);
    this.ingress!.setHosts([...state.hosts]);

    for (const host of toAdd) {
      if (this.managed !== state) break;
      try {
        const listener = await session.httpEndpoint().domain(host).listenAndForward(target);
        if (this.managed !== state) {
          await listener.close().catch(() => undefined);
          break;
        }
        state.listeners.set(host, listener);
        added.push(host);
      } catch (err) {
        state.hosts.delete(host);
        failed.push(host);
        logger.warn('[Tunnel] Managed address did not open', {
          host,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return added;
  }

  /** Close the listener for each removed host; a host ngrok will not close stays served and is reported. */
  private async removeHosts(
    state: ManagedState,
    toRemove: string[],
    failed: string[]
  ): Promise<string[]> {
    const removed: string[] = [];
    for (const host of toRemove) {
      const session = state.session;
      const listener = state.listeners.get(host);
      if (!session || !listener) break;
      try {
        await session.closeListener(listener.id());
        state.listeners.delete(host);
        state.hosts.delete(host);
        removed.push(host);
      } catch (err) {
        failed.push(host);
        logger.warn('[Tunnel] Managed address did not close', {
          host,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return removed;
  }

  /**
   * Stop admitting new managed requests (they get 503) while those already
   * admitted finish. Does not close anything: {@link closeManaged} does.
   */
  beginDrain(): void {
    const state = this.managed;
    if (!state || state.phase === 'draining') return;
    state.phase = 'draining';
    this.ingress?.beginDrain();
    this.emitStatus();
  }

  /**
   * Close managed access. `immediate: false` drains first — new requests get
   * 503, admitted ones finish — then closes the listeners; `immediate: true`
   * closes everything now and outranks a drain already under way. Never waits
   * behind a pending open: the open notices and closes what it made.
   *
   * The local state is reset even when ngrok fails to close; the error still
   * propagates so the caller can report the actual outcome.
   *
   * @param options - Whether to cut admitted requests rather than let them finish.
   * @param options.immediate - `true` for withdrawal and shutdown.
   */
  async closeManaged({ immediate }: { immediate: boolean }): Promise<void> {
    this.managedEpoch += 1;
    this.managedCloses += 1;
    const state = this.managed;
    const ingress = this.ingress;
    if (!state) {
      await ingress?.close({ immediate });
      return;
    }
    if (state.phase !== 'draining') {
      state.phase = 'draining';
      ingress?.beginDrain();
      this.emitStatus();
    }
    try {
      if (immediate) {
        await Promise.all([this.closeManagedSession(state), ingress?.close({ immediate: true })]);
      } else {
        // The ngrok session carries the admitted requests' responses, so it
        // closes only after the ingress has let them finish.
        await ingress?.close({ immediate: false });
        await this.closeManagedSession(state);
      }
    } finally {
      if (this.managed === state) {
        this.managed = null;
        this.emitStatus();
      }
    }
  }

  /** Close one managed session's ngrok side. Safe to call twice. */
  private async closeManagedSession(state: ManagedState): Promise<void> {
    const session = state.session;
    state.session = null;
    state.listeners.clear();
    if (session) await session.close();
  }
}

export const tunnelManager = new TunnelManager();
