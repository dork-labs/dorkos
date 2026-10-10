/**
 * Build the SAME request through both adapters, so a policy test can run once
 * per chain and prove the two chains get one answer (DOR-2794).
 *
 * The Express side is a real Express request object (its prototype, an app with
 * `trust proxy, 1` as `app.ts` sets it), so `req.ip` is Express's own
 * computation rather than a stand-in. The Hono side is a real Hono context,
 * served by `app.request` with the Node bindings `@hono/node-server` provides.
 */
import express, { type Request, type Response } from 'express';
import { Hono } from 'hono';
import type { AgentIdentity } from '../../services/core/agent-identity/agent-identity-service.js';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
import {
  expressRequestFacts,
  honoRequestFacts,
  type RequestFacts,
  type RequestFactsEnv,
} from '../request-facts.js';

/** One request, described the way a test thinks about it. */
export interface DescribedRequest {
  /** Request headers, any case. */
  headers?: Record<string, string>;
  /** The TCP peer. `null` means the socket reports no address. */
  peer?: string | null;
  /** Whether the socket is TLS. */
  encrypted?: boolean;
  /** What the session gate resolved. */
  user?: RequestUser;
  /** What the agent-identity middleware resolved. */
  agentIdentity?: AgentIdentity;
}

/** One way to turn a described request into facts. */
export interface RequestFactsAdapter {
  /** `express` or `hono`, for the test title. */
  readonly name: string;
  /** Build the request in this framework and read its facts. */
  facts(described: DescribedRequest): Promise<RequestFacts>;
}

/** The app every Express request object below belongs to, set as production sets it. */
const expressApp = express();
expressApp.set('trust proxy', 1);

/** Node's view of the headers: lower-case names, as both frameworks receive them. */
function nodeHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}

/** A socket stand-in carrying only what the adapters read. */
function socketOf(described: DescribedRequest): { remoteAddress?: string; encrypted?: boolean } {
  return {
    remoteAddress: described.peer === null ? undefined : (described.peer ?? '127.0.0.1'),
    ...(described.encrypted ? { encrypted: true } : {}),
  };
}

/** The Express adapter, over a real Express request object. */
const viaExpress: RequestFactsAdapter = {
  name: 'express',
  async facts(described) {
    const req = Object.create(expressApp.request) as Request;
    Object.assign(req, {
      app: expressApp,
      headers: nodeHeaders(described.headers),
      socket: socketOf(described),
    });
    const locals: Record<string, unknown> = {};
    if (described.user) locals.user = described.user;
    if (described.agentIdentity) locals.agentIdentity = described.agentIdentity;
    return expressRequestFacts(req, { locals } as unknown as Response);
  },
};

/** The Hono adapter, over a real Hono context. */
const viaHono: RequestFactsAdapter = {
  name: 'hono',
  async facts(described) {
    let captured: RequestFacts | undefined;
    const app = new Hono<RequestFactsEnv>();
    app.use(async (c, next) => {
      if (described.user) c.set('user', described.user);
      if (described.agentIdentity) c.set('agentIdentity', described.agentIdentity);
      await next();
    });
    app.all('*', (c) => {
      captured = honoRequestFacts(c);
      return c.body(null, 204);
    });
    const incoming = { headers: nodeHeaders(described.headers), socket: socketOf(described) };
    await app.request('/', { headers: described.headers }, { incoming, outgoing: {} });
    return captured!;
  },
};

/** Both adapters, for `describe.each`. */
export const REQUEST_FACTS_ADAPTERS: readonly RequestFactsAdapter[] = [viaExpress, viaHono];
