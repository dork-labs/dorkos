/**
 * The production {@link ToolGroupGrantLookup}: read the grant off the agent's own
 * manifest, every time (spec `rooms-management-tools` §D3, DOR-1611).
 *
 * ## The manifest file, never the SQLite cache
 *
 * `.dork/agent.json` is the source of truth for `enabledToolGroups` and the
 * `agents` table is not: `packages/mesh/src/agent-registry.ts` has no column for
 * the field and its row reader hands back `{}` for every agent. Asking the cache
 * would therefore report every agent as ungranted — and, worse, would keep doing
 * so after a person granted it, which is a switch that appears to work and does
 * not. Reading the file is not an optimization to revisit; it is the only place
 * the answer exists.
 *
 * ## Deliberately not cached
 *
 * One warm `readFile` plus a Zod parse per call, on capabilities that are
 * occasional by construction — nothing on the room-turn hot path declares a tool
 * group. A stale grant is a correctness failure and this read is cheap, so the
 * trade is not close.
 *
 * @module services/core/capabilities/tool-group-grants
 */
import { readManifest } from '@dorkos/shared/manifest';

import type { ToolGroupGrantLookup } from './tool-group-enforcement.js';
import { logger } from '../../../lib/logger.js';

/**
 * Build the boot-injected grant lookup over the agent manifests on disk.
 *
 * Every not-a-yes reads as "not held": no manifest at that path, no
 * `enabledToolGroups`, the key absent, or the key explicitly `false`. A read that
 * THROWS propagates to the gate, which logs it and refuses — a grant that cannot
 * be read is a grant that is not held.
 *
 * @returns The lookup to hand `initToolGroupGate`.
 */
export function manifestToolGroupGrants(): ToolGroupGrantLookup {
  return {
    holds: async (agentPath, group) => {
      const manifest = await readManifest(agentPath, logger);
      return manifest?.enabledToolGroups?.[group] === true;
    },
  };
}
