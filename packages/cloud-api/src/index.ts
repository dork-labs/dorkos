/**
 * `@dork-labs/cloud-api` — the public wire contract for DorkOS Cloud.
 *
 * The root export is schemas, inferred types and route paths only. There is no
 * network code here on purpose: a program can validate a payload against this
 * contract without pulling in a client. The thin `fetch` client lives at
 * `@dork-labs/cloud-api/client`.
 *
 * Two rules govern everything in this file, and both are enforced by tests in
 * `src/__tests__/`:
 *
 * 1. **Additive within `/v1`.** New endpoints and new optional fields only.
 *    Removing a field, or making an optional one required, is `/v2`.
 * 2. **Catalog blindness.** No type here enumerates the plan catalog or the
 *    model catalog. `planId`, `skuId`, `modelId`, add-on kinds and every
 *    catalog-shaped identifier are opaque strings — never an enum, a literal
 *    union, a const array or a value named in a description.
 *
 * @packageDocumentation
 */

export * from './primitives.js';
export * from './problem.js';
export * from './routes.js';
export * from './session.js';
export * from './instances.js';
export * from './connections.js';
export * from './billing.js';
export * from './inference.js';
export * from './seats.js';
export * from './remote.js';
