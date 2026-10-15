/**
 * The child half of an isolated extension's HTTP (DOR-2686, spec §7): an
 * `http.Server` that never listens, serving the extension's fetch handler
 * with `@hono/node-server`'s request listener.
 *
 * Connections arrive as `conn-open` messages from the host. Each becomes a
 * {@link VirtualSocket} handed to the server as if a client had connected.
 * The handler gets a request for the path below the mount, with the caller's
 * headers and the body as its stream, and the caller (`ExtensionCaller`) as
 * its second argument, read from the host's verdict header, which the request
 * it sees no longer carries. That request has no cookie, no authorization
 * header and no DorkOS tokens (the host strips them).
 *
 * @module services/extensions/isolation/child/virtual-server
 */
import http from 'node:http';
import { getRequestListener } from '@hono/node-server';
import type {
  ExtensionCaller,
  ExtensionFetchHandler,
  PersonRefusal,
} from '@dorkos/extension-api/server';
import {
  PERSON_VERDICT_HEADER,
  parsePersonVerdict,
  type ChildMessage,
  type ConnMessage,
  type HostMessage,
} from '../ipc-protocol.js';
import { mountedLocation } from '../../http/reply-headers.js';
import { VirtualSocket } from '../virtual-socket.js';

/** What {@link createVirtualServer} needs. */
export interface VirtualServerDeps {
  /** The extension id: its mount is `/api/ext/<id>`. */
  extensionId: string;
  /** Send one message to the host; `onWritten` runs once it is written to the channel. */
  send: (message: ChildMessage, onWritten?: () => void) => void;
  /**
   * What a missing or unreadable verdict reads as: the in-process refusal of
   * an agent, word for word (fail closed).
   */
  personRefusal: PersonRefusal['body'];
}

/** The virtual server and its controls. */
export interface VirtualServer {
  /**
   * Handle a host message if it belongs to a virtual connection.
   *
   * @returns `true` when it did.
   */
  receive(message: HostMessage): boolean;
  /** Drop every open connection (the child is stopping). */
  closeAll(): void;
  /** Serve requests with this `fetch` handler, or answer 404 for `null`. */
  serveFetch(handler: ExtensionFetchHandler | null): void;
}

/** Methods whose request carries no body. */
const BODILESS = new Set(['GET', 'HEAD']);

/**
 * The caller the host's verdict header names: a refusal with the in-process
 * words for an agent when it is missing or unreadable.
 *
 * @param raw - The header's value.
 * @param refusal - The body to refuse with when it cannot be read.
 */
export function callerFrom(raw: unknown, refusal: PersonRefusal['body']): ExtensionCaller {
  const verdict = parsePersonVerdict(raw) ?? { ok: false, status: 403, body: refusal };
  return Object.freeze({ person: Object.freeze(verdict) });
}

/**
 * The path below the mount, or `null` when the path is not under the mount.
 *
 * @param pathname - The request's path, `/api/ext/<id>/…`.
 * @param mount - The mount, `/api/ext/<id>`.
 */
function belowMount(pathname: string, mount: string): string | null {
  if (pathname === mount) return '/';
  return pathname.startsWith(`${mount}/`) ? pathname.slice(mount.length) : null;
}

/**
 * A fetch handler's answer with its `location` moved under the mount
 * (`mountedLocation`), where the host's reply-header rule expects it. An
 * answer without one is returned as it is.
 *
 * @param answer - The handler's answer.
 * @param handlerUrl - The URL of the request the handler was given.
 * @param mount - The mount, `/api/ext/<id>`.
 */
function withMountedLocation(answer: Response, handlerUrl: string, mount: string): Response {
  const location = answer.headers.get('location');
  if (location === null) return answer;
  const headers = new Headers(answer.headers);
  const mounted = mountedLocation(location, handlerUrl, mount);
  if (mounted === null) headers.delete('location');
  else headers.set('location', mounted);
  return new Response(answer.body, {
    status: answer.status,
    statusText: answer.statusText,
    headers,
  });
}

/**
 * The JSON error answer every path here gives: the shape DorkOS's own
 * handler answers with.
 *
 * @param status - The status.
 * @param error - The message.
 */
function errorAnswer(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/**
 * Build the virtual server for one extension.
 *
 * @param deps - See {@link VirtualServerDeps}.
 */
export function createVirtualServer(deps: VirtualServerDeps): VirtualServer {
  const mount = `/api/ext/${deps.extensionId}`;
  let fetchHandler: ExtensionFetchHandler | null = null;
  const notFound = (path: string): Response =>
    errorAnswer(404, `Extension '${deps.extensionId}' has no route for ${path}`);

  // The handler gets a request for the path below the mount, without the
  // verdict header, and the caller it named. `overrideGlobalObjects: false`,
  // so the extension's own `Request` and `Response` stay the platform's.
  const serveFetch = getRequestListener(
    async (incoming) => {
      const sent = new URL(incoming.url);
      const below = belowMount(sent.pathname, mount);
      if (below === null) return notFound(sent.pathname);
      const handler = fetchHandler;
      if (!handler) return notFound(below);
      // Built field by field, never by resolving the path against an origin,
      // so a path such as `//evil.com/x` stays a path on this origin.
      const url = new URL(sent.origin);
      url.pathname = below;
      url.search = sent.search;
      const caller = callerFrom(incoming.headers.get(PERSON_VERDICT_HEADER), deps.personRefusal);
      const headers = new Headers(incoming.headers);
      headers.delete(PERSON_VERDICT_HEADER);
      const request = new Request(url, {
        method: incoming.method,
        headers,
        body: BODILESS.has(incoming.method) ? null : incoming.body,
        signal: incoming.signal,
        duplex: 'half',
      } as RequestInit);
      try {
        const answer: unknown = await handler(request, caller);
        if (!(answer instanceof Response)) {
          throw new Error('The fetch handler answered with something that is not a Response.');
        }
        return withMountedLocation(answer, request.url, mount);
      } catch (err) {
        console.error('Route error:', err);
        return errorAnswer(500, err instanceof Error ? err.message : 'Internal error');
      }
    },
    { overrideGlobalObjects: false }
  );

  const server = http.createServer((req, res) => void serveFetch(req, res));
  // A request that ends its stream early or never sends headers is the
  // host's problem to time out; nothing here waits on a wall clock.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;
  const sockets = new Map<number, VirtualSocket>();

  const send = (message: ConnMessage, onWritten?: () => void): boolean => {
    try {
      deps.send(message, onWritten);
      return true;
    } catch {
      return false;
    }
  };

  return {
    receive(message) {
      switch (message.type) {
        case 'conn-open': {
          if (sockets.has(message.cid)) return true;
          const socket = new VirtualSocket({
            cid: message.cid,
            send,
            onClose: () => sockets.delete(message.cid),
          });
          sockets.set(message.cid, socket);
          server.emit('connection', socket);
          return true;
        }
        case 'conn-data':
        case 'conn-end':
        case 'conn-destroy':
        case 'conn-pause':
        case 'conn-resume':
          sockets.get(message.cid)?.receive(message);
          return true;
        default:
          return false;
      }
    },
    closeAll() {
      for (const socket of sockets.values()) socket.destroy();
      sockets.clear();
    },
    serveFetch(handler) {
      fetchHandler = handler;
    },
  };
}
