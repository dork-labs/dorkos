/**
 * A standing permission must not survive the master switch being switched OFF and
 * back ON out of process (DOR-520).
 *
 * ## The round trip this file exists for
 *
 * `dorkos config set approvals.standingGrants false` and `dorkos config reset`
 * write `~/.dork/config.json` through a manager of their own, in a different
 * process. Neither reaches `PATCH /api/config`, so
 * `revokeStandingGrantsIfPostureNarrowed` never fires. Two things already narrow
 * that, and this file only tests what neither of them covers:
 *
 * - the gate reads the switch fresh on every gated call, so nothing is honored
 *   WHILE the switch is off. The window is only the off-then-on round trip.
 * - boot re-establishes the invariant, so the round trip cannot survive a restart.
 *
 * What is left is the round trip inside one server lifetime with NO gated call in
 * between: the rows are still live, nothing swept them, and switching the master
 * switch back on used to wake them up. Every test here runs exactly that shape —
 * a real config file, a real store, the real gate, and no gated call between the
 * two writes.
 *
 * The out-of-process writer is a SECOND `ConfigManager` over the same directory,
 * which is precisely what the CLI holds: `handleConfigSet` calls
 * `store.setDot(...)` and `handleConfigReset` calls `store.reset()` on one of
 * these (`packages/cli/src/config-commands.ts`). Re-running `initConfigManager`
 * instead would replace the singleton and read like a restart, which is the one
 * thing these tests must not simulate.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';

import { ConfigManager, configManager, initConfigManager } from '../../config-manager.js';
import { ApprovalGrantService } from '../approval-grant-service.js';
import { ApprovalService } from '../approval-service.js';
import { readStandingGrantSettings } from '../standing-grant-settings.js';
import { eventFanOut } from '../../event-fan-out.js';
import { defineCapability } from '../../capabilities/capability-definition.js';
import {
  enforceCapabilityTier,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  type TierEnforcementDecision,
} from '../../capabilities/tier-enforcement.js';
import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';

/** The agent the permission is keyed on. */
const AGENT_PATH = '/projects/prober';

/** The one destructive action every test here runs. */
const ACTION = defineCapability({
  id: 'demo.destructive',
  title: 'Demo destructive',
  description: 'A destructive capability used by the out-of-process posture tests.',
  tier: 'destructive',
  input: z.object({ name: z.string() }),
  output: z.unknown(),
  approvalDisplayFields: ['name'],
  surfaces: { mcp: { toolName: 'demo_destructive', servers: ['external'] } },
  invoke: async () => ({ ok: true }),
});

const INPUT = { name: 'sentry-monitor' };

const IDENTITY: AgentIdentity = {
  agentPath: AGENT_PATH,
  displayName: 'Prober',
  tierCeiling: 'destructive',
  createdAt: new Date().toISOString(),
};

describe('a standing permission and an out-of-process settings round trip', () => {
  let tmpDir: string;
  let db: Db;
  let grants: ApprovalGrantService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-grant-oop-'));
    initConfigManager(tmpDir);
    db = createTestDb();
    grants = new ApprovalGrantService(db);
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    // Exactly the wiring `index.ts` performs at boot: both halves read fresh on
    // every gated call, and nothing else sits between the gate and the store.
    initCapabilityTierGate({
      approvals: new ApprovalService(db),
      standingGrants: {
        enabled: () => readStandingGrantSettings().enabled,
        findLive: (agentPath, capabilityId) => grants.findLive(agentPath, capabilityId),
      },
    });
    // The posture a person has to be in before a permission can exist at all.
    configManager.setDot('auth.enabled', true);
    configManager.setDot('approvals.standingGrants', true);
    configManager.setDot('approvals.trustWindowMinutes', 480);
  });

  afterEach(() => {
    resetCapabilityTierGate();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** The CLI's own manager: a different object over the same config file. */
  function cli(): ConfigManager {
    return new ConfigManager(tmpDir);
  }

  /** Open a standing permission for the one action, straight through the store. */
  function permit(): void {
    grants.create({
      agentPath: AGENT_PATH,
      capabilityId: ACTION.id,
      grantedBy: 'user_owner',
      posture: 'signed-in-operator',
      windowMinutes: 480,
    });
  }

  /** Run the gate for the identified caller. */
  function enforce(): TierEnforcementDecision {
    return enforceCapabilityTier({
      action: ACTION,
      input: INPUT,
      identity: IDENTITY,
      retryChannel: 'mcp-argument',
    });
  }

  it('does not honor a permission after `dorkos config set` switches the master switch off and on', () => {
    permit();
    // Proves the permission really was live, so the assertion below cannot pass
    // for the boring reason that it never worked.
    expect(enforce()).toEqual({
      outcome: 'allowed',
      approval: { via: 'standing-grant', grantId: expect.any(String) },
    });

    // The round trip, out of process, with NO gated call between the two writes.
    // This is `dorkos config set approvals.standingGrants false` followed by
    // `... true`; both land in `handleConfigSet` → `store.setDot`.
    const shell = cli();
    shell.setDot('approvals.standingGrants', false);
    shell.setDot('approvals.standingGrants', true);

    // The switch is on again and the row is still there. It must not be honored:
    // nobody decided that this permission should come back.
    expect(enforce().outcome).toBe('approval_required');
  });

  it('does not honor a permission after `dorkos config reset` and a re-enable', () => {
    permit();
    expect(enforce().outcome).toBe('allowed');

    // `dorkos config reset` puts every setting back to its default, which turns
    // both halves of the posture off, and then the person switches them on again.
    const shell = cli();
    shell.reset();
    shell.setDot('auth.enabled', true);
    shell.setDot('approvals.standingGrants', true);

    expect(enforce().outcome).toBe('approval_required');
  });

  it('does not honor a permission after login is switched off and on out of process', () => {
    // The login half of the posture, which §3.0 calls the load-bearing one. The
    // gate's own `enabled()` never reads `auth.enabled`, so while login was off
    // this permission stayed honored — only the round trip's aftermath is at
    // stake here, and it is the same aftermath.
    permit();
    expect(enforce().outcome).toBe('allowed');

    const shell = cli();
    shell.setDot('auth.enabled', false);
    shell.setDot('auth.enabled', true);

    expect(enforce().outcome).toBe('approval_required');
  });

  it('still honors a permission when an unrelated setting is written out of process', () => {
    // The floor must only move when the posture actually stops licensing a
    // permission. A fix that stamped it on every write would end permissions
    // whenever anyone changed the log level, which is a different bug wearing the
    // same clothes.
    permit();

    const shell = cli();
    shell.setDot('logging.level', 'debug');

    expect(enforce().outcome).toBe('allowed');
  });

  it('honors a permission granted AFTER the round trip', () => {
    // The floor voids what came before it and nothing after it. Without this, a
    // fix that simply stopped honoring permissions once the switch had ever been
    // off would look identical from the outside — and would quietly break the
    // feature for everyone who ever toggled it.
    permit();

    const shell = cli();
    shell.setDot('approvals.standingGrants', false);
    shell.setDot('approvals.standingGrants', true);
    expect(enforce().outcome).toBe('approval_required');

    // A person decides again, on the far side of the round trip.
    permit();
    expect(enforce().outcome).toBe('allowed');
  });
});
