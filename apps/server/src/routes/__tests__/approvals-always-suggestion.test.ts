/**
 * The gentle suggestion (spec `agent-permissions`, task 4.4), end to end over
 * the real approval service, the real Activity log and the real routes: three
 * one-time Allows in a week for the same agent and action make the FOURTH card
 * suggest Always allow, and "Not now" makes it quiet for good.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { ALWAYS_SUGGESTION_WINDOW_MS, PERMISSION_ANSWERED_EVENT } from '@dorkos/shared/permissions';

import { ApprovalService, hashApprovalInput } from '../../services/core/approvals/index.js';
import { ActivityService } from '../../services/activity/activity-service.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import { AGENT_IDENTITY_HEADER } from '../../middleware/agent-identity.js';
import { createAlwaysSuggestion } from '../../services/core/permissions/always-suggestion.js';
import { createPermissionWorld } from '../../services/core/permissions/__tests__/permission-fixtures.js';
import {
  PermissionService,
  listPermissionHistory,
  personWriter,
} from '../../services/core/permissions/index.js';
import { createApprovalsRouter } from '../approvals.js';

const AGENT_PATH = '/agents/dorkbot';

describe('the Always allow suggestion', () => {
  const target = swappableServer();
  let db: Db;
  let approvals: ApprovalService;
  let activity: ActivityService;
  let app: Server;

  beforeEach(() => {
    db = createTestDb();
    activity = new ActivityService(db);
    approvals = new ApprovalService(db, { suggestAlways: createAlwaysSuggestion(db) });
    const world = createPermissionWorld({
      preset: 'balanced',
      agents: [{ id: 'agent-dorkbot', name: 'dorkbot', projectPath: AGENT_PATH }],
    });
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    const built = express();
    built.use(express.json());
    built.use(
      '/api/approvals',
      createApprovalsRouter(approvals, {
        activity,
        permissions: world.service,
        isLoginEnabled: () => false,
      })
    );
    app = target.mount(built);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Raise one card for the agent. */
  function ask(overrides: { capabilityId?: string; area?: 'rooms' | 'reach'; path?: string } = {}) {
    const hasPath = !('path' in overrides) || overrides.path !== undefined;
    return approvals.request({
      capabilityId: overrides.capabilityId ?? 'rooms.create',
      inputHash: hashApprovalInput({ n: Math.random() }),
      summary: 'DorkBot wants to open a room',
      requestedBy: 'DorkBot',
      ...(hasPath ? { requestedByPath: overrides.path ?? AGENT_PATH } : {}),
      area: overrides.area ?? 'rooms',
    }).approvalId;
  }

  /** Raise a card and answer it through the route. */
  async function answer(kind: 'once' | 'always' | 'deny', capabilityId = 'rooms.create') {
    const id = ask({ capabilityId });
    const res =
      kind === 'deny'
        ? await request(app).post(`/api/approvals/${id}/deny`)
        : await request(app)
            .post(`/api/approvals/${id}/grant`)
            .send(kind === 'always' ? { answer: 'always' } : {});
    expect(res.status).toBe(200);
  }

  it('appears on the fourth card, not the third', async () => {
    await answer('once');
    await answer('once');
    const third = ask();
    expect(approvals.getPending(third)?.suggestAlways).toBeUndefined();
    await request(app).post(`/api/approvals/${third}/grant`).expect(200);

    const fourth = ask();

    expect(approvals.getPending(fourth)?.suggestAlways).toBe(true);
    const listed = await request(app).get('/api/approvals/pending');
    expect(listed.body.approvals[0]).toMatchObject({
      approvalId: fourth,
      suggestAlways: true,
      allowedThisWeek: 3,
    });
  });

  it('goes quiet after "Not now": on that card, and on every card after it', async () => {
    for (let i = 0; i < 3; i++) await answer('once');
    const fourth = ask();

    const res = await request(app).post(`/api/approvals/${fourth}/dismiss-suggestion`);

    expect(res.status).toBe(200);
    expect(approvals.getPending(fourth)?.suggestAlways).toBeUndefined();
    await request(app).post(`/api/approvals/${fourth}/grant`).expect(200);
    expect(approvals.getPending(ask())?.suggestAlways).toBeUndefined();
    // Recorded in the permission history's category, for that agent and action.
    const events = await activity.list({ limit: 50, categories: 'permissions' });
    expect(
      events.items.find((e) => e.eventType === 'permission.suggestion_dismissed')
    ).toMatchObject({
      actorLabel: 'Someone on this computer',
      metadata: { agentPath: AGENT_PATH, action: 'rooms.create', approvalId: fourth },
    });
  });

  it('shows "Not now" in the history, and its Undo brings the suggestion back', async () => {
    for (let i = 0; i < 3; i++) await answer('once');
    const fourth = ask();
    await request(app).post(`/api/approvals/${fourth}/dismiss-suggestion`).expect(200);
    const [dismissal] = (await listPermissionHistory(activity, { limit: 10 })).items;
    expect(dismissal).toMatchObject({ undoable: true, undone: false });
    expect(dismissal!.summary).toMatch(/^Stopped suggesting Always allow/);

    // The same Undo every other history line uses.
    const service = new PermissionService({
      config: {
        get: () => ({
          preset: null,
          defaults: { areas: {}, actions: {} },
          upgradeSweptVersion: null,
        }),
        set: () => {},
        trustStops: () => ({ global: null, perRuntime: {} }),
        setGlobalTrustStop: () => {},
        setRuntimeTrustStop: () => false,
        hasAutonomyAck: () => false,
        recordAutonomyAck: () => {},
      },
      agents: {
        list: () => [],
        readPermissions: async () => undefined,
        writePermissions: async () => {},
      },
      actions: () => [],
      activity,
    });
    const writer = personWriter('local-trust');
    await expect(service.undo(dismissal!.id, {}, writer)).resolves.toEqual({
      changes: [],
      skipped: [],
      suggestionRestored: true,
    });
    expect(approvals.getPending(fourth)?.suggestAlways).toBe(true);
    const history = await listPermissionHistory(activity, { limit: 10 });
    expect(history.items.find((i) => i.id === dismissal!.id)).toMatchObject({ undone: true });
    // Undoing it again finds nothing to do.
    await expect(service.undo(dismissal!.id, {}, writer)).resolves.toEqual({
      changes: [],
      skipped: [],
    });
    // A later "Not now" wins again.
    await request(app).post(`/api/approvals/${fourth}/dismiss-suggestion`).expect(200);
    expect(approvals.getPending(fourth)?.suggestAlways).toBeUndefined();
  });

  it('is only about the same agent and the same action', async () => {
    for (let i = 0; i < 3; i++) await answer('once');
    expect(approvals.getPending(ask({ capabilityId: 'rooms.update' }))?.suggestAlways).toBe(
      undefined
    );
    expect(approvals.getPending(ask({ path: '/agents/other' }))?.suggestAlways).toBeUndefined();
  });

  it('never counts a Deny or an Always allow', async () => {
    await answer('once');
    await answer('once');
    await answer('deny');
    await answer('always');
    expect(approvals.getPending(ask())?.suggestAlways).toBeUndefined();
  });

  it('never appears on a floor-area card, or for a request DorkOS cannot attribute', async () => {
    for (let i = 0; i < 3; i++) await answer('once');
    // Same agent and action recorded in a floor area: Always allow is not offered.
    expect(approvals.getPending(ask({ area: 'reach' }))?.suggestAlways).toBeUndefined();
    expect(approvals.getPending(ask({ path: undefined }))?.suggestAlways).toBeUndefined();
  });

  it('refuses "Not now" from an agent, and on a card that never suggests', async () => {
    for (let i = 0; i < 3; i++) await answer('once');
    const fourth = ask();
    const agent = await request(app)
      .post(`/api/approvals/${fourth}/dismiss-suggestion`)
      .set(AGENT_IDENTITY_HEADER, 'dork_unverifiable');
    expect(agent.status).toBe(403);
    expect(approvals.getPending(fourth)?.suggestAlways).toBe(true);

    const floor = await request(app).post(
      `/api/approvals/${ask({ area: 'reach' })}/dismiss-suggestion`
    );
    expect(floor.status).toBe(409);
    expect(floor.body.code).toBe('SUGGESTION_NOT_OFFERED');
  });
});

describe('createAlwaysSuggestion', () => {
  it('counts only the one-time Allows inside the seven-day window', async () => {
    const db = createTestDb();
    const activity = new ActivityService(db);
    const now = Date.parse('2026-09-24T12:00:00.000Z');
    const at = (msAgo: number) => new Date(now - msAgo).toISOString();
    const answered = (occurredAt: string) =>
      activity.emit({
        occurredAt,
        actorType: 'user',
        actorLabel: 'Someone on this computer',
        category: 'permissions',
        eventType: PERMISSION_ANSWERED_EVENT,
        summary: 'allowed once',
        metadata: { agentPath: AGENT_PATH, action: 'rooms.create', answer: 'once' },
      });
    await answered(at(ALWAYS_SUGGESTION_WINDOW_MS + 60_000));
    await answered(at(60_000));
    await answered(at(120_000));
    const suggest = createAlwaysSuggestion(db, () => now);
    expect(suggest({ agentPath: AGENT_PATH, capabilityId: 'rooms.create' })).toBeNull();

    await answered(at(180_000));
    expect(suggest({ agentPath: AGENT_PATH, capabilityId: 'rooms.create' })).toEqual({
      allowedThisWeek: 3,
    });
  });
});
