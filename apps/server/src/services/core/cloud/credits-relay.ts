/**
 * The DorkOS credits relay (ADR 261002-221210): a loopback-only endpoint a
 * runtime's backend sends its credits requests to, so the credits token never
 * enters that backend's process at all.
 *
 * ## Why OpenCode needs it
 *
 * OpenCode runs every session through one shared process, and a project's own
 * `opencode.json` can read that process's surroundings without running any
 * code: it substitutes `{env:NAME}` and `{file:PATH}` (on Linux,
 * `{file:/proc/self/environ}` is the process's whole environment) and can send
 * the result to a remote MCP server in a header. Anything secret in that
 * process can therefore leave the machine. So the process holds no credits
 * token: its credits provider points here, with a key drawn fresh for every
 * boot, and this relay adds the real token on the way out.
 *
 * A stolen key is useless off this machine: the relay listens on 127.0.0.1
 * only, on its own port (never the server's, which a tunnel may expose), and
 * forgets the key when that boot ends.
 *
 * ## What it will and will not do
 *
 * - It forwards only to the credits endpoint for the format the key was
 *   issued for, taken from the live token. No request chooses where it goes:
 *   the path must be one of that format's few (`POST /chat/completions`,
 *   `GET /models`), the query is dropped, and only the content headers are
 *   copied. The token is set here and nowhere else.
 * - It refuses (401, OpenAI error envelope, `credits_unavailable`) when the
 *   key is wrong or when credits cannot pay right now (unlinked, switched off,
 *   no live token, the format not served). Nothing is sent upstream then.
 * - It streams the answer straight through, caps a request body's size and a
 *   request's total time, and logs neither bodies, keys nor tokens.
 *
 * Codex does not go through it: a Codex turn is its own short-lived process in
 * a home DorkOS owns, which reads no project config at all (it trusts no
 * folder), so no config file can reach its environment; only code the turn
 * runs could, which is the same for every runtime and every key.
 *
 * @module services/core/cloud/credits-relay
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { RuntimeCreditsProtocol } from '@dorkos/shared/agent-runtime';
import { logger } from '../../../lib/logger.js';
import { resolveCreditsLaunch } from './credits-inference.js';
import { CreditsUnavailableError, type CreditsLaunch } from './credits-protocols.js';

/** The formats the relay carries, and the paths each may use. */
const RELAYED_PATHS: Partial<Record<RuntimeCreditsProtocol, Record<string, 'GET' | 'POST'>>> = {
  'openai-chat-completions': { '/chat/completions': 'POST', '/models': 'GET' },
  'openai-responses': { '/responses': 'POST', '/models': 'GET' },
};

/** The request headers copied upstream. Everything else is dropped. */
const FORWARDED_HEADERS = ['content-type', 'accept'] as const;

/** The answer headers copied back. */
const RETURNED_HEADERS = ['content-type', 'cache-control', 'retry-after'] as const;

/** Limits on one relayed request. */
export interface CreditsRelayLimits {
  /** The largest request body accepted, in bytes. */
  maxBodyBytes: number;
  /** The longest one request may take, start to last byte. */
  maxRequestMs: number;
}

const DEFAULT_LIMITS: CreditsRelayLimits = {
  maxBodyBytes: 16 * 1024 * 1024,
  maxRequestMs: 30 * 60_000,
};

/** Seams for {@link startCreditsRelay}. Production passes none. */
export interface CreditsRelayOptions {
  /** Resolves the live endpoint and token for a format, or refuses. */
  resolveLaunch?: (
    protocol: RuntimeCreditsProtocol,
    runtimeLabel: string
  ) => Promise<CreditsLaunch>;
  /** The `fetch` the relay sends upstream with. */
  fetchImpl?: typeof fetch;
  /** Size and time limits. */
  limits?: Partial<CreditsRelayLimits>;
}

/** A running relay. */
export interface CreditsRelay {
  /**
   * Issue a key for one backend boot. The backend sends it as its bearer; the
   * relay answers for that format only, until the key is revoked.
   *
   * @param protocol - The format the backend speaks.
   * @param runtimeLabel - The runtime's display name, for a refusal sentence.
   * @returns The base URL to point the backend at, and its key.
   */
  issue(protocol: RuntimeCreditsProtocol, runtimeLabel: string): { baseUrl: string; key: string };
  /** Forget a key; requests carrying it are refused from now on. */
  revoke(key: string): void;
  /** End every request in flight (an unlink: no credits turn outlives its link). */
  abortAll(): void;
  /** Stop listening. */
  close(): Promise<void>;
}

/** What one issued key answers for. */
interface Issued {
  protocol: RuntimeCreditsProtocol;
  runtimeLabel: string;
}

/** Keys are held by their hash, so looking one up never compares the secret itself. */
function hashOf(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** The bearer a request presents, or `null`. */
function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

/** Answer in the envelope OpenAI-shaped clients read, so the refusal is said as one. */
function refuse(res: ServerResponse, status: number, message: string, code: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type: code, code } }));
}

/** Read a request body, refusing one over the limit. */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Start the relay on 127.0.0.1, on a port of its own.
 *
 * @param options - Seams; production passes none.
 */
export async function startCreditsRelay(options: CreditsRelayOptions = {}): Promise<CreditsRelay> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const doFetch = options.fetchImpl ?? fetch;
  const resolveLaunch =
    options.resolveLaunch ??
    ((protocol: RuntimeCreditsProtocol, runtimeLabel: string) =>
      resolveCreditsLaunch({ credits: { protocol, scope: 'runtime' } }, runtimeLabel));
  const issued = new Map<string, Issued>();
  const inFlight = new Set<AbortController>();

  let origin = '';
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Only a local program talking to this exact address: a browser page
    // (any Origin) or a request for another host name (DNS rebinding) is
    // turned away before anything else is read.
    if (req.headers.origin !== undefined || req.headers.host !== new URL(origin).host) {
      refuse(res, 403, 'The credits relay answers local programs only.', 'forbidden');
      return;
    }
    const controller = new AbortController();
    // The backend hung up: stop, and stop paying for an answer nobody reads.
    res.once('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    const bearer = bearerOf(req);
    const grant = bearer === null ? undefined : issued.get(hashOf(bearer));
    if (!grant) {
      refuse(res, 401, 'This key does not open DorkOS credits.', 'credits_unavailable');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://relay.invalid');
    const prefix = `/relay/${grant.protocol}`;
    const rest = url.pathname.startsWith(`${prefix}/`) ? url.pathname.slice(prefix.length) : null;
    const method = rest === null ? undefined : RELAYED_PATHS[grant.protocol]?.[rest];
    if (rest === null || method === undefined || method !== req.method) {
      refuse(res, 404, 'Not a DorkOS credits path.', 'not_found');
      return;
    }
    const body = method === 'POST' ? await readBody(req, limits.maxBodyBytes) : Buffer.alloc(0);
    if (body === null) {
      refuse(res, 413, 'That request is too large for DorkOS credits.', 'request_too_large');
      return;
    }

    let launch: CreditsLaunch;
    try {
      launch = await resolveLaunch(grant.protocol, grant.runtimeLabel);
    } catch (err) {
      const message =
        err instanceof CreditsUnavailableError ? err.message : "Couldn't reach DorkOS credits.";
      refuse(res, 401, message, 'credits_unavailable');
      return;
    }

    // Gone while its body was read or its token resolved: send nothing.
    if (controller.signal.aborted || res.destroyed) return;
    inFlight.add(controller);
    const timer = setTimeout(() => controller.abort(), limits.maxRequestMs);
    try {
      const headers: Record<string, string> = { authorization: `Bearer ${launch.token}` };
      for (const name of FORWARDED_HEADERS) {
        const value = req.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      const upstream = await doFetch(`${launch.baseUrl.replace(/\/+$/, '')}${rest}`, {
        method,
        headers,
        ...(method === 'POST' ? { body: new Uint8Array(body) } : {}),
        signal: controller.signal,
      });
      const returned: Record<string, string> = {};
      for (const name of RETURNED_HEADERS) {
        const value = upstream.headers.get(name);
        if (value !== null) returned[name] = value;
      }
      res.writeHead(upstream.status, returned);
      if (upstream.body === null) {
        res.end();
        return;
      }
      await new Promise<void>((resolve) => {
        const stream = Readable.fromWeb(upstream.body as never);
        stream.on('error', () => {
          res.destroy();
          resolve();
        });
        stream.on('end', resolve);
        stream.pipe(res);
      });
    } catch (err) {
      // Never the request, the token or the body: only that it failed.
      logger.warn('[credits-relay] upstream request failed', {
        path: rest,
        aborted: controller.signal.aborted,
        name: err instanceof Error ? err.name : 'unknown',
      });
      refuse(res, 502, "Couldn't reach DorkOS credits.", 'upstream_unreachable');
    } finally {
      clearTimeout(timer);
      inFlight.delete(controller);
    }
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => refuse(res, 500, 'The credits relay failed.', 'relay_error'));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('The credits relay did not receive a TCP address.');
  }
  origin = `http://127.0.0.1:${address.port}`;

  return {
    issue(protocol, runtimeLabel) {
      if (RELAYED_PATHS[protocol] === undefined) {
        throw new Error(`The credits relay does not carry ${protocol}.`);
      }
      const key = `dkr_${randomBytes(32).toString('base64url')}`;
      issued.set(hashOf(key), { protocol, runtimeLabel });
      return { baseUrl: `${origin}/relay/${protocol}`, key };
    },
    revoke(key) {
      issued.delete(hashOf(key));
    },
    abortAll() {
      for (const controller of inFlight) controller.abort();
    },
    close() {
      for (const controller of inFlight) controller.abort();
      issued.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
