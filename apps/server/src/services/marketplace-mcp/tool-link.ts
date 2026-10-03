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
import { APPROVAL_DETAIL_MAX_LENGTH } from '@dorkos/shared/approval-schemas';
import type { DevLinkStatus } from '@dorkos/shared/marketplace-schemas';
import { BoundaryError, validateBoundary } from '../../lib/boundary.js';
import { CapabilityToolError } from '../core/capabilities/mcp-envelope.js';
import { DevLinkError } from '../marketplace/dev-links/errors.js';
import type { MarketplaceMcpDeps } from './marketplace-mcp-tools.js';

/**
 * Input for `marketplace_link`. `path` is the field the approval card shows in
 * full, so it is capped at what the card stores.
 */
export const LinkInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(APPROVAL_DETAIL_MAX_LENGTH)
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

/**
 * Build the handler. Refusals come back as the tool's error result, with the
 * refusal code and one sentence the agent can act on.
 *
 * @param deps - The marketplace service bundle.
 * @returns The handler: arguments plus whether the caller is the person.
 */
export function createLinkHandler(deps: MarketplaceMcpDeps) {
  return async (args: LinkToolArgs, caller: { trusted: boolean }): Promise<DevLinkStatus> => {
    const devLinks = deps.devLinks;
    if (!devLinks) {
      throw new CapabilityToolError({
        error: "Dev links aren't available on this server right now.",
        code: 'dev_links_unavailable',
      });
    }
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
    try {
      return await devLinks.link({
        path: args.path,
        scope: projectPath ? 'project' : 'global',
        ...(projectPath ? { projectPath } : {}),
        ...(args.replaceInstalled ? { replaceInstalled: true } : {}),
        via: caller.trusted ? 'terminal' : 'agent-card',
      });
    } catch (err) {
      if (err instanceof DevLinkError) throw new CapabilityToolError(err.toBody());
      throw err;
    }
  };
}
