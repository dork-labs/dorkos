/**
 * The `link.resolve` capability: what a `/r/<dork-uri>` link opens (DOR-5046,
 * ADR 261122-124821 §5.4).
 *
 * Declared once here; the registry projects it onto `GET /api/links/target`
 * (served by the generic mount, `routes/capability-http.ts`), its OpenAPI
 * entry, both MCP servers (`resolve_link`) and `dorkos call link.resolve`. The
 * app's `/r/$` route calls it and opens the screen the answer names.
 *
 * A link is a pointer, never a key: it carries no token, and asking about one
 * grants nothing. Everything that opens nothing for the caller (missing,
 * private, an unknown kind, an address, a malformed string) is refused with
 * the one code `LINK_NOT_FOUND`, a 404 on every door, so a link never confirms
 * that anything exists.
 *
 * @module services/core/links/link-capabilities
 */
import {
  DorkLinkResolveRequestSchema,
  LINK_NOT_FOUND_CODE,
  ResolvedDorkLinkSchema,
} from '@dorkos/shared/dork-link-schemas';
import {
  CapabilityToolError,
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
} from '../capabilities/index.js';
import { resolveDorkLink, type DorkLinkLookups } from './resolve-dork-link.js';

declare module '../capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** Present when the server can resolve `dork:` links; gates the `link` domain. */
    linkDeps?: {
      /** Where each kind is found, and who may see it. */
      lookups: DorkLinkLookups;
    };
  }
}

/**
 * Narrow the bag to the link lookups, throwing if the registry was composed
 * without them (a wiring bug, caught at boot by `assertDeps`).
 *
 * @param deps - The capability bag.
 */
function requireLinkLookups(deps: CapabilityDeps): DorkLinkLookups {
  if (!deps.linkDeps) {
    throw new Error('Link capability invoked without linkDeps in the registry bag.');
  }
  return deps.linkDeps.lookups;
}

/** The one refusal: the same words whether the thing is missing or private. */
function linkNotFound(): CapabilityToolError {
  return new CapabilityToolError({
    error: 'That link opens nothing you can see here.',
    code: LINK_NOT_FOUND_CODE,
  });
}

/** The `link` domain. */
export const linkDomain: CapabilityDomain = {
  name: 'link',
  assertDeps: requireLinkLookups,
  capabilities: [
    defineCapability({
      id: 'link.resolve',
      title: 'Open a dork: link',
      description:
        'Find what a dork: reference names on this DorkOS, such as dork:chat:<id>, ' +
        'dork:room:<id>, dork:entry:<id> or dork:agent:<id> (the part of a /r/ link after ' +
        '/r/). Returns its kind and the ids that open it: a chat id, a room id, a message ' +
        'with its room and place, or an agent id. A chat named by the id it had before its ' +
        'first reply is followed to the id it has now. Anything that is not there, that you ' +
        'may not see, or that is not a chat, room, message or agent answers LINK_NOT_FOUND.',
      tier: 'observe',
      area: null,
      areaNote: 'reading',
      input: DorkLinkResolveRequestSchema,
      output: ResolvedDorkLinkSchema,
      surfaces: {
        mcp: {
          toolName: 'resolve_link',
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: true },
        },
        // A noun, the thing a link points at: the API lint refuses a command word
        // such as `resolve` in a path and lets the method be the action.
        http: { method: 'get', path: '/api/links/target' },
      },
      invoke: async (deps, input, context) => {
        const resolved = await resolveDorkLink(input.uri, requireLinkLookups(deps), context);
        if (!resolved) throw linkNotFound();
        return resolved;
      },
    }),
  ],
};
