/**
 * Project registry capabilities onto the OpenAPI document (spec
 * `capability-registry`, task 2.5).
 *
 * Every capability that declares an `http` surface auto-registers one path on
 * the existing `@asteasolutions/zod-to-openapi` registry so it appears in
 * `/api/docs` and the exported `docs/api/openapi.json`. The path is tagged by
 * the capability's domain, its request schema comes from the capability's Zod
 * `input` (query params for read methods, a JSON body for write methods), and
 * its response schema from the Zod `output`. Nothing is hand-mirrored: the
 * capability schemas are native Zod v4, which the repo's zod-to-openapi v8
 * consumes directly — the Zod-3 mirror caveats in `openapi-registry.ts` apply
 * only to the Zod-3 `@dorkos/marketplace` schemas, never to these.
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
 * Project every registry capability that declares an `http` surface onto the
 * OpenAPI document, one path each.
 *
 * Request schemas derive from the capability's Zod `input` (a `z.object(...)`):
 * read methods (`get`/`delete`) project its fields as query parameters, write
 * methods (`post`/`put`/`patch`) as a JSON request body. A capability whose
 * input object is empty projects no request. The response schema is the
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
    const inputObject = capability.input as z.ZodObject<z.ZodRawShape>;
    const hasInputFields = Object.keys(inputObject.shape).length > 0;
    const isWrite = http.method === 'post' || http.method === 'put' || http.method === 'patch';

    const request: RouteConfig['request'] = hasInputFields
      ? isWrite
        ? { body: { content: { 'application/json': { schema: inputObject } } } }
        : { query: inputObject }
      : undefined;

    registryDoc.registerPath({
      method: http.method,
      path: http.path,
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
