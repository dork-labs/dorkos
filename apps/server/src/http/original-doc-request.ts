/** Hono's actual Node request/response and exact session admission, for original Doc lifetimes. */
import type { Context } from 'hono';
import type { Request, Response } from 'express';
import type { ApiEnv } from './api-chain.js';
import { expressRequestFacts, honoRequestFacts, type RequestFacts } from './request-facts.js';

const admittedRequests = new WeakMap<Request, RequestFacts>();
const responseOwners = new WeakMap<object, Request>();
const requestContexts = new WeakMap<Request, Context<ApiEnv>>();

/** Capture the genuine raw objects once; authentication remains the original session gate's. */
export function originalDocHonoRequest(c: Context<ApiEnv>): { req: Request; res: Response } {
  const req = c.env.incoming as Request;
  const res = c.env.outgoing as Response;
  const admitted = c.get('originalAdmittedRequest');
  if (!admitted || admitted.headers !== req.headers)
    throw new Error('Original Hono session admission is unavailable.');
  const previous = admittedRequests.get(req);
  if (previous && previous !== admitted)
    throw new Error('Original request admission cannot be replaced.');
  const owner = responseOwners.get(res);
  if (owner && owner !== req) throw new Error('Original response belongs to another request.');
  if (!owner) {
    if (Object.prototype.hasOwnProperty.call(res, 'locals'))
      throw new Error('Original Hono response locals cannot be replaced.');
    const locals = Object.freeze({
      get user() {
        return c.get('user');
      },
      get agentIdentity() {
        return c.get('agentIdentity');
      },
    });
    Object.defineProperty(res, 'locals', { value: locals, configurable: false, writable: false });
    responseOwners.set(res, req);
    admittedRequests.set(req, admitted);
    requestContexts.set(req, c);
  }
  return { req, res };
}

/** Framework-neutral facts using the SAME raw headers and live admitted identity getters. */
export function originalDocRequestFacts(req: Request, res: Pick<Response, 'locals'>): RequestFacts {
  const context = requestContexts.get(req);
  if (!context) return expressRequestFacts(req, res);
  if (
    responseOwners.get(res) !== req ||
    context.env.incoming !== req ||
    context.env.outgoing !== (res as object)
  )
    throw new Error('Original Hono request/response ownership changed.');
  return honoRequestFacts(context);
}

/** Repeat credential verification with the original exact admitted object, never a new DTO. */
export function originalDocAuthRequest(req: Request): Pick<Request, 'headers'> {
  return admittedRequests.get(req) ?? req;
}
