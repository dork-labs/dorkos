import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import {
  LIVE_NOTICE_CHANNEL,
  notifyLive,
  parseLiveNotice,
  type LiveNotice,
  type LiveNoticeTarget,
} from './notices.js';

/** How the listener's connection stands. */
export type LiveListenerState = 'idle' | 'connecting' | 'listening' | 'down';

/** How long the startup self-test waits for its own notice to come back. */
export const LIVE_SELF_TEST_MS = 5_000;
/** How the listener's connection names itself in `pg_stat_activity`. */
export const LIVE_LISTENER_APPLICATION_NAME = 'dorkos-community-live';
const CONNECT_TIMEOUT_MS = 5_000;
/** How often the listener proves its connection still answers, and how long it waits. */
export const LIVE_PROBE_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;
/** TCP keepalive starts this long after the connection goes quiet. */
const KEEPALIVE_DELAY_MS = 10_000;
const RECONNECT_FIRST_MS = 250;
const RECONNECT_MAX_MS = 5_000;

/** What a {@link LiveListener} needs. */
export interface LiveListenerOptions {
  /** A direct Postgres address. A transaction-mode pooler accepts `LISTEN` but never delivers. */
  url: string;
  /** Called once per received notice. */
  onNotice: (notice: LiveNotice) => void;
  /**
   * Called after a dropped connection is listening again. Notices sent while it was down are
   * gone, so the caller re-reads everything that depended on them.
   */
  onReconnect: () => void;
  /** Where connection trouble is reported. IDs and error names only. */
  log?: (message: string, detail: string) => void;
  /** How often to probe the connection, and how long a probe may take. Tests shorten both. */
  probe?: { everyMs: number; timeoutMs: number };
}

/** The socket under a `pg` client, which its types do not expose. */
type WithSocket = { connection?: { stream?: { destroy(): void } } };

/**
 * The single `LISTEN` connection for this process. It holds one dedicated connection outside the
 * request pool, reconnects with backoff when that connection drops, and reports its state for
 * readiness and monitoring. It never sends anything but its own self-test.
 */
export class LiveListener {
  private client: Client | null = null;
  private wanted = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryMs = RECONNECT_FIRST_MS;
  private connecting: Promise<void> | null = null;
  private everListened = false;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private readonly probes = new Map<string, () => void>();
  private readonly log: (message: string, detail: string) => void;
  /** Where the connection stands now. */
  state: LiveListenerState = 'idle';
  /** Times a dropped connection was re-established. */
  reconnects = 0;

  constructor(private readonly options: LiveListenerOptions) {
    this.log = options.log ?? ((message, detail) => console.error(message, detail));
  }

  /** Connect and `LISTEN`, or join the attempt already under way. Resolves once listening. */
  open(): Promise<void> {
    this.wanted = true;
    if (this.state === 'listening') return Promise.resolve();
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    this.state = 'connecting';
    const client = new Client({
      connectionString: this.options.url,
      application_name: LIVE_LISTENER_APPLICATION_NAME,
      // A stream waits for this connection before its first read; never let it wait forever.
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      // A connection that silently died (a NAT or proxy dropped it) delivers nothing and raises
      // no error. Keepalive notices that at the TCP level; the probe below at the query level.
      keepAlive: true,
      keepAliveInitialDelayMillis: KEEPALIVE_DELAY_MS,
    });
    client.on('notification', (message) => {
      if (message.channel !== LIVE_NOTICE_CHANNEL) return;
      const notice = parseLiveNotice(message.payload);
      if (!notice) return;
      if (notice.k === 'probe') {
        this.probes.get(notice.p)?.();
        return;
      }
      this.options.onNotice(notice);
    });
    client.on('error', (error: Error & { code?: string }) => {
      this.log('Community live updates connection lost', error.code ?? error.name);
    });
    client.on('end', () => {
      if (this.client !== client) return;
      this.client = null;
      this.stopProbe();
      if (!this.wanted) {
        this.state = 'idle';
        return;
      }
      this.state = 'down';
      this.scheduleRetry();
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${LIVE_NOTICE_CHANNEL}`);
    } catch (error) {
      await client.end().catch(() => undefined);
      if (!this.wanted) {
        this.state = 'idle';
        return;
      }
      this.state = 'down';
      this.scheduleRetry();
      throw error;
    }
    if (!this.wanted) {
      // Closed while connecting: nobody wants this connection any more.
      await client.end().catch(() => undefined);
      this.state = 'idle';
      return;
    }
    this.client = client;
    this.state = 'listening';
    this.retryMs = RECONNECT_FIRST_MS;
    this.startProbe();
    if (this.everListened) {
      this.reconnects += 1;
      this.options.onReconnect();
    }
    this.everListened = true;
  }

  private scheduleRetry(): void {
    if (this.retryTimer || !this.wanted) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, RECONNECT_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.wanted) return;
      void this.open().catch((error: Error & { code?: string }) => {
        this.log('Community live updates could not reconnect', error.code ?? error.name);
      });
    }, wait);
    this.retryTimer.unref();
  }

  /**
   * Prove notices arrive: send one through `sender` (another connection) and wait for it here.
   * A transaction-mode pooler in front of the database passes `LISTEN` but delivers nothing, and
   * this is where that shows.
   */
  async selfTest(sender: LiveNoticeTarget, timeoutMs = LIVE_SELF_TEST_MS): Promise<void> {
    await this.open();
    const token = randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const received = new Promise<void>((resolve, reject) => {
      this.probes.set(token, resolve);
      timer = setTimeout(
        () => reject(new Error('Live updates self-test: the notice never arrived')),
        timeoutMs
      );
    });
    try {
      await notifyLive(sender, { k: 'probe', p: token });
      await received;
    } finally {
      clearTimeout(timer);
      this.probes.delete(token);
    }
  }

  /** Whether this listener has ever been listening: a later connect is then a reconnect. */
  get hasListened(): boolean {
    return this.everListened;
  }

  /**
   * One round trip on the listen connection, outside the request pool, so a busy pool cannot
   * make it look down. False when it is not listening, fails, or takes too long.
   */
  async ping(timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
    const client = this.client;
    if (!client) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        client.query('SELECT 1').then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private startProbe(): void {
    this.stopProbe();
    const { everyMs, timeoutMs } = this.options.probe ?? {
      everyMs: LIVE_PROBE_MS,
      timeoutMs: PROBE_TIMEOUT_MS,
    };
    this.probeTimer = setInterval(() => {
      const client = this.client;
      if (!client) return;
      void this.ping(timeoutMs).then((alive) => {
        if (alive || this.client !== client) return;
        this.log('Community live updates connection stopped answering', 'probe');
        // `end` would wait for a reply that never comes; cutting the socket emits `end` at once,
        // which reconnects and wakes every stream to re-read what it missed.
        (client as unknown as WithSocket).connection?.stream?.destroy();
      });
    }, everyMs);
    this.probeTimer.unref();
  }

  private stopProbe(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
  }

  /** Drop the connection and stop reconnecting. `open` starts it again. */
  async close(): Promise<void> {
    this.wanted = false;
    this.stopProbe();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const client = this.client;
    this.client = null;
    this.state = 'idle';
    if (client) await client.end().catch(() => undefined);
    // A connect still in flight sees `wanted` is false and ends its own connection; wait for it,
    // so nothing of this listener is left connected once this resolves.
    await this.connecting?.catch(() => undefined);
  }
}
