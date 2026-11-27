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
import type { HttpSurface, HttpSuccessStatus } from '@dorkos/shared/capabilities';
import type { CapabilityDefinition } from './capability-definition.js';
import {
  capabilityStandardResponses,
  registerInvokeOperation,
} from '../openapi/capabilities-invoke.js';
import { PROBLEM_CONTENT_TYPE, ProblemSchema } from '@dorkos/shared/problem';
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
 * from the query string and, for a write, the JSON body (see {@link HttpSurface}).
 *
 * @param http - The capability's HTTP surface.
 * @param params - The path parameters, or `null` when the path has none.
 * @param rest - The input fields the path does not carry.
 * @returns The request config, or `undefined` when there is nothing to declare.
 */
function projectRequest(
  http: HttpSurface,
  params: z.ZodObject<z.ZodRawShape> | null,
  rest: z.ZodObject<z.ZodRawShape>
): RouteConfig['request'] {
  const request: NonNullable<RouteConfig['request']> = params ? { params } : {};
  const isWrite = http.method === 'post' || http.method === 'put' || http.method === 'patch';
  const fields = Object.keys(rest.shape);
  const queryFields = http.query
    ? fields.filter((key) => http.query!.includes(key))
    : isWrite
      ? []
      : fields;
  if (queryFields.length === fields.length) {
    if (fields.length > 0) request.query = rest;
    return Object.keys(request).length > 0 ? request : undefined;
  }
  const inQuery = Object.fromEntries(queryFields.map((key) => [key, true as const]));
  if (queryFields.length > 0) request.query = rest.pick(inQuery);
  const body = queryFields.length > 0 ? rest.omit(inQuery) : rest;
  request.body = { content: { 'application/json': { schema: body } } };
  return request;
}

/**
 * The documented responses of a capability's route: its success, and the
 * dispatcher's standard ones beside it.
 *
 * @param capability - The capability.
 * @param status - The route's success status.
 * @returns The `responses` entry.
 */
function projectSuccess(
  capability: CapabilityDefinition,
  status: HttpSuccessStatus
): RouteConfig['responses'] {
  const description = `${capability.title} result`;
  const success =
    status === 204
      ? { description }
      : { description, content: { 'application/json': { schema: capability.output } } };
  // The capability's own refusals, documented beside the standard ones they narrow.
  const own = Object.fromEntries(
    Object.entries(capability.httpErrors ?? {}).map(([code, error]) => [
      code,
      {
        description: error.description,
        content: { [PROBLEM_CONTENT_TYPE]: { schema: error.schema ?? ProblemSchema } },
      },
    ])
  );
  // A 202 success replaces the approval entry: both mean "accepted, not done".
  return { ...capabilityStandardResponses(), ...own, [status]: success };
}

/**
 * Project every registry capability that declares an `http` surface onto the
 * OpenAPI document, one path each.
 *
 * Request schemas derive from the capability's Zod `input` (a `z.object(...)`):
 * each `{name}` segment of the path is a path parameter, taking the input field
 * it fills (see {@link splitPathParams}); the remaining fields project as the
 * surface reads them, the same way the generic mount does
 * (`routes/capability-http.ts`): query parameters for read methods
 * (`get`/`delete`), a JSON body for writes, and the surface's `query` list when
 * it names one. The success status is the surface's `success` (`200` unless
 * declared), and `x-stability` its `stability` when it declares one (the
 * document's last pass gives the others a capability's default, from the keys
 * this returns). Last, it documents the generic invoke endpoint, the second door
 * onto every one of these capabilities. A capability with
 * no path parameters and an empty input object projects no request. The response schema is the
 * capability's Zod `output`; capabilities that still model `output` as
 * `z.unknown()` project an open response schema (honest-but-weak) that tightens
 * as their outputs are modelled — no separate hand-registration is added here.
 *
 * @param registry - The composed capability registry to project from.
 * @param registryDoc - The zod-to-openapi document to register paths onto.
 * @returns The `METHOD /path` keys it projected, as `GET /api/x/{id}`.
 * @throws If a capability's `method + path` collides with a route already
 *   registered on the document (a legacy hand-registered path).
 */
export function registerCapabilitiesInOpenApi(
  registry: CapabilityRegistry,
  registryDoc: OpenAPIRegistry
): ReadonlySet<string> {
  const taken = registeredRouteKeys(registryDoc);
  const projected = new Set<string>();

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
    projected.add(key);

    const domain = capability.id.slice(0, capability.id.indexOf('.'));
    const { params, rest } = splitPathParams(
      capabilityInputObject(capability),
      http.path,
      http.params
    );
    const request = projectRequest(http, params, rest);

    registryDoc.registerPath({
      method: http.method,
      path: http.path,
      operationId: capability.id,
      ...(http.stability ? { 'x-stability': http.stability } : {}),
      tags: [domainTag(domain)],
      summary: capability.title,
      description: capability.description,
      ...(request ? { request } : {}),
      responses: projectSuccess(capability, http.success ?? 200),
    });
  }
  registerInvokeOperation(registryDoc);
  return projected;
}
