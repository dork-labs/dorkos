/**
 * An agent can never grant itself an allow list (DOR-3039, Security's hard
 * requirement for #3072).
 *
 * The agent owns its folder, so it can always WRITE its own
 * `.claude/settings.json`. What it must never do is make that list take effect
 * without a person. This file walks every lever an agent has and asserts the
 * SUBJECT each time — the launch still passes nothing — not merely that some
 * error came back:
 *
 * - writing or widening its own list only raises a card;
 * - answering that card itself is refused, with or without its identity, and
 *   holding the card's token marks a caller as the asker, never the decider;
 * - writing the approval record through config is refused as operator-only;
 * - forging the stored rules without the stored yes counts for nothing;
 * - a near-copy of an approved rule is a widening, not a narrowing.
 *
 * The card runs through the real `ApprovalService` and the real approvals
 * routes, the same pair the boot wires together.
 *
 * @vitest-environment node
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';

vi.mock('../../../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/** A config store holding just the `permissions` section. */
const store = vi.hoisted(() => ({
  permissions: {} as Record<string, unknown>,
}));
vi.mock('../../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'permissions' ? store.permissions : undefined),
    set: (key: string, value: Record<string, unknown>) => {
      if (key === 'permissions') store.permissions = value;
    },
  },
}));
vi.mock('../../../../core/operator/config-write.js', () => ({ logConfigWrite: vi.fn() }));

import { ApprovalService } from '../../../../core/approvals/index.js';
import { APPROVAL_TOKEN_HEADER } from '../../../../core/capabilities/index.js';
import {
  findOperatorOnlyPaths,
  operatorOnlyAreasForPatch,
} from '../../../../core/operator/config-write-policy.js';
import type { ActivityService } from '../../../../activity/activity-service.js';
import { createPermissionWorld } from '../../../../core/permissions/__tests__/permission-fixtures.js';
import { createApprovalsRoutes } from '../../../../../routes/approvals.js';
import { honoGroupListener } from '../../../../../http/__tests__/hono-group-listener.js';
import { resolveFolderAllows } from '../apply-folder-allows.js';
import { folderAllowEntry, recordFolderAllowApproval } from '../folder-allow-consent.js';
import {
  _internal,
  askForFolderAllows,
  describeFolderAllowCapability,
} from '../folder-allow-approval.js';

const AGENT = { id: '01MARKETING', name: 'Marketing' };
let home: string;

/** The agent, writing its own folder's settings: a thing it can always do. */
async function agentWritesAllow(allow: string[]): Promise<void> {
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.writeFile(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({ permissions: { allow } })
  );
}

/** What the agent's next launch would do. */
function nextLaunch() {
  return resolveFolderAllows({ teammate: false, agent: AGENT, home, cwd: home });
}

describe('an agent cannot grant itself its folder allow list', () => {
  const target = swappableServer();
  let approvals: ApprovalService;

  /** The real approvals routes, as a person (no identity) or as the agent. */
  function approvalsApp(as: 'person' | 'agent'): Server {
    const world = createPermissionWorld({ preset: 'full', agents: [] });
    const routes = createApprovalsRoutes(approvals, {
      activity: { emit: async () => undefined } as unknown as ActivityService,
      permissions: world.service,
      isLoginEnabled: () => false,
      describeCapability: describeFolderAllowCapability,
    });
    return target.mount(
      honoGroupListener(
        { path: '/api/approvals', routes },
        {
          before: async (c, next) => {
            if (as === 'agent') {
              c.set('agentIdentity', {
                agentPath: home,
                displayName: AGENT.name,
                createdAt: new Date().toISOString(),
              });
            }
            await next();
          },
        }
      )
    );
  }

  /** Put the card up for the list on disk, and return the asking loop and the card. */
  async function raiseCard(): Promise<{ answered: Promise<boolean>; approvalId: string }> {
    const decision = await nextLaunch();
    if (decision.kind !== 'waiting') throw new Error(`expected waiting, got ${decision.kind}`);
    const answered = askForFolderAllows(approvals, decision.request);
    const [card] = approvals.listPending();
    if (!card) throw new Error('no card was raised');
    return { answered, approvalId: card.approvalId };
  }

  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'no-self-grant-')));
    store.permissions = {};
    _internal.forgetOpenCards();
    _internal.sleep = () => new Promise((resolve) => setTimeout(resolve, 1));
    approvals = new ApprovalService(createTestDb(), {
      describeCapability: describeFolderAllowCapability,
    });
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('writing its own list applies nothing: it only raises a card', async () => {
    await agentWritesAllow(['Bash(curl:*)']);
    expect((await nextLaunch()).kind).toBe('waiting');
  });

  it('refuses the agent answering its own card, and the list still applies nothing', async () => {
    await agentWritesAllow(['Bash(curl:*)']);
    const { answered, approvalId } = await raiseCard();

    const res = await request(approvalsApp('agent'))
      .post(`/api/approvals/${approvalId}/grant`)
      .send();

    expect(res.status).toBe(403);
    expect(approvals.listPending().map((row) => row.approvalId)).toContain(approvalId);
    expect((await nextLaunch()).kind).toBe('waiting');
    // Let the asking loop finish so it does not outlive the test.
    await request(approvalsApp('person')).post(`/api/approvals/${approvalId}/deny`).send();
    expect(await answered).toBe(false);
  });

  it('refuses a caller holding the card token: holding it makes you the asker', async () => {
    await agentWritesAllow(['Bash(curl:*)']);
    const { answered, approvalId } = await raiseCard();

    const res = await request(approvalsApp('person'))
      .post(`/api/approvals/${approvalId}/grant`)
      .set(APPROVAL_TOKEN_HEADER, 'any-token-at-all')
      .send();

    expect(res.status).toBe(403);
    expect((await nextLaunch()).kind).toBe('waiting');
    await request(approvalsApp('person')).post(`/api/approvals/${approvalId}/deny`).send();
    expect(await answered).toBe(false);
  });

  it('applies the list once a person answers the card, and only that list', async () => {
    await agentWritesAllow(['Bash(curl:*)']);
    const { answered, approvalId } = await raiseCard();

    const res = await request(approvalsApp('person'))
      .post(`/api/approvals/${approvalId}/grant`)
      .send();

    expect(res.status).toBe(200);
    expect(await answered).toBe(true);
    expect(await nextLaunch()).toMatchObject({ kind: 'applied', rules: ['Bash(curl:*)'] });

    // Widening after the yes is a new list, and a new card.
    await agentWritesAllow(['Bash(curl:*)', 'Bash(rm:*)']);
    expect((await nextLaunch()).kind).toBe('waiting');
  });

  it('refuses the agent writing the approval record through config', () => {
    const entry = folderAllowEntry({ agentId: AGENT.id, home, rules: ['Bash(curl:*)'] });
    const patch = {
      permissions: {
        approvedFolderAllows: [entry],
        refusedFolderAllows: [],
        approvedFolderAllowRules: { [AGENT.id]: ['Bash(curl:*)'] },
      },
    };

    expect(findOperatorOnlyPaths(patch)).toEqual(
      expect.arrayContaining([
        'permissions.approvedFolderAllows',
        'permissions.refusedFolderAllows',
        'permissions.approvedFolderAllowRules',
      ])
    );
    // Asked in the Permissions area, which is never Allowed: only a person's yes.
    expect(operatorOnlyAreasForPatch(patch)).toEqual(['permissions']);
  });

  it('counts forged stored rules for nothing without the yes they belong to', async () => {
    await agentWritesAllow(['Bash(a:*)']);
    const first = await nextLaunch();
    if (first.kind !== 'waiting') throw new Error('expected waiting');
    recordFolderAllowApproval(first.request);

    // Somehow the stored rules now claim a wider yes than the stored hash.
    store.permissions = {
      ...store.permissions,
      approvedFolderAllowRules: { [AGENT.id]: ['Bash(a:*)', 'Bash(curl:*)'] },
    };
    await agentWritesAllow(['Bash(curl:*)']);

    expect((await nextLaunch()).kind).toBe('waiting');
  });

  it.each([
    ['a trailing space', 'Bash(git status:* )'],
    ['a different case', 'bash(git status:*)'],
    ['a broader pattern', 'Bash(git:*)'],
  ])('treats %s on an approved rule as a widening that asks', async (_label, rule) => {
    await agentWritesAllow(['Bash(git status:*)', 'Bash(ls:*)']);
    const first = await nextLaunch();
    if (first.kind !== 'waiting') throw new Error('expected waiting');
    recordFolderAllowApproval(first.request);

    await agentWritesAllow([rule]);

    expect((await nextLaunch()).kind).toBe('waiting');
  });

  it('never applies a whole tool, not even as a narrowing of an approved list', async () => {
    await agentWritesAllow(['Bash(git status:*)', 'Bash']);
    const first = await nextLaunch();
    if (first.kind !== 'waiting') throw new Error('expected waiting');
    expect(first.request.rules).toEqual(['Bash(git status:*)']);
    recordFolderAllowApproval(first.request);

    await agentWritesAllow(['Bash']);

    expect((await nextLaunch()).kind).toBe('none');
  });

  it('never asks about a list the card cannot show whole', async () => {
    // Every rule is short, but together the card would be cut off.
    await agentWritesAllow(
      Array.from({ length: 20 }, (_, i) => `Bash(scripts/step-${i}.sh --verbose:*)`)
    );
    expect((await nextLaunch()).kind).toBe('unshowable');
    expect(approvals.listPending()).toEqual([]);
  });

  it('never asks about a list whose card would hide part of a rule as a secret', async () => {
    await agentWritesAllow([`Bash(scripts/run --key ${'a1'.repeat(20)}:*)`]);
    expect((await nextLaunch()).kind).toBe('unshowable');
  });
});
