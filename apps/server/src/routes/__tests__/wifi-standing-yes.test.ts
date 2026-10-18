/**
 * From Wi-Fi an answer is Allow once or Deny, never a standing yes (DOR-2969
 * part 3): a tool prompt's always-allow and an extension's "next time, on its
 * own" are refused with `NOT_FROM_WIFI`, while a one-time yes and a no still
 * land. The capability approvals' `answer: 'always'` is covered beside the
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
import {
  NOT_FROM_WIFI,
  WIFI_STANDING_YES_REFUSAL,
} from '../../services/core/auth/sessions/wifi-level.js';
import { createSessionAnswerRoutes } from '../session-answers.js';
import { createExtensionDecisionsRoutes } from '../extension-decisions.js';

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
          c.set('user', { userId: 'owner', credential: 'cookie' });
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
    expect(res.body).toEqual({ error: WIFI_STANDING_YES_REFUSAL, code: NOT_FROM_WIFI });
    expect(fakeRuntime.approveTool).not.toHaveBeenCalled();
  });

  it('takes Allow once and Deny from Wi-Fi', async () => {
    const once = await request(app('wifi'))
      .post(`/api/sessions/${SESSION_ID}/approve`)
      .send({ toolCallId: 'tc-1' });
    expect(once.status).toBe(200);
    const deny = await request(app('wifi'))
      .post(`/api/sessions/${SESSION_ID}/deny`)
      .send({ toolCallId: 'tc-2' });
    expect(deny.status).toBe(200);
  });

  it('takes always-allow at this computer', async () => {
    const res = await request(app('direct'))
      .post(`/api/sessions/${SESSION_ID}/approve`)
      .send({ toolCallId: 'tc-1', alwaysAllow: true });
    expect(res.status).toBe(200);
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
