/**
 * The managed half of remote access: DorkOS's own ngrok session, one listener
 * per hostname the credential allows, all forwarding into the managed ingress
 * (`managed-ingress.ts`) rather than the main port, so every managed request
 * passes the edge-proof and host checks first.
 *
 * It holds its OWN ngrok session, never the SDK's global one the person's own
 * tunnel uses. It is not a public door: `TunnelManager` owns it, runs every
 * open through the queue it shares with the person's own tunnel, and is the one
 * place that guarantees the two never run together. Reach it only through
 * `tunnelManager.startManaged`, `applyHosts`, `beginDrain` and `closeManaged`.
 *
 * @module services/core/remote/managed-forwarding
 */
import type { Listener as NgrokListener, Session as NgrokSession } from '@ngrok/ngrok';
import { RemoteEdgeProofSchema, type RemoteEdgeProof } from '@dork-labs/cloud-api';
import type { TunnelStatus } from '@dorkos/shared/types';
import { MANAGED_DRAIN_DEADLINE_MS, type ManagedIngress } from './managed-ingress.js';
import { logger } from '../../../lib/logger.js';

/** What `TunnelManager.startManaged` opens managed access with. */
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

/** The outcome of `TunnelManager.startManaged`. */
export type ManagedStartResult =
  | { ok: true; url: string; hosts: string[]; generation: number }
  | { ok: false; reason: ManagedStartRefusal; message: string };

/** The outcome of `TunnelManager.applyHosts`. */
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

/** A gentle close under way: when what is left is cut, and who set that deadline. */
export interface ManagedDrain {
  /** When requests still running are cut (ISO 8601). */
  until: string;
  /** `cloud` when the close named its deadline, `local` when the bounded local default applies. */
  deadline: 'cloud' | 'local';
}

/** A managed session that ended, as `TunnelManager` announces it (`managed_closed`). */
export interface ManagedClosedEvent {
  /** The generation of the session that ended. */
  generation: number;
  /** Why, as the closer named it; `closed` when it named nothing. */
  reason: string;
  /** When it ended (ISO 8601). */
  at: string;
}

/** What closing managed access asks for. See `TunnelManager.closeManaged`. */
export interface ManagedCloseOptions {
  /** `true` for withdrawal, revocation and shutdown: cut everything now. */
  immediate: boolean;
  /** For a gentle close, how long admitted requests may run; omitted, the local default. */
  drainDeadlineMs?: number;
  /**
   * Who set `drainDeadlineMs`, for the report. Defaults to `cloud` when one is
   * given and `local` when not; a local cap (shutdown) passes `local`.
   */
  deadlineFrom?: 'cloud' | 'local';
  /** Why, for the close report Cloud is sent (`idle`, `withdrawn`, ...). */
  reason?: string;
}

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
  /** Set once a gentle close names when the rest is cut. */
  drain: ManagedDrain | null;
  /** Why it is closing, once a close began. */
  closeReason: string | null;
  /** Whether {@link closeReason} came from a close that cut everything at once. */
  closeReasonForced: boolean;
}

/** What managed forwarding needs from the `TunnelManager` that owns it. */
export interface ManagedForwardingOwner {
  /** The exposure guard: whether this computer may be published at all. */
  exposureAllowed(): boolean | Promise<boolean>;
  /** Whether the person's own tunnel is open. */
  ownTunnelOpen(): boolean;
  /** Close the person's own tunnel; rejects when ngrok would not close it. */
  closeOwnTunnel(): Promise<void>;
  /** Tell listeners the combined tunnel status changed. */
  emitStatus(): void;
  /** Tell listeners a managed session ended, and why. */
  managedClosed(event: ManagedClosedEvent): void;
}

/** Lower-case, trimmed, de-duplicated, order kept; the first is the primary address. */
function normalizeHosts(hosts: readonly string[]): string[] {
  return [...new Set(hosts.map((host) => host.trim().toLowerCase()).filter(Boolean))];
}

function managedRefusal(reason: ManagedStartRefusal, message: string): ManagedStartResult {
  return { ok: false, reason, message };
}

/** Managed remote access's session, listeners and ingress. One per `TunnelManager`. */
export class ManagedForwarding {
  private managed: ManagedState | null = null;
  private ingress: ManagedIngress | null = null;
  /** Bumped by every managed open and close, so an overtaken open can tell. */
  private managedEpoch = 0;
  /** Bumped by every {@link close}, so an open requested before it can tell. */
  private managedCloses = 0;

  constructor(private readonly owner: ManagedForwardingOwner) {}

  /** How many closes have run; an open compares it against the count when it was asked for. */
  get closeCount(): number {
    return this.managedCloses;
  }

  /** Whether managed access is open, opening or draining. */
  get isOpen(): boolean {
    return this.managed !== null;
  }

  /** Where the managed session is, or `null` when managed access is not open. */
  get phase(): ManagedPhase | null {
    return this.managed?.phase ?? null;
  }

  /** The generation of the open managed session, or `null`. */
  get generation(): number | null {
    return this.managed?.generation ?? null;
  }

  /** The gentle close under way, or `null` when none named a deadline. */
  get drain(): ManagedDrain | null {
    return this.managed?.drain ?? null;
  }

  /** Every hostname served or being opened right now, lower case. */
  get hosts(): readonly string[] {
    return this.managed ? [...this.managed.hosts] : [];
  }

  /**
   * Attach the managed ingress the session forwards into.
   *
   * @param ingress - The ingress listener.
   */
  attachIngress(ingress: ManagedIngress): void {
    this.ingress = ingress;
  }

  /** The tunnel status while managed access is open, or `null` when it is not. */
  status(): TunnelStatus | null {
    const managed = this.managed;
    if (!managed) return null;
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
    if (!(await this.owner.exposureAllowed())) {
      return managedRefusal(
        'exposure_not_allowed',
        'Turn on login and create an owner account before opening remote access.'
      );
    }
    return null;
  }

  /**
   * Open managed access, or bring an open one up to date. Called only from
   * `TunnelManager`'s queue; see `TunnelManager.startManaged` for the contract.
   *
   * @param input - The credential, its hostnames and edge proof, and the generation.
   * @param closesAtRequest - {@link closeCount} when the open was asked for.
   */
  async open(input: ManagedStartInput, closesAtRequest: number): Promise<ManagedStartResult> {
    // Every close other than this open's own must win, including one that
    // lands while an earlier session is being replaced or finished below.
    let closesExpected = closesAtRequest;
    const closedSince = () => this.managedCloses !== closesExpected;
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
      return this.refresh(current, input, hosts);
    }

    // Never both: the person's own tunnel closes before any managed listener opens.
    if (this.owner.ownTunnelOpen()) {
      try {
        await this.owner.closeOwnTunnel();
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
      current.connected = false;
      this.owner.emitStatus();
      try {
        await this.closeSession(current);
      } catch (err) {
        logger.warn('[Tunnel] The previous managed session did not close', {
          error: err instanceof Error ? err.message : String(err),
        });
        return this.abandon(
          current,
          null,
          'forward_failed',
          'The previous remote access did not close, so the new one stayed closed.'
        );
      }
      if (closedSince()) return supersededRefusal();
    } else if (current) {
      // Draining: a close is already owed, so finish it now and start clean
      // (a draining ingress must not carry over into a new open). That close
      // is this open's own; any other one that lands meanwhile still wins.
      closesExpected = this.managedCloses + 1;
      await this.close({ immediate: true, reason: 'reopened' }).catch(() => undefined);
      if (closedSince()) return supersededRefusal();
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
      drain: null,
      closeReason: null,
      closeReasonForced: false,
    };
    this.managed = state;
    this.owner.emitStatus();
    return this.connect(state, ++this.managedEpoch, edgeProof, ingress);
  }

  /** The same credential again: new generation and proof, hosts diffed, nothing reopened. */
  private async refresh(
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
  private async abandon(
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
      if (wasOwner) this.owner.emitStatus();
    }
    return managedRefusal(reason, message);
  }

  /** Open the ingress, the ngrok session and one listener per host, checking for a close after each step. */
  private async connect(
    state: ManagedState,
    epoch: number,
    edgeProof: RemoteEdgeProof,
    ingress: ManagedIngress
  ): Promise<ManagedStartResult> {
    const overtaken = () => epoch !== this.managedEpoch || this.managed !== state;
    const superseded = (session: NgrokSession | null) =>
      this.abandon(state, session, 'superseded', 'Managed access was closed while opening.');
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
      return this.abandon(state, session, 'forward_failed', 'Managed access could not open.');
    }

    state.phase = 'open';
    state.connected = true;
    this.owner.emitStatus();
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
          this.owner.emitStatus();
        }
        return true; // Keep reconnecting; a close is what ends a session.
      })
      .handleHeartbeat(() => {
        if (this.managed === state && !state.connected && state.phase !== 'opening') {
          state.connected = true;
          this.owner.emitStatus();
        }
      })
      .connect();
  }

  /**
   * Serve exactly `hosts` on the open managed session. Called only from
   * `TunnelManager`'s queue; see `TunnelManager.applyHosts` for the contract.
   *
   * @param hosts - The complete hostname set; compared without regard to case.
   */
  async applyHosts(hosts: string[]): Promise<ManagedHostsResult> {
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
  }

  private async reconcileHosts(state: ManagedState, wanted: string[]): Promise<ManagedHostsResult> {
    const wantedSet = new Set(wanted);
    let toAdd = wanted.filter((host) => !state.listeners.has(host));
    const toRemove = [...state.listeners.keys()].filter((host) => !wantedSet.has(host));
    const failed: string[] = [];

    // Publishing another address widens exposure, so it asks the exposure guard
    // first; closing one only narrows it, and never waits on that answer.
    if (toAdd.length > 0 && !(await this.owner.exposureAllowed())) {
      logger.warn('[Tunnel] Managed addresses not opened: exposure is not allowed', {
        count: toAdd.length,
      });
      failed.push(...toAdd);
      toAdd = [];
    }

    const added = await this.addHosts(state, toAdd, failed);
    const removed = await this.removeHosts(state, toRemove, failed);

    // Only while this session still owns managed access: a close that ran
    // meanwhile already forgot the hosts, and must stay that way.
    if (this.managed === state) this.ingress!.setHosts([...state.hosts]);
    if (added.length || removed.length) this.owner.emitStatus();
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

  /** Stop admitting new managed requests while those already admitted finish. */
  beginDrain(): void {
    const state = this.managed;
    if (!state || state.phase === 'draining') return;
    state.phase = 'draining';
    this.ingress?.beginDrain();
    this.owner.emitStatus();
  }

  /**
   * Close managed access; see `TunnelManager.closeManaged` for the contract.
   * The local state is reset even when ngrok fails to close.
   *
   * @param options - Whether to cut admitted requests, the deadline and the reason.
   */
  async close({
    immediate,
    drainDeadlineMs,
    deadlineFrom,
    reason,
  }: ManagedCloseOptions): Promise<void> {
    this.managedEpoch += 1;
    this.managedCloses += 1;
    const state = this.managed;
    const ingress = this.ingress;
    if (!state) {
      await ingress?.close({ immediate, drainDeadlineMs });
      return;
    }
    // The close that actually ended it names the reason: a forced close
    // (withdrawal, revocation) overrides a gentle one already under way (idle,
    // shutdown); otherwise the first closer's reason stands.
    if (state.closeReason === null || (immediate && !state.closeReasonForced)) {
      state.closeReason = reason ?? 'closed';
      state.closeReasonForced = immediate;
    }
    if (!immediate && state.drain === null) {
      const ms = Math.max(0, drainDeadlineMs ?? MANAGED_DRAIN_DEADLINE_MS);
      state.drain = {
        until: new Date(Date.now() + ms).toISOString(),
        deadline: deadlineFrom ?? (drainDeadlineMs === undefined ? 'local' : 'cloud'),
      };
    }
    if (state.phase !== 'draining' || !immediate) {
      state.phase = 'draining';
      ingress?.beginDrain();
      this.owner.emitStatus();
    }
    try {
      if (immediate) {
        await Promise.all([this.closeSession(state), ingress?.close({ immediate: true })]);
      } else {
        // The ngrok session carries the admitted requests' responses, so it
        // closes only after the ingress has let them finish.
        await ingress?.close({ immediate: false, drainDeadlineMs });
        await this.closeSession(state);
      }
    } finally {
      if (this.managed === state) {
        this.managed = null;
        this.owner.emitStatus();
        this.owner.managedClosed({
          generation: state.generation,
          reason: state.closeReason ?? 'closed',
          at: new Date().toISOString(),
        });
      }
    }
  }

  /** Close one managed session's ngrok side. Safe to call twice. */
  private async closeSession(state: ManagedState): Promise<void> {
    const session = state.session;
    state.session = null;
    state.listeners.clear();
    if (session) await session.close();
  }
}
