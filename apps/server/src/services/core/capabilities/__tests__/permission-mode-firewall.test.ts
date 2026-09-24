/**
 * Permission mode is firewalled from the tier gate, and this is what makes that a
 * property rather than an accident (spec `agent-approval-settings` §3.8).
 *
 * Today `bypassPermissions` does not reach the gate, but only because nothing
 * passes it: `TierEnforcementRequest` has no such field. **An absence is exactly
 * the defect shape standing permissions exist to remove** — an invariant that holds
 * because nobody has wired the wire yet is one refactor away from not holding. So
 * two guards replace it:
 *
 * - **Behavioral, and primary.** For every value of `PermissionModeSchema`, a
 *   destructive capability with no live permission is parked for approval. This
 *   asserts the thing a person cares about, and it keeps holding if the plumbing
 *   underneath is rewritten.
 * - **Structural.** No file under `services/core/capabilities/` or
 *   `services/core/approvals/` mentions `permissionMode`. That grep returns nothing
 *   today; freezing it as a test is what stops somebody wiring it in later.
 *
 * ## Why the firewall stays (operator decision, 2026-09-18, DOR-2102)
 *
 * The reason this file used to give has expired, and saying so matters more than
 * quietly leaving it: the hole it pointed at was an agent setting
 * `bypassPermissions` on a schedule through the `tasks_update` MCP tool, and
 * DOR-504 closed it. `task-write-policy.ts` now classifies `permissionMode` as
 * `operator-only` and refuses the field outright, so that door is shut at the
 * door rather than here. A guard justified only by a fixed bug is a guard the
 * next reader deletes.
 *
 * It was re-examined on its merits and kept. Three grounds, in the order they
 * actually decided it:
 *
 * 1. **It costs this operator nothing.** The thing a merge would buy is fewer
 *    interruptions, and the tier gate is not where the interruptions are. Of 43
 *    recorded since 2026-09-10 on the reporting machine, 35 were the runtime's
 *    own permission prompts and 8 were schedule cards; the capability card gate
 *    had fired zero times. Full autonomy already removes the 35. The other 8 are
 *    a different mechanism again — a parked `Task`, not a tier-gated capability
 *    hold — so merging permission mode into THIS gate would not remove them
 *    either. The change buys zero fewer interruptions and is paid for with
 *    grounds 2 and 3.
 * 2. **The two gates have different blast radii.** A runtime prompt guards a
 *    recoverable question — "did you mean to run this command" — in a working
 *    tree with a git history behind it. The tier gate guards permanent, outward
 *    actions: `mesh_unregister` deletes an agent's file and tears down its relay
 *    endpoint, `marketplace.uninstall` removes a package. One switch for both
 *    means a dial flipped for convenience also disarms the irreversible half,
 *    and the person flipping it is thinking about the first kind.
 * 3. **The reversal cost is asymmetric.** Keeping the firewall and opening it
 *    later is cheap: the wire is one field, and the evidence for wanting it
 *    would be a card count that is no longer zero. Opening it and then
 *    discovering what it was for is not cheap, because what that discovery
 *    looks like is a deleted agent nobody approved.
 *
 * So the supported way to stop being asked at this gate is still a standing
 * permission, which needs a signed-in person and a clock, and the approval card
 * now offers one in place. Permission mode governs the runtime's own prompts
 * INSIDE a session and is deliberately a different control. The product says so
 * out loud wherever the stop is chosen (`PermissionModeScopeNote`), which is the
 * other half of this decision: a firewall a person cannot see is indistinguishable
 * from a broken promise.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createTestDb } from '@dorkos/test-utils/db';
import { PermissionModeSchema } from '@dorkos/shared/schemas';

import { defineCapability } from '../capability-definition.js';
import {
  enforceCapabilityTier,
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../tier-enforcement.js';
import { ApprovalGrantService, ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import { codeOnly } from '../../../../../../../scripts/lib/code-only.mjs';

/** The destructive capability every case in this file reaches for. */
const DESTROY = defineCapability({
  id: 'demo.destroy',
  title: 'Delete a thing permanently',
  description: 'A destructive capability used by the permission-mode firewall guard.',
  tier: 'destructive',
  area: null,
  input: z.object({ name: z.string() }),
  output: z.unknown(),
  surfaces: { mcp: { toolName: 'demo_destroy', servers: ['external'] } },
  invoke: async () => ({ ok: true }),
});

/** The agent asking, with no ceiling of its own. */
const IDENTITY = {
  agentPath: '/projects/prober',
  displayName: 'Prober',
  tierCeiling: 'destructive' as const,
  createdAt: new Date().toISOString(),
};

describe('no permission mode switches off the destructive gate', () => {
  beforeEach(() => {
    const db = createTestDb();
    const grants = new ApprovalGrantService(db);
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    // Wired exactly as boot wires it, standing permissions included, so nothing
    // here passes because the feature was switched off for the test.
    initCapabilityTierGate({
      approvals: new ApprovalService(db),
      standingGrants: {
        enabled: () => true,
        findLive: (agentPath, capabilityId) => grants.findLive(agentPath, capabilityId),
      },
    });
  });

  afterEach(() => {
    resetCapabilityTierGate();
    vi.restoreAllMocks();
  });

  // A matrix over the schema itself rather than a hand-copied list, so a seventh
  // mode added tomorrow is covered the day it is added.
  for (const mode of PermissionModeSchema.options) {
    it(`asks a person under permissionMode "${mode}"`, () => {
      // The mode is passed the only way it CAN be passed — as an extra property the
      // request type does not declare — because the whole point is that there is no
      // field for it. If somebody adds one, this cast stops compiling and the author
      // has to come here and explain themselves.
      const decision = enforceCapabilityTier({
        permission: null,
        action: DESTROY,
        input: { name: 'production' },
        identity: IDENTITY,
        retryChannel: 'mcp-argument',
        permissionMode: mode,
      } as unknown as Parameters<typeof enforceCapabilityTier>[0]);

      expect(decision.outcome).toBe('approval_required');
    });
  }
});

/** The two directories the structural guard covers, relative to `apps/server/src`. */
const FIREWALLED_DIRS = ['services/core/capabilities', 'services/core/approvals'];

/** `apps/server/src`, resolved from this file rather than from the cwd. */
const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Every `.ts` file under `dir`, excluding tests and declaration files.
 *
 * @param dir - Absolute directory to walk.
 * @returns Absolute paths of the production sources found.
 */
async function productionSources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...(await productionSources(full)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('the gate does not know what a permission mode is', () => {
  it('never mentions permissionMode anywhere it decides an approval', async () => {
    const offenders: string[] = [];
    for (const dir of FIREWALLED_DIRS) {
      for (const file of await productionSources(path.join(SERVER_SRC, dir))) {
        // Prose is allowed and is in fact wanted: several modules here explain WHY
        // permission mode stays out. Only code counts.
        //
        // Told apart by the repo's shared stripper, which lexes with TypeScript's
        // own parser (`scripts/lib/code-only.mjs`). This used to be a block-comment
        // regex followed by a line filter, which is one of the three orders DOR-642
        // proved cannot work: a `/*` inside a line comment or a string opens a fake
        // span, and everything it swallows stops being scanned. That left no live
        // hole in these two directories, but a guard whose blind spot depends on
        // which route glob somebody writes next is not a guard.
        const code = codeOnly(await readFile(file, 'utf-8'), file);
        if (code.includes('permissionMode')) {
          offenders.push(path.relative(SERVER_SRC, file));
        }
      }
    }

    expect(
      offenders,
      'A module that decides approvals started reading permission mode. That is an ' +
        'ungated path for an agent to switch off its own destructive gate: an agent ' +
        'can already set bypassPermissions on a scheduled task through tasks_update, ' +
        'which is act tier and needs no approval. The supported way to stop being asked is a standing ' +
        'permission, which needs a signed-in person and a clock.'
    ).toEqual([]);
  });
});
