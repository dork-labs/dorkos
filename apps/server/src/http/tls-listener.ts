/**
 * DorkOS's own `https` listener, for test homes only (DOR-3172).
 *
 * A signed-in person on an encrypted connection gets exactly what they get at
 * this computer, and "encrypted" is decided only by the listener a request
 * arrived on, never by a header (`isOnEncryptedConnection` in
 * `services/core/auth/gate-policy.ts`). This is the one listener of DorkOS's
 * own whose sockets are TLS, so QA can drive that row live without a tunnel.
 *
 * **Never in production, for now (Security, 0.124.2).** With a self-signed
 * certificate, someone on the same network can get a person to click through
 * the browser's warning and take the sign-in, and with it desk power. Until
 * the certificate story is settled (DOR-3173), the listener opens only when
 * all of these hold, and otherwise logs why and opens nothing:
 *
 * - the server runs the test runtime (`DORKOS_TEST_RUNTIME`);
 * - the data folder is a test home: it holds {@link TEST_HOME_SENTINEL};
 * - `DORKOS_TLS_PORT`, `DORKOS_TLS_CERT` and `DORKOS_TLS_KEY` are all set (a
 *   PEM certificate and key; self-signed is fine). `DORKOS_TLS_HOST` is
 *   optional, `127.0.0.1` unless set.
 *
 * The TLS-socket rule in `isOnEncryptedConnection` checks the test runtime
 * too, so a TLS socket from anywhere else never counts. The host must also be
 * one the host guard and the sign-in origin check accept
 * (`DORKOS_TRUSTED_HOSTS`, `DORKOS_CORS_ORIGIN`).
 *
 * @module http/tls-listener
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';

/** The file whose presence in the data folder marks it a throwaway test home. */
export const TEST_HOME_SENTINEL = '.dorkos-test-home';

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
  readonly DORKOS_TEST_RUNTIME?: boolean;
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
 * Open the `https` listener when its settings say so, on a test home only.
 *
 * @param env - The parsed environment.
 * @param dorkHome - The data folder, checked for {@link TEST_HOME_SENTINEL}.
 * @param create - Builds the front-door server for a certificate and key.
 * @param onListening - Called with the listening server, to attach upgrades.
 * @param log - Where a refusal or the address goes.
 * @returns The server, or `null` when the listener is off or could not open.
 */
export function startTlsListener(
  env: TlsListenerEnv,
  dorkHome: string,
  create: (tls: { cert: Buffer; key: Buffer }) => Server,
  onListening: (server: Server) => void,
  log: { info: (message: string) => void; warn: (message: string, meta?: object) => void }
): Server | null {
  let settings: TlsListenerSettings | null;
  let tls: { cert: Buffer; key: Buffer };
  try {
    settings = readTlsListenerSettings(env);
    if (!settings) return null;
    if (env.DORKOS_TEST_RUNTIME !== true || !existsSync(path.join(dorkHome, TEST_HOME_SENTINEL))) {
      throw new Error(
        `The https listener opens only under DORKOS_TEST_RUNTIME on a test home (${TEST_HOME_SENTINEL}).`
      );
    }
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
