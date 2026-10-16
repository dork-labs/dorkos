/**
 * Wi-Fi access (DOR-2930): one switch that lets other devices on the same
 * network open DorkOS, with no restart.
 *
 * ## The shape
 *
 * The main listener always stays on loopback (`DORKOS_HOST`, `localhost` by
 * default). This controller adds a SECOND listener on every network interface,
 * on the same port, and closes it again, as the `server.lanAccess` setting and
 * the login posture change. Both listeners hand requests to the same front door
 * and the same upgrade router, so a request from a phone meets every route and
 * gate a local one does, and a phone is never a loopback peer.
 *
 * ## When it opens
 *
 * All three must hold, and the controller rechecks them on every settings write:
 *
 * 1. The person turned the switch on (`server.lanAccess`).
 * 2. An owner account exists for Wi-Fi devices to sign in as (`canExpose`),
 *    the same bar the tunnel meets. With no owner the switch turns off, in
 *    config too, so it cannot spring open again later.
 * 3. Neither `DORKOS_HOST` nor `DORKOS_ALLOW_INSECURE_BIND` is set in the
 *    environment. Either already decides where DorkOS listens and who counts as
 *    local, so Settings names it instead of offering the switch.
 *
 * And it opens only on a Mac for now: see {@link SUPPORTED_PLATFORMS}. Every
 * connection it takes must come from one of this computer's own networks.
 *
 * ## When it closes
 *
 * At once: the listener stops taking connections, idle connections drop, and
 * the rest, upgraded sockets included, are cut after a short grace so the
 * answer to the request that turned it off still reaches the device that sent it.
 *
 * @module services/core/lan-access/lan-access
 */
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import type { LanAccessStatus } from '@dorkos/shared/types';
import { logger, logError } from '../../../lib/logger.js';
import { setLanTrust } from './lan-trust.js';

/**
 * Interfaces the second listener tries, in order. `::` takes IPv4 and IPv6 at
 * once, so a phone that looks up the `.local` name and tries IPv6 first still
 * connects; `0.0.0.0` is the IPv4-only fallback for a system without IPv6.
 */
const ALL_INTERFACES = ['::', '0.0.0.0'] as const;

/**
 * Where a second listener can share the main listener's port. On macOS a
 * wildcard bind beside a loopback one on the same port works; Linux refuses it
 * with `EADDRINUSE` (measured in review), and Windows is unverified. Elsewhere
 * the switch says so instead of blaming "another program".
 */
const SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = ['darwin'];

/** What Settings shows on a computer the switch does not work on yet. */
export const LAN_ACCESS_UNSUPPORTED_MESSAGE =
  'Wi-Fi access works on a Mac for now. Elsewhere, set DORKOS_HOST.';

/** How long open connections may finish before a close cuts them, in milliseconds. */
const CLOSE_GRACE_MS = 1_000;

/** What the controller needs from the rest of the server, injected so tests own it. */
export interface LanAccessDeps {
  /** The `server.lanAccess` setting. */
  readSetting: () => boolean;
  /** Write `server.lanAccess`. */
  writeSetting: (enabled: boolean) => void;
  /** An owner account exists for other devices to sign in as (`canExpose`). */
  canExpose: () => boolean;
  /**
   * The environment setting that decides where DorkOS listens instead, e.g.
   * `DORKOS_HOST=0.0.0.0`, else `null` (`lanAccessEnvironmentLock`).
   */
  setByEnvironment: () => string | null;
  /** This computer's Bonjour name (`readLocalName`). */
  readLocalName: () => Promise<string | null>;
  /** This computer's current IPv4 addresses (`readLanAddresses`). */
  readAddresses: () => string[];
  /** Subscribe to settings writes; returns an unsubscribe. */
  onSettingsChange: (listener: (sections: readonly string[]) => void) => () => void;
  /** Whether sign-in cookies are `Secure` in this build (`AUTH_COOKIES_SECURE`). */
  secureCookies: boolean;
  /** Interface to bind; tests pass loopback. Defaults to every interface. */
  bindHost?: string;
  /**
   * Whether a connecting peer is on this computer's own networks
   * (`isLocalNetworkPeer`). Anyone else is cut at the socket.
   */
  isLocalPeer: (address: string | undefined) => boolean;
  /** The operating system; defaults to this one. See {@link SUPPORTED_PLATFORMS}. */
  platform?: NodeJS.Platform;
}

/** What {@link LanAccess.attach} needs once the main listener is up. */
export interface LanListenerSource {
  /** The port the main listener holds; the second one uses the same. */
  port: number;
  /** Build an unbound server wired to the front door. */
  createServer: () => Server;
  /** Attach the shared upgrade router to a server once it is listening. */
  attachUpgrades?: (server: Server) => void;
}

/** Turn a listen failure into one sentence a person can act on. */
function describeListenError(error: unknown, port: number): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'EADDRINUSE') {
    return `Another program is using port ${port} on this network. Quit it, then try again.`;
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return `This computer will not let DorkOS open port ${port} to the network.`;
  }
  return 'DorkOS could not open to your network.';
}

/** Listen on one interface, resolving once bound and rejecting on a bind error. */
function listenOn(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/** The Wi-Fi access controller. One per server; see the module doc. */
export class LanAccess {
  private source: LanListenerSource | null = null;
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private localName: string | null = null;
  private error: string | null = null;
  /** Settles when the last reconcile has; reconciles run one at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: LanAccessDeps) {}

  /**
   * Start following the setting, once the main listener is up. Opens the
   * network listener straight away when the setting is on and allowed.
   *
   * @param source - The port and a factory for the second server.
   */
  attach(source: LanListenerSource): Promise<LanAccessStatus> {
    this.source = source;
    this.unsubscribe ??= this.deps.onSettingsChange((sections) => {
      if (sections.includes('server') || sections.includes('auth')) void this.reconcile();
    });
    return this.reconcile();
  }

  /**
   * Bring the listener in line with the setting and the login posture, then
   * answer the status. Safe to call any number of times; calls run in order.
   */
  reconcile(): Promise<LanAccessStatus> {
    // Never rejects: a failure is logged and the status answered as it stands,
    // so a settings listener or the boot call cannot leave a rejection unhandled.
    const run = this.queue
      .then(() => this.reconcileNow())
      .catch((error: unknown) => {
        logger.warn('[LanAccess] Could not apply the Wi-Fi access setting', logError(error));
        return this.status();
      });
    this.queue = run;
    return run;
  }

  /** Whether the switch works on this computer at all (see {@link SUPPORTED_PLATFORMS}). */
  get supported(): boolean {
    return SUPPORTED_PLATFORMS.includes(this.deps.platform ?? process.platform);
  }

  /** Where Wi-Fi access stands right now. */
  status(): LanAccessStatus {
    const listening = this.server !== null;
    return {
      enabled: this.deps.readSetting(),
      listening,
      supported: this.supported,
      setByEnvironment: this.deps.setByEnvironment(),
      port: this.source?.port ?? 0,
      localName: this.localName,
      addresses: this.deps.readAddresses(),
      // Where the switch cannot work, say so even before anyone flips it.
      error: listening
        ? null
        : (this.error ?? (this.supported ? null : LAN_ACCESS_UNSUPPORTED_MESSAGE)),
    };
  }

  /** Close the listener and stop following the setting, for shutdown. */
  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.source = null;
    await this.reconcile();
  }

  private async reconcileNow(): Promise<LanAccessStatus> {
    let wanted = this.deps.readSetting();
    if (wanted && !this.deps.canExpose()) {
      // Login is off (or no owner exists). The switch cannot stay on without it,
      // so it goes off for good rather than waiting to reopen.
      logger.info('[LanAccess] Login is off, so Wi-Fi access is turned off too');
      this.deps.writeSetting(false);
      wanted = false;
    }
    const shouldListen = wanted && this.deps.setByEnvironment() === null && this.source !== null;
    if (shouldListen && !this.server) await this.open(this.source!);
    if (!shouldListen && this.server) this.shut();
    if (!wanted) this.error = null;
    return this.status();
  }

  private async open(source: LanListenerSource): Promise<void> {
    if (!this.supported) {
      this.error = LAN_ACCESS_UNSUPPORTED_MESSAGE;
      return;
    }
    this.localName ??= await this.deps.readLocalName().catch(() => null);
    const hosts = this.deps.bindHost ? [this.deps.bindHost] : ALL_INTERFACES;
    let server: Server | null = null;
    let failure: unknown = null;
    for (const host of hosts) {
      const candidate = source.createServer();
      // Checked and tracked from the first connection: a peer off this computer's
      // own networks is cut before it is answered, and a close can cut the rest.
      candidate.on('connection', (socket: Socket) => {
        if (!this.deps.isLocalPeer(socket.remoteAddress)) {
          socket.destroy();
          return;
        }
        this.sockets.add(socket);
        socket.once('close', () => this.sockets.delete(socket));
      });
      try {
        await listenOn(candidate, source.port, host);
        server = candidate;
        break;
      } catch (error) {
        failure ??= error;
        // A busy port is busy on every interface; trying the next one only hides why.
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') break;
      }
    }
    if (!server) {
      this.error = describeListenError(failure, source.port);
      logger.warn('[LanAccess] Could not open to the network', logError(failure));
      return;
    }
    server.on('error', (error) => logger.warn('[LanAccess] Listener error', logError(error)));
    source.attachUpgrades?.(server);
    this.server = server;
    this.error = null;
    setLanTrust({
      port: source.port,
      names: this.localName ? [this.localName] : [],
      secureCookies: this.deps.secureCookies,
    });
    logger.info(
      `[LanAccess] Open to the network on port ${source.port}` +
        (this.localName ? ` (http://${this.localName}:${source.port})` : '')
    );
  }

  /**
   * Close the listener. Does not wait for open connections to finish: when the
   * request that turned the switch off came over this very listener, waiting
   * would hold its own answer until the grace cut it.
   */
  private shut(): void {
    const server = this.server!;
    this.server = null;
    // Untrust first, so nothing that still arrives is answered as a known host.
    setLanTrust(null);
    const sockets = [...this.sockets];
    this.sockets.clear();
    const cut = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
    }, CLOSE_GRACE_MS);
    cut.unref();
    // `server.close` stops new connections now and calls back once every
    // connection, upgraded sockets included, has ended; the cut bounds that.
    server.close(() => clearTimeout(cut));
    server.closeIdleConnections();
    logger.info('[LanAccess] Closed to the network');
  }
}
