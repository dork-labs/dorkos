import { createSecureServer, type ServerHttp2Session, type Http2Session } from 'node:http2';
import { X509Certificate } from 'node:crypto';
import type { Socket } from 'node:net';

/** Accept only the exact two original DNS hosts at the original listener port. */
export function originalSharedSANAuthority(
  value: string,
  allowedHostname: string,
  deniedHostname: string,
  port: number
): 'allowed' | 'denied' | null {
  if (value === `${allowedHostname}:${port}` || (port === 443 && value === allowedHostname))
    return 'allowed';
  if (value === `${deniedHostname}:${port}` || (port === 443 && value === deniedHostname))
    return 'denied';
  return null;
}

/** Controlled upstream, not a policy substitute or a browser authority. */
export async function createSharedSANH2Origin(options: {
  key: Buffer;
  certificate: Buffer;
  allowedHostname: string;
  deniedHostname: string;
  listenAddress: string;
  listenPort?: number;
  browserCampaign?: { onContinued(): void };
}) {
  const { allowedHostname, deniedHostname } = options;
  const listenPort = options.listenPort ?? 0;
  const onContinued = options.browserCampaign?.onContinued.bind(options.browserCampaign);
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535)
    throw Error('H2_LISTENER_PORT_REFUSED');
  if (
    allowedHostname === deniedHostname ||
    ![allowedHostname, deniedHostname].every((host) => /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host))
  )
    throw Error('H2_HOSTNAME_REFUSED');
  const certificate = new X509Certificate(options.certificate);
  if (
    !certificate.checkHost(allowedHostname, { subject: 'never' }) ||
    !certificate.checkHost(deniedHostname, { subject: 'never' })
  )
    throw Error('H2_SHARED_SAN_REQUIRED');
  const sessions = new Set<ServerHttp2Session>();
  const sockets = new Set<Socket>();
  const sessionIds = new WeakMap<Http2Session, number>();
  let first: { value: unknown } | undefined;
  let connections = 0;
  let nextSession = 0;
  let closed = false;
  const rows: Array<{ session: number; authority: string; path: string }> = [];
  const fail = (value: unknown) => {
    first ??= { value };
  };
  const server = createSecureServer({
    key: options.key,
    cert: options.certificate,
    allowHTTP1: false,
  });
  server.on('error', fail);
  server.on('connection', (socket) => {
    sockets.add(socket);
    connections++;
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', fail);
    if (closed || sockets.size > 16) {
      fail(Error('H2_SOCKET_CAPACITY'));
      socket.destroy();
    }
  });
  server.on('session', (session) => {
    sessions.add(session);
    sessionIds.set(session, ++nextSession);
    session.once('close', () => sessions.delete(session));
    session.on('error', fail);
    if (closed || sessions.size > 16) {
      fail(Error('H2_SESSION_CAPACITY'));
      session.destroy();
    }
  });
  server.on('stream', (stream, headers) => {
    stream.on('error', fail);
    const session = stream.session;
    const id = session && sessionIds.get(session);
    const authority = headers[':authority'];
    const path = headers[':path'];
    if (!id || typeof authority !== 'string' || typeof path !== 'string' || rows.length >= 256) {
      fail(Error('H2_REQUEST_UNVERIFIED'));
      stream.close();
      return;
    }
    rows.push({ session: id, authority, path });
    // Record forbidden requests before responding: a 403 from upstream is already a policy failure.
    const address = server.address();
    if (!address || typeof address === 'string') {
      fail(Error('H2_LISTENER_UNKNOWN'));
      stream.close();
      return;
    }
    const subject = originalSharedSANAuthority(
      authority,
      allowedHostname,
      deniedHostname,
      address.port
    );
    if (subject === null) fail(Error('H2_UNRELATED_UPSTREAM_AUTHORITY'));
    const allowed = subject === 'allowed';
    if (allowed && path === '/continue' && onContinued) {
      stream.once('finish', () => {
        try {
          onContinued();
        } catch (value) {
          fail(value);
        }
      });
    }
    const warm = allowed && path === '/warm' && onContinued !== undefined;
    stream.respond({
      ':status': allowed ? 200 : 403,
      'content-type': warm ? 'text/html; charset=utf-8' : 'text/plain',
      'cache-control': 'no-store',
    });
    const body = warm
      ? '<!doctype html><title>Original shared-SAN browser probe</title><script>' +
        '(async()=>{try{await fetch(' +
        JSON.stringify(`https://${deniedHostname}/forbidden`) +
        ',{mode:"no-cors",cache:"no-store"})}catch{}finally{await fetch(' +
        JSON.stringify(`https://${allowedHostname}/continue`) +
        ',{cache:"no-store"})}})();</script>'
      : allowed
        ? 'ORIGINAL_ALLOWED'
        : 'FORBIDDEN_UPSTREAM_REACHED';
    stream.end(body);
  });
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    closed = true;
    closing = Promise.resolve().then(async () => {
      const joins = [
        ...[...sessions].map(
          (session) => new Promise<void>((resolve) => session.once('close', resolve))
        ),
        ...[...sockets].map(
          (socket) => new Promise<void>((resolve) => socket.once('close', resolve))
        ),
      ];
      for (const session of sessions) {
        try {
          session.destroy();
        } catch (error) {
          fail(error);
        }
      }
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch (error) {
          fail(error);
        }
      }
      const listener = new Promise<void>((resolve) => {
        try {
          server.close((error) => {
            if (error) fail(error);
            resolve();
          });
        } catch (error) {
          fail(error);
          resolve();
        }
      });
      for (const result of await Promise.allSettled([...joins, listener]))
        if (result.status === 'rejected') fail(result.reason);
      if (first) throw first.value;
    });
    void closing.catch(() => {});
    return closing;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(listenPort, options.listenAddress, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('H2_LISTENER_UNKNOWN');
    return Object.freeze({
      port: address.port,
      snapshot() {
        if (first) throw first.value;
        return { connections, rows: rows.map((row) => ({ ...row })) };
      },
      observation() {
        return {
          connections,
          rows: rows.map((row) => ({ ...row })),
          failed: first !== undefined,
          closed,
        };
      },
      close,
    });
  } catch (error) {
    fail(error);
    await close();
    throw error;
  }
}

/** All inputs must be consumed original observations; missing CONNECT evidence refuses qualification. */
export function assertSharedSANH2Evidence(input: {
  allowedAuthority: string;
  deniedAuthority: string;
  allowedSession: number;
  rows: ReadonlyArray<{ session: number; authority: string; path: string }>;
  originalConnectDenials: ReadonlyArray<{ authority: string; outcome: 'denied'; beforeDial: true }>;
}) {
  if (
    input.allowedAuthority === input.deniedAuthority ||
    !Number.isSafeInteger(input.allowedSession) ||
    input.allowedSession <= 0
  )
    throw Error('H2_SCOPE_UNVERIFIED');
  if (
    input.rows.some(
      (row) => ![input.allowedAuthority, input.deniedAuthority].includes(row.authority)
    )
  )
    throw Error('H2_UNRELATED_UPSTREAM_AUTHORITY');
  if (input.rows.some((row) => row.authority === input.deniedAuthority))
    throw Error('H2_FORBIDDEN_UPSTREAM_REQUEST');
  const allowed = input.rows.filter(
    (row) => row.authority === input.allowedAuthority && row.session === input.allowedSession
  );
  if (
    !allowed.some((row) => row.path === '/warm') ||
    !allowed.some((row) => row.path === '/continue')
  )
    throw Error('H2_ORIGINAL_WARMED_SESSION_NOT_CONTINUED');
  if (
    !input.originalConnectDenials.some(
      (row) =>
        row.authority === input.deniedAuthority &&
        row.outcome === 'denied' &&
        row.beforeDial === true
    )
  )
    throw Error('H2_SEPARATE_ORIGINAL_CONNECT_DENIAL_REQUIRED');
}
