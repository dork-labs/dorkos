/**
 * The self-description domain: one capability, `capabilities.list`, that returns
 * the live catalog of everything the registry exposes (spec `capability-registry`,
 * task 2.3).
 *
 * This domain is special: its single capability's output IS the serialized
 * registry, so it must read the very registry it is composed into. That
 * self-reference is resolved with the late-binding dependency pattern — the
 * registry is written back onto the shared {@link CapabilityDeps} bag by
 * {@link composeDorkOsCapabilityRegistry} immediately after composition, before
 * any request is served. `catalog()` returns plain data (memoized by content
 * hash), so there is no recursion: composing the registry never invokes a
 * capability, and invoking `capabilities.list` only reads already-serialized
 * data.
 *
 * It lives OUTSIDE the registry spine (`services/core/capabilities/`) so that
 * spine stays domain-free (it imports no domain); this module, like the operator
 * and marketplace domains, migrates ONTO the spine.
 *
 * @module services/core/self-description/capabilities-domain
 */
import { z } from 'zod';
import { CAPABILITY_TIERS } from '@dorkos/shared/capabilities';

import { defineCapability, type CapabilityDomain } from '../capabilities/index.js';
import type { CapabilityDeps } from '../capabilities/index.js';
import type { CapabilityRegistry } from '../capabilities/index.js';

/**
 * Extend the shared dependency bag with the composed registry itself. Written
 * back by {@link composeDorkOsCapabilityRegistry} after composition (the
 * self-reference the catalog needs), so it is intentionally optional and asserted
 * at invoke time via {@link requireRegistry} rather than at compose time — the
 * registry does not exist yet while the bag is being captured.
 */
declare module '../capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** The composed registry, back-written after composition for self-description. */
    registry?: CapabilityRegistry;
  }
}

/**
 * Narrow the shared bag to the composed registry, throwing if `capabilities.list`
 * was invoked before the registry was back-written onto the bag (a wiring bug —
 * {@link composeDorkOsCapabilityRegistry} always sets it).
 *
 * @param deps - The registry's shared dependency bag.
 * @returns The composed registry.
 */
function requireRegistry(deps: CapabilityDeps): CapabilityRegistry {
  if (!deps.registry) {
    throw new Error(
      'capabilities.list invoked without the registry back-written onto the deps bag.'
    );
  }
  return deps.registry;
}

/**
 * A JSON Schema object as produced by `z.toJSONSchema` — a plain object map. The
 * catalog carries one per capability input and output; the schema is left
 * structural (a record) rather than re-describing the whole JSON Schema meta.
 */
const jsonSchema = z.record(z.string(), z.unknown());

/** The serialized surfaces of a capability, mirroring `CapabilitySurfaces`. */
const surfacesSchema = z.object({
  mcp: z
    .object({
      toolName: z.string(),
      servers: z.array(z.enum(['in-session', 'external'])),
      readOnlyCarveOut: z.boolean().optional(),
      annotations: z
        .object({
          openWorldHint: z.boolean().optional(),
          idempotentHint: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  cli: z
    .object({
      verb: z.string(),
      subcommand: z.string().optional(),
    })
    .optional(),
  http: z
    .object({
      method: z.enum(['get', 'post', 'put', 'patch', 'delete']),
      path: z.string(),
    })
    .optional(),
});

/** One serialized capability entry in the catalog, mirroring `SerializedCapability`. */
const serializedCapabilitySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  tier: z.enum(CAPABILITY_TIERS),
  inputSchema: jsonSchema,
  outputSchema: jsonSchema,
  surfaces: surfacesSchema,
});

/**
 * The full self-description catalog, mirroring the `CapabilityCatalog` type in
 * `@dorkos/shared/capabilities`. This is the REAL output contract for
 * `capabilities.list` (not `z.unknown()`): the catalog it returns validates
 * against this shape, and it projects into a precise JSON Schema in the catalog's
 * own `outputSchema`.
 */
export const capabilityCatalogSchema = z.object({
  catalogVersion: z.string(),
  generatedAt: z.string(),
  capabilities: z.array(serializedCapabilitySchema),
});

/**
 * The self-description domain. A single `observe`-tier capability, advertised as
 * the `list_capabilities` tool on both MCP servers and — through its `http`
 * surface — the `GET /api/capabilities/catalog` route. Its `invoke` returns the
 * live catalog of the composed registry.
 */
export const capabilitiesDomain: CapabilityDomain = {
  name: 'capabilities',
  capabilities: [
    defineCapability({
      id: 'capabilities.list',
      title: 'List capabilities',
      description:
        'List everything you can do in this DorkOS: the live, versioned catalog of every ' +
        'capability the registry exposes, each with its id, title, description, permission tier, ' +
        'input/output JSON Schema, and the surfaces (MCP tool, CLI verb, HTTP route) it projects onto. ' +
        'Call this first to discover what actions and tools are available before reaching for a specific one.',
      tier: 'observe',
      input: z.object({}),
      output: capabilityCatalogSchema,
      surfaces: {
        mcp: {
          toolName: 'list_capabilities',
          servers: ['in-session', 'external'],
          readOnlyCarveOut: true,
          annotations: { idempotentHint: true },
        },
        http: { method: 'get', path: '/api/capabilities/catalog' },
      },
      invoke: async (deps) => requireRegistry(deps).catalog(),
    }),
  ],
};
