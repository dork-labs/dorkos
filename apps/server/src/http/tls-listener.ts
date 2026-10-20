/**
 * DorkOS's own `https` listener, off unless asked for (DOR-3172).
 *
 * A signed-in person on an encrypted connection gets exactly what they get at
 * this computer, and "encrypted" is decided only by the listener a request
 * arrived on, never by a header (`isOnEncryptedConnection` in
 * `services/core/auth/gate-policy.ts`). This is the one listener of DorkOS's
 * own whose sockets are TLS: a request on it has `connectionEncrypted` set,
 * and is classified like any other direct request (this computer from a
 * loopback peer, another device otherwise).
 *
 * Turned on by three settings together, all read at boot:
 *
 * - `DORKOS_TLS_PORT`: the port to listen on.
 * - `DORKOS_TLS_CERT` and `DORKOS_TLS_KEY`: paths to a PEM certificate and its
 *   key. A self-signed pair works for a test home.
 * - `DORKOS_TLS_HOST` (optional): the address to bind, `127.0.0.1` unless set.
 *
 * Only some of them set is a mistake, logged and ignored rather than half
 * honoured. The host must also be one the host guard and the sign-in origin
 * check accept (`DORKOS_TRUSTED_HOSTS`, `DORKOS_CORS_ORIGIN`), as for any
 * other address DorkOS is reached at.
 *
 * @module http/tls-listener
 */
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';

/** The `https` listener's settings, when all of them are set. */
export interface TlsListenerSettings {
  /** The port to listen on. */
  readonly port: number;
  /** The address to bind. */
  readonly host: string;
  /** Path to the PEM certificate. */
  readonly certPath: string;
  /** Path to the PEM key. */
  readonly keyPath: string;
}

/** The environment the settings come from. */
export interface TlsListenerEnv {
  readonly DORKOS_TLS_PORT?: number;
  readonly DORKOS_TLS_CERT?: string;
  readonly DORKOS_TLS_KEY?: string;
  readonly DORKOS_TLS_HOST?: string;
}

/**
 * Read the listener's settings: all of them, `null` when none is set.
 *
 * @param env - The parsed environment.
 * @returns The settings, `null` when the listener is off.
 * @throws Error naming what is missing when only some are set.
 */
export function readTlsListenerSettings(env: TlsListenerEnv): TlsListenerSettings | null {
  const { DORKOS_TLS_PORT: port, DORKOS_TLS_CERT: certPath, DORKOS_TLS_KEY: keyPath } = env;
  if (port === undefined && !certPath && !keyPath) return null;
  if (port === undefined || !certPath || !keyPath) {
    throw new Error(
      'The https listener needs DORKOS_TLS_PORT, DORKOS_TLS_CERT and DORKOS_TLS_KEY together.'
    );
  }
  return { port, certPath, keyPath, host: env.DORKOS_TLS_HOST?.trim() || '127.0.0.1' };
}

/**
 * Open the `https` listener when its settings say so.
 *
 * @param env - The parsed environment.
 * @param create - Builds the front-door server for a certificate and key.
 * @param onListening - Called with the listening server, to attach upgrades.
 * @param log - Where a refusal or the address goes.
 * @returns The server, or `null` when the listener is off or could not open.
 */
export function startTlsListener(
  env: TlsListenerEnv,
  create: (tls: { cert: Buffer; key: Buffer }) => Server,
  onListening: (server: Server) => void,
  log: { info: (message: string) => void; warn: (message: string, meta?: object) => void }
): Server | null {
  let settings: TlsListenerSettings | null;
  let tls: { cert: Buffer; key: Buffer };
  try {
    settings = readTlsListenerSettings(env);
    if (!settings) return null;
    tls = { cert: readFileSync(settings.certPath), key: readFileSync(settings.keyPath) };
  } catch (error) {
    log.warn('[DorkOS] The https listener did not open', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  const { port, host } = settings;
  const server = create(tls);
  server.on('error', (error) => {
    log.warn('[DorkOS] The https listener stopped', { error: error.message });
  });
  server.listen(port, host, () => {
    log.info(`[DorkOS] https listener on https://${host}:${port}`);
    onListening(server);
  });
  return server;
}
