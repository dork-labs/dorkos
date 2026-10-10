/**
 * Preload for the route census (DOR-2793): remember the path every Express
 * middleware and router was mounted at.
 *
 * Express 5's router compiles a mount path into a matcher and keeps no string,
 * so walking the router stack after the fact cannot say that a router serves
 * `/api/relay`. This wraps `Router.prototype.use` to tag each layer it adds with
 * the path it was given. It changes nothing a request sees.
 *
 * Routers are built when their modules load, so this must run before the
 * server's first import: it is loaded with `--import` by the contract harness
 * (`__tests__/contract/harness.ts`) and never by the server itself.
 *
 * @module http/route-census/record-mount-paths
 */
import express from 'express';
import { MOUNT_PATH } from './census.js';

/** A router's stack, as far as this file touches it. */
type Stack = { stack: Array<Record<symbol, unknown>> };
type Use = (this: Stack, ...args: unknown[]) => unknown;

const proto = express.Router.prototype as unknown as { use: Use };
const use = proto.use;

proto.use = function recordMountPath(this: Stack, ...args) {
  let first = args[0];
  while (Array.isArray(first) && first.length > 0) first = first[0];
  const path = typeof first === 'function' ? '/' : args[0];
  const before = this.stack.length;
  const result = use.apply(this, args);
  for (let i = before; i < this.stack.length; i++) this.stack[i][MOUNT_PATH] = path;
  return result;
};
