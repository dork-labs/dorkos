import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ComputerFrameSchema,
  ComputerInputSchema,
  type ComputerStatus,
  type ComputerErrorCode,
  type ComputerInput,
  type ComputerFrame,
  type ComputerControlLease,
  type ComputerSession,
} from '@dorkos/shared/computer-schemas';
import type { ComputerBackend, ComputerEndpoints, ComputerIdentity } from './backend/types.js';
import { ComputerStore, type ComputerRecord } from './store.js';

/** Closed public refusal; original errors belong in private diagnostics. */
export class ComputerRefusal extends Error {
  constructor(readonly code: ComputerErrorCode) {
    super(code);
  }
}

/** The callbacks that keep execution inside current platform admission. */
export interface ComputerServiceOptions {
  root: string;
  anchor?: string;
  backend: ComputerBackend;
  enabled(): boolean;
  supported?: boolean;
  createSession(anchor: string): Promise<ComputerSession>;
  interruptTurns(): Promise<void>;
  onFailure?(error: unknown): void;
}

/** One persistent local computer with serialized ownership and generation-bound display control. */
export class ComputerService {
  private readonly store: ComputerStore;
  private record: ComputerRecord | null = null;
  private loaded = false;
  private loadWork?: Promise<void>;
  private lifecycle?: Promise<void>;
  private fenced = false;
  private serial: Promise<unknown> = Promise.resolve();
  private lease?: ComputerControlLease & { owner: string; expiresAt: number };
  private leaseTimer?: ReturnType<typeof setTimeout>;
  private releaseFailures = 0;
  private pendingControl = 0;
  readonly anchor: string;
  readonly supported: boolean;

  constructor(private readonly options: ComputerServiceOptions) {
    this.store = new ComputerStore(options.root);
    this.anchor = options.anchor ?? join(options.root, 'workspace');
    this.supported =
      options.supported ?? (process.platform === 'darwin' && process.arch === 'arm64');
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loadWork ??= (async () => {
      try {
        this.record = await this.store.read();
        if (this.record && ['provisioning', 'starting', 'stopping'].includes(this.record.phase)) {
          this.record.phase = 'uncertain';
          await this.store.write(this.record, 'interrupted-transition');
        }
      } catch (error) {
        this.options.onFailure?.(error);
        throw new ComputerRefusal('cleanup-uncertain');
      }
      this.loaded = true;
    })();
    await this.loadWork;
  }

  private admit(lifecycleEntry = false): void {
    if (!this.options.enabled()) throw new ComputerRefusal('disabled');
    if (this.fenced && !lifecycleEntry) throw new ComputerRefusal('not-ready');
    if (!this.supported) throw new ComputerRefusal('unsupported');
  }

  private identity(): ComputerIdentity {
    if (!this.record) throw new ComputerRefusal('not-ready');
    return { id: this.record.id, instanceName: 'computer' };
  }

  private projection(): ComputerStatus {
    const phase = !this.supported
      ? 'unsupported'
      : !this.options.enabled()
        ? 'disabled'
        : (this.record?.phase ?? 'missing');
    return {
      id: 'local',
      name: 'Agent computer',
      supported: this.supported,
      phase,
      generation: this.record?.generation ?? 0,
      ready: phase === 'ready',
      ...(phase === 'ready' ? { runtimeId: 'computer-local', cwd: this.anchor } : {}),
      ...(this.record?.phase === 'uncertain'
        ? { error: { code: 'cleanup-uncertain' as const } }
        : phase === 'failed'
          ? { error: { code: 'setup-failed' as const } }
          : {}),
    };
  }

  /** Read state without booting a guest; revalidate a retained ready generation. */
  async status(): Promise<ComputerStatus> {
    if (!this.supported) return this.projection();
    await this.load();
    if (this.record?.phase === 'ready') {
      const generation = this.record.generation;
      try {
        const observed = await this.options.backend.status(this.identity());
        if (
          this.record.phase === 'ready' &&
          this.record.generation === generation &&
          (observed.phase !== 'running' || observed.generation !== generation)
        ) {
          this.record.phase =
            observed.phase === 'stopped' && observed.generation === generation
              ? 'stopped'
              : 'uncertain';
          if (this.record.phase === 'stopped') this.clearControl();
          await this.store.write(this.record, 'reconcile');
        }
      } catch (error) {
        this.options.onFailure?.(error);
        if (this.record.phase === 'ready' && this.record.generation === generation) {
          this.record.phase = 'uncertain';
          await this.store.write(this.record, 'reconcile-failed');
        }
      }
    }
    return this.projection();
  }

  /** Begin singleton provisioning and return immediately so the app can poll progress. */
  async create(): Promise<ComputerStatus> {
    return this.begin('create');
  }

  /** Start the existing disk; setup and ownership uncertainty never trigger replacement. */
  async start(): Promise<ComputerStatus> {
    return this.begin('start');
  }

  private async begin(action: 'create' | 'start'): Promise<ComputerStatus> {
    this.admit(true);
    await this.load();
    return this.exclusive(async () => {
      if (this.record?.phase === 'uncertain') throw new ComputerRefusal('cleanup-uncertain');
      if (
        this.fenced &&
        !this.lifecycle &&
        (!this.record || ['stopped', 'missing'].includes(this.record.phase))
      )
        this.fenced = false;
      this.admit();
      if (this.lifecycle || this.record?.phase === 'ready') return this.projection();
      if (!this.record && action === 'start') throw new ComputerRefusal('not-ready');
      this.record ??= { id: randomUUID(), generation: 0, phase: 'missing' };
      const identity = this.identity(),
        generation = ++this.record.generation;
      this.record.phase = action === 'create' ? 'provisioning' : 'starting';
      await this.store.write(this.record, `${action}-intent`);
      await mkdir(this.anchor, { recursive: true, mode: 0o700 });
      this.lifecycle = (async () => {
        try {
          const observed = await this.options.backend[action](identity, generation);
          if (observed.phase !== 'running' || observed.generation !== generation)
            throw new ComputerRefusal('cleanup-uncertain');
          const endpoints = await this.options.backend.endpoints(identity);
          await this.waitForHealth(endpoints, generation);
          if (!this.options.enabled() || this.fenced) return;
          if (this.record?.generation !== generation)
            throw new ComputerRefusal('cleanup-uncertain');
          this.record.phase = 'ready';
          await this.store.write(this.record, `${action}-observed`);
        } catch (error) {
          this.options.onFailure?.(error);
          if (this.record?.generation === generation && !this.fenced) {
            this.record.phase =
              error instanceof ComputerRefusal && error.code === 'cleanup-uncertain'
                ? 'uncertain'
                : 'failed';
            await this.store
              .write(this.record, `${action}-failed`)
              .catch((writeError) => this.options.onFailure?.(writeError));
          }
        } finally {
          this.lifecycle = undefined;
        }
      })();
      return this.projection();
    });
  }

  /** SSH readiness precedes guest services; await actual health without publishing readiness early. */
  private async waitForHealth(endpoints: ComputerEndpoints, generation: number): Promise<void> {
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (!this.options.enabled() || this.fenced || this.record?.generation !== generation)
        throw new ComputerRefusal('not-ready');
      try {
        await this.verifyHealth(endpoints);
        return;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  private async verifyHealth(endpoints: ComputerEndpoints): Promise<void> {
    const checks = await Promise.allSettled([
      fetch(new URL('/health', endpoints.desktopUrl), {
        headers: { Authorization: `Bearer ${endpoints.desktopPassword}` },
        signal: AbortSignal.timeout(5000),
      }),
      fetch(new URL('/global/health', endpoints.opencodeUrl), {
        headers: {
          Authorization: `Basic ${Buffer.from(`opencode:${endpoints.opencodePassword}`).toString('base64')}`,
        },
        signal: AbortSignal.timeout(5000),
      }),
    ]);
    const results = checks.flatMap((check) => (check.status === 'fulfilled' ? [check.value] : []));
    if (results.length !== 2 || results.some((response) => !response.ok)) {
      await Promise.all(results.map((response) => response.body?.cancel().catch(() => undefined)));
      throw new ComputerRefusal('not-ready');
    }
    const health = await Promise.all(
      results.map(
        async (response) => JSON.parse(await boundedText(response, 4096)) as Record<string, unknown>
      )
    );
    if (health[0]?.ready !== true || health[1]?.healthy !== true)
      throw new ComputerRefusal('not-ready');
  }

  /** Synchronous admission used by runtime callbacks; stopped computers cannot execute. */
  acceptingWork(): boolean {
    return (
      this.options.enabled() &&
      this.supported &&
      !this.fenced &&
      !this.lease &&
      this.pendingControl === 0 &&
      this.record?.phase === 'ready'
    );
  }

  /** Private ready endpoint for the isolated runtime; it never selects a host sidecar. */
  async endpoint(): Promise<ComputerEndpoints & { generation: number }> {
    this.admit();
    if (!this.acceptingWork()) throw new ComputerRefusal('not-ready');
    const endpoint = await this.readyEndpoint();
    if (!this.acceptingWork()) throw new ComputerRefusal('not-ready');
    return endpoint;
  }

  /** Owner display operations remain available while work admission is closed. */
  private async readyEndpoint(): Promise<ComputerEndpoints & { generation: number }> {
    this.admit();
    await this.load();
    if (this.record?.phase !== 'ready') throw new ComputerRefusal('not-ready');
    const generation = this.record.generation;
    const endpoints = await this.options.backend.endpoints(this.identity());
    this.admit();
    if (this.record.phase !== 'ready' || this.record.generation !== generation)
      throw new ComputerRefusal('not-ready');
    return { ...endpoints, generation };
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.serial.then(operation, operation);
    this.serial = work.catch(() => undefined);
    return work;
  }

  private async desktop<T>(path: string, body?: unknown, cleanup = false): Promise<T> {
    const endpoint =
      cleanup && this.record?.phase === 'ready'
        ? {
            ...(await this.options.backend.endpoints(this.identity())),
            generation: this.record.generation,
          }
        : await this.readyEndpoint();
    const response = await fetch(new URL(path, endpoint.desktopUrl), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${endpoint.desktopPassword}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new ComputerRefusal('unavailable');
    const text = await boundedText(response, 16 * 1024 * 1024);
    if (!cleanup) this.admit();
    if (this.record?.generation !== endpoint.generation || this.record.phase !== 'ready')
      throw new ComputerRefusal('not-ready');
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Display-only read; keeping the current controller's viewer open renews its lease. */
  async frame(owner: string): Promise<ComputerFrame> {
    const generation = (await this.readyEndpoint()).generation;
    const frame = ComputerFrameSchema.parse({
      ...(await this.desktop<object>('/frame')),
      generation,
    });
    await this.exclusive(async () => {
      if (this.lease?.owner !== owner || this.lease.generation !== generation) return;
      await this.desktop('/control', {
        held: true,
        renew: true,
        leaseId: this.lease.leaseId,
        generation,
      });
      this.armLeaseExpiry();
    });
    return {
      ...frame,
      controlledByYou: this.lease?.owner === owner && this.lease.expiresAt > Date.now(),
    };
  }

  /** Launch the unmodified vendor program inside the visible guest terminal. */
  async signIn(): Promise<ComputerStatus> {
    await this.desktop('/sign-in', {});
    return this.projection();
  }

  /** Create a chat through the platform's own binding and admission. */
  async session(): Promise<ComputerSession> {
    await this.endpoint();
    return this.options.createSession(this.anchor);
  }

  /** Interrupt agent work before handing the actual display to one person. */
  async acquire(owner: string): Promise<ComputerControlLease> {
    // Fence synchronously, including queued acquisitions, before any guest await.
    this.pendingControl++;
    try {
      return await this.exclusive(async () => {
        const { generation } = await this.readyEndpoint();
        await this.options.interruptTurns();
        await this.releaseHeld();
        const lease = { leaseId: randomUUID(), generation, owner, expiresAt: Date.now() + 30_000 };
        // Retain the lease before the request: a lost response may still have frozen work.
        this.lease = lease;
        try {
          await this.desktop('/control', { held: true, leaseId: lease.leaseId, generation });
          this.armLeaseExpiry();
          return { leaseId: lease.leaseId, generation };
        } catch (error) {
          await this.releaseHeld().catch((failure) => this.options.onFailure?.(failure));
          throw error;
        }
      });
    } finally {
      this.pendingControl--;
    }
  }

  private armLeaseExpiry(): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    if (!this.lease) return;
    this.lease.expiresAt = Date.now() + 30_000;
    const leaseId = this.lease.leaseId;
    this.leaseTimer = setTimeout(() => {
      void this.exclusive(async () => {
        if (this.lease?.leaseId === leaseId && this.lease.expiresAt <= Date.now())
          await this.releaseHeld();
      }).catch((error) => this.options.onFailure?.(error));
    }, 30_000);
    this.leaseTimer.unref();
  }

  private clearControl(): void {
    this.lease = undefined;
    this.releaseFailures = 0;
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
  }

  private async releaseHeld(): Promise<void> {
    const lease = this.lease;
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    if (lease && this.record?.phase !== 'ready') return;
    try {
      if (lease && this.record?.phase === 'ready') {
        await this.desktop(
          '/control',
          { held: false, leaseId: lease.leaseId, generation: lease.generation },
          true
        );
      }
      this.lease = undefined;
      this.releaseFailures = 0;
    } catch (error) {
      if (++this.releaseFailures >= 3 && this.record) {
        this.record.phase = 'uncertain';
        await this.store.write(this.record, 'control-release-unconfirmed');
      } else {
        this.leaseTimer = setTimeout(() => {
          void this.exclusive(async () => {
            if (this.lease?.leaseId === lease?.leaseId) await this.releaseHeld();
          }).catch((failure) => this.options.onFailure?.(failure));
        }, 5000);
        this.leaseTimer.unref();
      }
      throw error;
    }
  }

  /** Return only the caller's current lease; a stale release cannot revoke its successor. */
  async release(owner: string, leaseId: string): Promise<void> {
    await this.exclusive(async () => {
      if (this.lease?.owner === owner && this.lease.leaseId === leaseId) await this.releaseHeld();
    });
  }

  /** Admit input at execution time, after all prior control changes have settled. */
  async input(owner: string, value: ComputerInput): Promise<void> {
    const input = ComputerInputSchema.parse(value);
    await this.exclusive(async () => {
      this.admit();
      if (
        !this.lease ||
        this.lease.owner !== owner ||
        this.lease.leaseId !== input.leaseId ||
        this.lease.generation !== input.generation ||
        this.lease.expiresAt <= Date.now()
      )
        throw new ComputerRefusal('control-lost');
      await this.desktop('/input', input);
      this.armLeaseExpiry();
    });
  }

  /** Fence new work, join owned setup, stop precisely that computer, and retain its disk. */
  async stop(): Promise<ComputerStatus> {
    this.fenced = true;
    await this.load();
    return this.exclusive(async () => {
      const retryableSetup =
        Boolean(this.lifecycle) || ['failed', 'missing'].includes(this.record?.phase ?? '');
      if (this.record && this.lifecycle) {
        this.record.phase = 'stopping';
        await this.store.write(this.record, 'stop-requested');
      }
      await this.lifecycle;
      if (!this.record) return this.projection();
      const identity = this.identity();
      await this.options.interruptTurns();
      await this.releaseHeld().catch((error) => this.options.onFailure?.(error));
      const generation = ++this.record.generation;
      this.record.phase = 'stopping';
      await this.store.write(this.record, 'stop-intent');
      try {
        const before = retryableSetup ? await this.options.backend.status(identity) : undefined;
        // Generation zero confirms that both owner and exact instance are absent.
        if (before?.phase === 'missing' && before.generation === 0) {
          this.record.phase = 'missing';
        } else {
          const observed = await this.options.backend.stop(identity, generation);
          this.record.phase =
            observed.phase === 'stopped' && observed.generation === generation
              ? 'stopped'
              : 'uncertain';
        }
      } catch (error) {
        this.options.onFailure?.(error);
        this.record.phase = 'uncertain';
      }
      if (['stopped', 'missing'].includes(this.record.phase)) this.clearControl();
      await this.store.write(this.record, 'stop-observed');
      return this.projection();
    });
  }
}

/** Bound untrusted guest response bytes before allocating their complete body. */
async function boundedText(response: Response, maximum: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new ComputerRefusal('unavailable');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
