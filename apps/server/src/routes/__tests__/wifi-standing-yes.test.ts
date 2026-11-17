/**
 * From Wi-Fi an approval may only be denied (DOR-3648; earlier DOR-2969
 * part 3): a tool prompt's always-allow and an extension's "next time, on its
 * own" are refused with `NOT_FROM_WIFI`, while a denial still lands. The capability approvals' `answer: 'always'` is covered beside the
 * other Wi-Fi approval cases in `capabilities-invoke.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';

let fakeRuntime: FakeAgentRuntime;
const inbox = vi.hoisted(() => ({
  answerOffer: vi.fn(async () => ({ ok: true as const, message: 'Done.' })),
}));

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: { resolveForSession: vi.fn(async () => fakeRuntime) },
}));
vi.mock('../../services/extensions/inbox/extension-inbox.js', () => ({
  getExtensionInbox: () => inbox,
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(() => undefined), set: vi.fn() },
}));
vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));

import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { markIngress, type IngressKind } from '../../services/core/remote/ingress-mark.js';
import { NOT_FROM_WIFI } from '../../services/core/auth/sessions/wifi-level.js';
import {
  getOrCreateProjector,
  disposeProjector,
} from '../../services/session/session-state-projector.js';
import { resetHeldStepUpsForTests } from '../../services/core/auth/step-up/step-up-holds.js';
import { createSessionAnswerRoutes } from '../session-answers.js';
import { createExtensionDecisionsRoutes } from '../extension-decisions.js';
import { setTestOwner } from './test-owner.js';

const target = swappableServer();
const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const DECISION_ID = '01KXQ3P7ADJY9DSXMZW1XGWCV4';

/** Both routes, reached through `via` by a signed-in person. */
function app(via: IngressKind | 'direct') {
  return target.mount(
    honoGroupListener(
      [
        { path: '/api/sessions', routes: createSessionAnswerRoutes() },
        { path: '/api/extension-decisions', routes: createExtensionDecisionsRoutes() },
      ],
      {
        before: async (c, next) => {
          if (via !== 'direct') markIngress(c.env.incoming, via);
          c.set('user', { userId: 'owner', credential: 'cookie', sessionId: 'browser' });
          await next();
        },
      }
    )
  );
}

beforeEach(() => {
  fakeRuntime = new FakeAgentRuntime();
  fakeRuntime.approveTool.mockReturnValue(true);
  inbox.answerOffer.mockClear();
});

describe('a tool prompt in a chat', () => {
  it('refuses always-allow from Wi-Fi, and runs nothing', async () => {
    const res = await request(app('wifi'))
      .post(`/api/sessions/${SESSION_ID}/approve`)
      .send({ toolCallId: 'tc-1', alwaysAllow: true });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'Answer at your computer or over Remote Access.',
      code: NOT_FROM_WIFI,
    });
    expect(fakeRuntime.approveTool).not.toHaveBeenCalled();
  });

  it('refuses Allow once with guidance but accepts Deny from Wi-Fi', async () => {
    const once = await request(app('wifi'))
      .post(`/api/sessions/${SESSION_ID}/approve`)
      .send({ toolCallId: 'tc-1' });
    expect(once.status).toBe(403);
    expect(once.body).toMatchObject({
      code: NOT_FROM_WIFI,
      error: 'Answer at your computer or over Remote Access.',
    });
    expect(once.body.heldActionId).toBeUndefined();
    expect(fakeRuntime.approveTool).not.toHaveBeenCalled();
    const deny = await request(app('wifi'))
      .post(`/api/sessions/${SESSION_ID}/deny`)
      .send({ toolCallId: 'tc-2' });
    expect(deny.status).toBe(200);
  });

  it('holds always-allow at this computer before the runtime hears it', async () => {
    resetHeldStepUpsForTests();
    setTestOwner('owner');
    getOrCreateProjector(SESSION_ID, '/made-up').ingest({
      type: 'approval_required',
      id: 'tc-1',
      toolName: 'Bash',
      input: '{}',
      startedAt: Date.now(),
      remainingMs: 600000,
      hasSuggestions: true,
    });
    const res = await request(app('direct'))
      .post(`/api/sessions/${SESSION_ID}/approve`)
      .send({ toolCallId: 'tc-1', alwaysAllow: true });
    expect(res.status).toBe(428);
    expect(fakeRuntime.approveTool).not.toHaveBeenCalled();
    setTestOwner(null);
    disposeProjector(SESSION_ID);
    resetHeldStepUpsForTests();
  });
});

describe("an extension's next-time offer", () => {
  it('refuses yes from Wi-Fi, and takes no', async () => {
    const yes = await request(app('wifi'))
      .post(`/api/extension-decisions/${DECISION_ID}/offer`)
      .send({ accept: true });
    expect(yes.status).toBe(403);
    expect(yes.body.code).toBe(NOT_FROM_WIFI);
    expect(inbox.answerOffer).not.toHaveBeenCalled();
    const no = await request(app('wifi'))
      .post(`/api/extension-decisions/${DECISION_ID}/offer`)
      .send({ accept: false });
    expect(no.status).toBe(200);
  });

  it('takes yes at this computer', async () => {
    const yes = await request(app('direct'))
      .post(`/api/extension-decisions/${DECISION_ID}/offer`)
      .send({ accept: true });
    expect(yes.status).toBe(200);
  });
});
