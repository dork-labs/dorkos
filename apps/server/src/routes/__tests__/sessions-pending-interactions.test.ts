/**
 * `GET /api/sessions/pending-interactions`, and who may answer what it lists.
 *
 * Two things are under test here and neither is reachable below the route:
 *
 * - the LIST — one envelope per parked prompt, `roomId` only where a room owns
 *   the session, and `remainingMs` recomputed at read rather than frozen at
 *   emit; and that it resolves ahead of `GET /:id`, which Express 5 would
 *   otherwise match `pending-interactions` against as a session id;
 * - the ANSWER GUARD — six routes × three callers, the whole security surface
 *   of `requirePersonToAnswer`. Broadcasting the Ask to every route made these
 *   endpoints reachable from everywhere, and DOR-609's lesson is that _who
 *   acted_ is not _who may_.
 *
 * The thirty authority cases are written out rather than reduced to one loop
 * over a table with one assertion in it, because each row is a different
 * sentence about the same rule and a reader has to be able to see which one
 * broke: five callers × six routes.
 *
 * **The mount is the router behind stand-ins for the two middlewares that sit in
 * front of it**, not `createApp()`. `sessionGate` and the agent-identity
 * resolver both write onto `res.locals`, and a case has to present exactly one
 * credential — a real gate under login-on refuses every request before the
 * route is reached, which would make the interesting rows unreachable. The raw
 * `X-DorkOS-Agent` header is NOT stubbed: `readCallerAuthority` reads it
 * directly, which is the whole point of the unresolved-token row.
 *
 * Seeded defects, each run and each red before the fix:
 *
 * - Remove `requirePersonToAnswer` from any one route → both refusal rows for
 *   that route answer 200.
 * - Register the list route after `/:id` → the request 404s as a session id.
 * - Freeze `remainingMs` at emit (return the tracked value instead of asking
 *   the selector) → "recomputed at read time" goes red.
 * - Drop the `answeredBy` argument from any one of the six calls → that route's
 *   two naming rows go red.
 * - Return a constant from `answeredBy` instead of reading what this install
 *   knows → all six "names nobody" rows go red and all six named rows stay
 *   green, which is the pair that tells a resolved name from an invented one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';

let fakeRuntime: FakeAgentRuntime;
/** Whether the install has local login turned on, per case. */
let loginEnabled = false;

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    resolveForSession: vi.fn(async () => fakeRuntime),
    getSessionRuntimeType: vi.fn(async () => 'fake'),
    persistSessionRuntime: vi.fn(async () => {}),
    has: vi.fn(() => true),
    listRuntimes: vi.fn(() => [fakeRuntime]),
  },
  RuntimeNotRegisteredError: class RuntimeNotRegisteredError extends Error {},
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

/** What this install has been told to call the person, per case. */
let profileDisplayName: string | null = null;

// `requireOperatorCookieUnderLogin` reads `auth.enabled` from here, which is the
// only thing that decides whether a per-user API key is refused; `answeredBy`
// reads `profile.displayName`, which is what the receipt prints.
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) => {
      if (key === 'auth') return { enabled: loginEnabled };
      if (key === 'profile') return { displayName: profileDisplayName };
      return null;
    }),
    set: vi.fn(),
  },
}));

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {},
}));

import express from 'express';
import request from 'supertest';
import sessionRoutes from '../sessions.js';
import {
  disposeProjector,
  getOrCreateProjector,
  type RawSessionEvent,
} from '../../services/session/index.js';
import type { RequestUser } from '../../services/core/auth/session-gate.js';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_SESSION_ID = '00000000-0000-4000-8000-000000000002';
const TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Mount the REAL router behind the middleware the app puts in front of it.
 *
 * `sessionGate` attaches the resolved user to `res.locals.user` and the agent
 * middleware resolves an `X-DorkOS-Agent` token; both are stood in for here so a
 * case can present exactly one credential. The header itself is NOT stubbed —
 * `readCallerAuthority` reads the raw header, and a token that resolves to
 * nothing still means a machine is calling.
 *
 * @param options - The room bindings the list route joins against, and the
 *   signed-in identity, when a case has one.
 */
function buildApp(
  options: {
    user?: RequestUser;
    bindings?: Record<string, { roomId: string; authorId: string }>;
  } = {}
): express.Express {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    if (options.user) res.locals.user = options.user;
    next();
  });
  if (options.bindings) {
    app.locals.roomSessionBindings = {
      bindingForSession: (sessionId: string) => {
        const binding = options.bindings?.[sessionId];
        return binding ? { ...binding, sessionId } : undefined;
      },
    };
  }
  app.use('/api/sessions', sessionRoutes);
  return app;
}

/** Park a session on a permission prompt, as a runtime does. */
function park(sessionId: string, cwd: string, id: string, startedAt = Date.now()): void {
  getOrCreateProjector(sessionId, cwd).ingest({
    type: 'approval_required',
    id,
    startedAt,
    remainingMs: TIMEOUT_MS,
    timeoutMs: TIMEOUT_MS,
    toolName: 'Bash',
    input: JSON.stringify({ command: 'pnpm verify' }),
    hasSuggestions: false,
  } as unknown as RawSessionEvent);
}

beforeEach(() => {
  fakeRuntime = new FakeAgentRuntime();
  loginEnabled = false;
  profileDisplayName = null;
  vi.clearAllMocks();
  disposeProjector(SESSION_ID);
  disposeProjector(OTHER_SESSION_ID);
});

describe('GET /api/sessions/pending-interactions', () => {
  it('answers one envelope per parked session', async () => {
    park(SESSION_ID, '/work/alpha', 'tc-1');
    park(OTHER_SESSION_ID, '/work/beta', 'tc-2');

    const res = await request(buildApp()).get('/api/sessions/pending-interactions');

    expect(res.status).toBe(200);
    expect(res.body.interactions).toHaveLength(2);
    expect(res.body.interactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: SESSION_ID,
          cwd: '/work/alpha',
          interaction: expect.objectContaining({ id: 'tc-1', type: 'approval' }),
        }),
      ])
    );
  });

  it('names the room only for a session a room owns', async () => {
    park(SESSION_ID, '/work/alpha', 'tc-1');
    park(OTHER_SESSION_ID, '/work/beta', 'tc-2');
    const app = buildApp({
      bindings: { [SESSION_ID]: { roomId: 'room-7', authorId: 'author-ana' } },
    });

    const res = await request(app).get('/api/sessions/pending-interactions');

    const byId = Object.fromEntries(
      res.body.interactions.map((row: { sessionId: string }) => [row.sessionId, row])
    );
    expect(byId[SESSION_ID]).toMatchObject({ roomId: 'room-7', roomAuthorId: 'author-ana' });
    expect(byId[OTHER_SESSION_ID]).not.toHaveProperty('roomId');
  });

  it('recomputes the time left at read, rather than repeating what was emitted', async () => {
    // The prompt declared ten minutes and has been waiting four. A frozen
    // `remainingMs` would still say ten, and every card in the fleet would draw
    // a full bar over an ask with six minutes to live.
    park(SESSION_ID, '/work/alpha', 'tc-1', Date.now() - 4 * 60_000);

    const res = await request(buildApp()).get('/api/sessions/pending-interactions');

    const [row] = res.body.interactions;
    expect(row.interaction.remainingMs).toBeLessThanOrEqual(6 * 60_000);
    expect(row.interaction.remainingMs).toBeGreaterThan(6 * 60_000 - 5_000);
  });

  it('leaves out a prompt whose own clock has already run out', async () => {
    park(SESSION_ID, '/work/alpha', 'tc-stale', Date.now() - TIMEOUT_MS - 1_000);

    const res = await request(buildApp()).get('/api/sessions/pending-interactions');

    expect(res.body.interactions).toEqual([]);
  });

  it('resolves ahead of GET /:id, rather than as a session called "pending-interactions"', async () => {
    // The one ordering trap in the route file: Express 5 matches in
    // registration order, and `/:id` would swallow this path. A 400 for an
    // invalid session id is what the failure looks like.
    const res = await request(buildApp()).get('/api/sessions/pending-interactions');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('interactions');
  });
});

describe('who may answer a prompt', () => {
  /**
   * The six ways to answer, each with a body its route accepts and how many
   * prompts that body answers — two for the batch routes, one for the rest.
   */
  const ANSWER_ROUTES = [
    { name: 'approve', path: 'approve', body: { toolCallId: 'tc-1' }, answers: 1 },
    { name: 'deny', path: 'deny', body: { toolCallId: 'tc-1' }, answers: 1 },
    {
      name: 'batch-approve',
      path: 'batch-approve',
      body: { toolCallIds: ['tc-1', 'tc-2'] },
      answers: 2,
    },
    {
      name: 'batch-deny',
      path: 'batch-deny',
      body: { toolCallIds: ['tc-1', 'tc-2'] },
      answers: 2,
    },
    {
      name: 'submit-answers',
      path: 'submit-answers',
      body: { toolCallId: 'tc-1', answers: { '0': 'Blue' } },
      answers: 1,
    },
    {
      name: 'submit-elicitation',
      path: 'submit-elicitation',
      body: { interactionId: 'tc-1', action: 'accept' },
      answers: 1,
    },
  ] as const;

  beforeEach(() => {
    fakeRuntime.approveTool.mockReturnValue(true);
    fakeRuntime.submitAnswers.mockReturnValue(true);
    fakeRuntime.submitElicitation.mockReturnValue(true);
  });

  /**
   * The options object each call to the runtime carried, one per answered
   * prompt — two of them for the batch routes, which answer a stack at once.
   *
   * Reads the spy the route actually reached rather than assuming which one, so
   * a route wired to the wrong runtime method fails here instead of quietly
   * asserting nothing.
   *
   * @param name - Which of the six routes the case drove.
   */
  function answerArgs(name: (typeof ANSWER_ROUTES)[number]['name']): unknown[] {
    if (name === 'submit-answers') {
      return fakeRuntime.submitAnswers.mock.calls.map((call) => call.at(3));
    }
    if (name === 'submit-elicitation') {
      return fakeRuntime.submitElicitation.mock.calls.map((call) => call.at(4));
    }
    return fakeRuntime.approveTool.mock.calls.map((call) => call.at(3));
  }

  for (const route of ANSWER_ROUTES) {
    describe(`POST /api/sessions/:id/${route.path}`, () => {
      it('lets a person in the cockpit answer', async () => {
        const res = await request(buildApp())
          .post(`/api/sessions/${SESSION_ID}/${route.path}`)
          .send(route.body);

        expect(res.status).toBe(200);
      });

      it('refuses a caller presenting an agent identity, for a prompt it did not raise', async () => {
        // The requester-never-self-approves rule, made structural: the path is
        // not reachable by anything calling itself an agent, so there is no id
        // to compare and none to spoof. The token here resolves to no agent at
        // all — a revoked or expired one still means a machine is calling.
        const res = await request(buildApp())
          .post(`/api/sessions/${SESSION_ID}/${route.path}`)
          .set('X-DorkOS-Agent', 'a-token-that-resolves-to-nothing')
          .send(route.body);

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('AGENT_CANNOT_DECIDE');
        expect(fakeRuntime.approveTool).not.toHaveBeenCalled();
        expect(fakeRuntime.submitAnswers).not.toHaveBeenCalled();
        expect(fakeRuntime.submitElicitation).not.toHaveBeenCalled();
      });

      it('refuses whoever is holding the approval token, because that is the requester', async () => {
        // The other half of "the requester never answers": an approval token is
        // the retry secret, and only the caller that ASKED holds one.
        const res = await request(buildApp())
          .post(`/api/sessions/${SESSION_ID}/${route.path}`)
          .set('X-DorkOS-Approval', 'a-retry-secret')
          .send(route.body);

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('REQUESTER_CANNOT_DECIDE');
      });

      it('answers 401 under login-on when nothing proved who is calling', async () => {
        // `sessionGate` normally refuses this before the route sees it; the
        // route checks again so the guarantee belongs to the endpoint rather
        // than to the middleware order.
        loginEnabled = true;
        const res = await request(buildApp())
          .post(`/api/sessions/${SESSION_ID}/${route.path}`)
          .send(route.body);

        expect(res.status).toBe(401);
        expect(res.body.code).toBe('AUTH_REQUIRED');
      });

      it('refuses a per-user API key while login is on', async () => {
        // An agent legitimately holds one of the person's keys — it is how a
        // Codex or OpenCode agent reaches the operator surface at all — so a
        // credential that is not a browser session cannot answer for them.
        loginEnabled = true;
        const app = buildApp({ user: { userId: 'user_program', credential: 'api-key' } });

        const res = await request(app)
          .post(`/api/sessions/${SESSION_ID}/${route.path}`)
          .send(route.body);

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('operator_cookie_required');
        expect(res.body.error).toContain('Open DorkOS and answer it there.');
      });

      it('lets a signed-in person with a session cookie answer while login is on', async () => {
        loginEnabled = true;
        const app = buildApp({ user: { userId: 'user_owner', credential: 'cookie' } });

        const res = await request(app)
          .post(`/api/sessions/${SESSION_ID}/${route.path}`)
          .send(route.body);

        expect(res.status).toBe(200);
      });

      it('hands the runtime the name to put on the receipt', async () => {
        // DOR-1355. The name is resolved HERE, from what this install knows
        // about the person, and never taken off the request — a caller that
        // could name itself could sign somebody else's decision. Everything
        // downstream only relays it, so this call is where it becomes true.
        profileDisplayName = 'Ada';

        const res = await request(buildApp())
          .post(`/api/sessions/${SESSION_ID}/${route.path}`)
          .send(route.body);

        expect(res.status).toBe(200);
        const args = answerArgs(route.name);
        expect(args).toHaveLength(route.answers);
        for (const arg of args) expect(arg).toMatchObject({ answeredBy: 'Ada' });
      });

      it('names nobody when this install has never been told a name', async () => {
        // The receipt then reads "Already answered at 2:01", which stays true.
        // A placeholder here would print "Already answered by You" in a window
        // that was not the one that answered.
        const res = await request(buildApp())
          .post(`/api/sessions/${SESSION_ID}/${route.path}`)
          .send(route.body);

        expect(res.status).toBe(200);
        const args = answerArgs(route.name);
        expect(args).toHaveLength(route.answers);
        for (const arg of args) expect(arg).not.toHaveProperty('answeredBy');
      });
    });
  }
});
