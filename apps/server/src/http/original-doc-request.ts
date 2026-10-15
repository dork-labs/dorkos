/** Hono's actual Node request/response and exact session admission, for original Doc lifetimes. */
import type { Context } from 'hono';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiEnv } from './api-chain.js';
import type { RequestUser } from '../services/core/auth/session-gate.js';
import { honoRequestFacts, type RequestFacts } from './request-facts.js';

const admittedRequests = new WeakMap<IncomingMessage, RequestFacts>();
const responseOwners = new WeakMap<object, IncomingMessage>();
const requestContexts = new WeakMap<IncomingMessage, Context<ApiEnv>>();

/** Capture the genuine raw objects once; authentication remains the original session gate's. */
export function originalDocHonoRequest(c: Context<ApiEnv>): {
  req: IncomingMessage;
  res: ServerResponse;
} {
  const req = c.env.incoming;
  const res = c.env.outgoing;
  const admitted = c.get('originalAdmittedRequest');
  if (!admitted || admitted.headers !== req.headers)
    throw new Error('Original Hono session admission is unavailable.');
  const previous = admittedRequests.get(req);
  if (previous && previous !== admitted)
    throw new Error('Original request admission cannot be replaced.');
  const owner = responseOwners.get(res);
  if (owner && owner !== req) throw new Error('Original response belongs to another request.');
  if (!owner) {
    responseOwners.set(res, req);
    admittedRequests.set(req, admitted);
    requestContexts.set(req, c);
  }
  return { req, res };
}

/** Framework-neutral facts using the SAME raw headers and live admitted identity getters. */
export function originalDocRequestFacts(req: IncomingMessage, res: ServerResponse): RequestFacts {
  const context = requestContexts.get(req);
  if (!context) throw new Error('Original Hono request ownership is unavailable.');
  if (
    responseOwners.get(res) !== req ||
    context.env.incoming !== req ||
    context.env.outgoing !== res
  )
    throw new Error('Original Hono request/response ownership changed.');
  return honoRequestFacts(context);
}

/** Repeat credential verification with the original exact admitted object, never a new DTO. */
export function originalDocAuthRequest(req: IncomingMessage): Pick<RequestFacts, 'headers'> {
  return admittedRequests.get(req) ?? req;
}

/** Read the live principal only through the genuinely owned raw request/response pair. */
export function originalDocRequestUser(
  req: IncomingMessage,
  res: ServerResponse
): RequestUser | undefined {
  return originalDocRequestFacts(req, res).user;
}
