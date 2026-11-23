/**
 * Project registry capabilities onto the OpenAPI document (spec
 * `capability-registry`, task 2.5).
 *
 * Every capability that declares an `http` surface auto-registers one path on
 * the existing `@asteasolutions/zod-to-openapi` registry so it appears in
 * `/api/docs` and the exported `docs/api/openapi.json`. The path is tagged by
 * the capability's domain, its `operationId` is the capability id (one
 * definition, two documented doors: this path and the invoke endpoint), its
 * request schema comes from the capability's Zod `input` (each `{name}` path
 * segment as a path parameter, the remaining fields as query params for read
 * methods or a JSON body for write methods), and its response schema from the
 * Zod `output`. Nothing is hand-mirrored: a
 * capability's own schemas go straight onto the registry, so the `Local*Schema`
 * documentation shapes in `openapi-registry.ts` have no counterpart here.
 *
 * ## No duplicate paths
 *
 * {@link registerCapabilitiesInOpenApi} refuses to shadow a legacy
 * hand-registered path: if a capability's `method + path` already exists on the
 * document it throws at generation time with a message naming the collision, so
 * a capability accidentally claiming a hand-owned route fails the OpenAPI export
 * (and its CI freshness gate) rather than silently double-registering.
 *
 * @module services/core/capabilities/openapi-projection
 */
import type { OpenAPIRegistry, RouteConfig } from '@asteasolutions/zod-to-openapi';
import type { z } from 'zod';
import { capabilityInputObject, splitPathParams } from './input-projection.js';

import type { CapabilityRegistry } from './registry.js';

/**
 * Build the set of `METHOD /path` keys already registered on the OpenAPI
 * document, used to reject a capability that would shadow a hand-registered
 * route.
 *
 * @param registryDoc - The zod-to-openapi document registry to scan.
 * @returns The upper-cased `${METHOD} ${path}` keys of every existing route.
 */
function registeredRouteKeys(registryDoc: OpenAPIRegistry): Set<string> {
  const keys = new Set<string>();
  for (const def of registryDoc.definitions) {
    if (def.type === 'route') {
      keys.add(`${def.route.method.toUpperCase()} ${def.route.path}`);
    }
  }
  return keys;
}

/**
 * Capitalize a domain name into its OpenAPI tag (`operator` → `Operator`), so a
 * capability's paths group under a per-domain tag in the Scalar UI.
 *
 * @param domain - The capability id's domain prefix.
 * @returns The tag label.
 */
function domainTag(domain: string): string {
  return domain.charAt(0).toUpperCase() + domain.slice(1);
}

/**
 * Build the projected request: path parameters, then the remaining input fields
 * as query parameters (read methods) or a JSON body (write methods).
 *
 * @param method - The capability's HTTP method.
 * @param params - The path parameters, or `null` when the path has none.
 * @param rest - The input fields the path does not carry.
 * @returns The request config, or `undefined` when there is nothing to declare.
 */
function projectRequest(
  method: string,
  params: z.ZodObject<z.ZodRawShape> | null,
  rest: z.ZodObject<z.ZodRawShape>
): RouteConfig['request'] {
  const request: NonNullable<RouteConfig['request']> = params ? { params } : {};
  if (Object.keys(rest.shape).length > 0) {
    const isWrite = method === 'post' || method === 'put' || method === 'patch';
    if (isWrite) request.body = { content: { 'application/json': { schema: rest } } };
    else request.query = rest;
  }
  return Object.keys(request).length > 0 ? request : undefined;
}

/**
 * Project every registry capability that declares an `http` surface onto the
 * OpenAPI document, one path each.
 *
 * Request schemas derive from the capability's Zod `input` (a `z.object(...)`):
 * each `{name}` segment of the path is a path parameter, taking the input field
 * of that name when there is one (see {@link splitPathParams}); the remaining
 * fields project as query parameters for read methods (`get`/`delete`) and as a
 * JSON request body for write methods (`post`/`put`/`patch`). A capability with
 * no path parameters and an empty input object projects no request. The response schema is the
 * capability's Zod `output`; capabilities that still model `output` as
 * `z.unknown()` project an open response schema (honest-but-weak) that tightens
 * as their outputs are modelled — no separate hand-registration is added here.
 *
 * @param registry - The composed capability registry to project from.
 * @param registryDoc - The zod-to-openapi document to register paths onto.
 * @throws If a capability's `method + path` collides with a route already
 *   registered on the document (a legacy hand-registered path).
 */
export function registerCapabilitiesInOpenApi(
  registry: CapabilityRegistry,
  registryDoc: OpenAPIRegistry
): void {
  const taken = registeredRouteKeys(registryDoc);

  for (const capability of registry.capabilities) {
    const http = capability.surfaces.http;
    if (!http) continue;

    const key = `${http.method.toUpperCase()} ${http.path}`;
    if (taken.has(key)) {
      throw new Error(
        `Capability "${capability.id}" projects "${key}" but that path is already ` +
          `hand-registered in the OpenAPI document. Remove the capability's http surface ` +
          `or migrate the hand-registered path onto the registry.`
      );
    }
    taken.add(key);

    const domain = capability.id.slice(0, capability.id.indexOf('.'));
    const { params, rest } = splitPathParams(capabilityInputObject(capability), http.path);
    const request = projectRequest(http.method, params, rest);

    registryDoc.registerPath({
      method: http.method,
      path: http.path,
      operationId: capability.id,
      tags: [domainTag(domain)],
      summary: capability.title,
      description: capability.description,
      ...(request ? { request } : {}),
      responses: {
        200: {
          description: `${capability.title} result`,
          content: { 'application/json': { schema: capability.output } },
        },
      },
    });
  }
}
