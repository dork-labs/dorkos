/**
 * `marketplace_link` — run a plugin or skill pack from a folder on this
 * computer, as a dev link (DOR-2696, spec `marketplace-dev-link`).
 *
 * The approval lives OUTSIDE this handler: the capability is `destructive` with
 * no permission area, so `registry.invoke` asks a person on every call, binds
 * the approval to this exact input (the folder's real path among it), and no
 * setting or "Always allow" can pre-approve it. By the time this runs, a person
 * said yes to this folder, or the caller is the person.
 *
 * @module services/marketplace-mcp/tool-link
 */
import { z } from 'zod';
import type { DevLinkStatus } from '@dorkos/shared/marketplace-schemas';
import { BoundaryError, validateBoundary } from '../../lib/boundary.js';
import { CapabilityToolError } from '../core/capabilities/mcp-envelope.js';
import { DevLinkError } from '../marketplace/dev-links/errors.js';
import type { DevLinkService, DevLinkTarget } from '../marketplace/dev-links/index.js';
import type { MarketplaceMcpDeps } from './marketplace-mcp-tools.js';

/**
 * The longest folder path a dev link takes. Well under what an approval card
 * stores, so the card's description (which carries the path in full) always
 * fits, and shared with the HTTP route so neither door answers a long path
 * with a 500.
 */
export const DEV_LINK_PATH_MAX = 1024;

/** Input for `marketplace_link`. */
export const LinkInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(DEV_LINK_PATH_MAX)
    .describe('Absolute real path of the folder holding the plugin or skill pack'),
  projectPath: z
    .string()
    .min(1)
    .optional()
    .describe('Link it for this project only; omit to link it for every session'),
  replaceInstalled: z
    .boolean()
    .optional()
    .describe('Set an installed copy of the same package aside while the link is in place'),
});

/** Arguments of `marketplace_link`. */
export type LinkToolArgs = z.infer<typeof LinkInputSchema>;

/** The dev-link service, or the refusal that says it is not running here. */
function requireDevLinks(deps: MarketplaceMcpDeps): DevLinkService {
  if (deps.devLinks) return deps.devLinks;
  throw new CapabilityToolError({
    error: "Dev links aren't available on this server right now.",
    code: 'dev_links_unavailable',
  });
}

/**
 * The link the arguments ask for, with `projectPath` confined to the
 * directory boundary and spelled canonically.
 */
async function targetOf(args: LinkToolArgs): Promise<DevLinkTarget & { replaceInstalled?: true }> {
  let projectPath: string | undefined;
  if (args.projectPath) {
    try {
      projectPath = await validateBoundary(args.projectPath);
    } catch (err) {
      if (err instanceof BoundaryError) {
        throw new CapabilityToolError({
          error: 'That project is outside the folders DorkOS may use.',
          code: 'dev_link_path_not_allowed',
        });
      }
      throw err;
    }
  }
  return {
    path: args.path,
    scope: projectPath ? 'project' : 'global',
    ...(projectPath ? { projectPath } : {}),
    ...(args.replaceInstalled ? { replaceInstalled: true as const } : {}),
  };
}

/** Run a dev-link call, turning a refusal into the tool's error result. */
async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof DevLinkError) throw new CapabilityToolError(err.toBody());
    throw err;
  }
}

/**
 * The approval card's description for a `marketplace_link` call, which the
 * approval is bound to (`describeApprovalChange`): the folder in full, what it
 * sets aside, the extensions it may run and what it runs on its own. A folder
 * that cannot be linked is refused here, before any card is raised.
 *
 * @param deps - The marketplace service bundle.
 * @param args - The call's arguments.
 * @returns The description.
 */
export async function describeLinkApproval(
  deps: MarketplaceMcpDeps,
  args: LinkToolArgs
): Promise<string> {
  const devLinks = requireDevLinks(deps);
  const target = await targetOf(args);
  return refusing(() => devLinks.describeApproval(target));
}

/**
 * Build the handler. It links exactly what the card described: the
 * description is read again and the link is refused if the folder no longer
 * matches it. Refusals come back as the tool's error result, with the refusal
 * code and one sentence the agent can act on.
 *
 * @param deps - The marketplace service bundle.
 * @returns The handler: arguments plus whether the caller is the person.
 */
export function createLinkHandler(deps: MarketplaceMcpDeps) {
  return async (args: LinkToolArgs, caller: { trusted: boolean }): Promise<DevLinkStatus> => {
    const devLinks = requireDevLinks(deps);
    const target = await targetOf(args);
    return refusing(async () => {
      const expectedChange = await devLinks.describeApproval(target);
      return devLinks.link({
        ...target,
        via: caller.trusted ? 'terminal' : 'agent-card',
        expectedChange,
      });
    });
  };
}
