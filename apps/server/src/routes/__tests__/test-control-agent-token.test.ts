/**
 * `POST /api/test/agent-token` — the seam that lets a browser test act as an
 * agent, and the check that keeps it from being a forgery seam.
 *
 * The route exists because a real identity token is only ever issued into a
 * spawned session's process env, which Playwright has nothing to read. What
 * makes it safe to exist is that it refuses a path no agent is registered at —
 * and that refusal is this route's own, because nothing underneath it performs
 * one: `AgentIdentityService.mint` stores whatever `agentPath` it is handed,
 * `resolveAgentIdentityFromHeaders` never rejects, and `resolveCaller` then
 * mints an author row for whatever path the token carries. So an unchecked mint
 * would let anything that can reach this port speak as an agent that does not
 * exist.
 *
 * These tests are the pinning for that, and for the tier ceiling — `mint`
 * defaults to `destructive`, the TOP of the ladder, so taking the default here
 * would have handed out a more powerful identity than presenting none.
 *
 * The router is mounted on a bare express app rather than reached through
 * `createApp`, because `app.ts` mounts `/api/test/*` only under
 * `DORKOS_TEST_RUNTIME` — mounting it directly tests the handler rather than
 * the env gate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDb } from '@dorkos/test-utils/db';
import { agentIdentityTokens, type Db } from '@dorkos/db';
import { testControlRouter } from '../test-control.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';

/** A path the stub registry answers for. */
const REGISTERED = '/projects/ana';

/** A path it does not — the forgery this route has to refuse. */
const UNREGISTERED = '/projects/nobody-lives-here';

describe('POST /api/test/agent-token', () => {
  let app: express.Express;
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    initAgentIdentityService(db);
    app = express();
    app.use(express.json());
    // The same shape the two production runtimes consult before they let
    // `resolveAgentTokenEnv` mint anything (`launch-resolver.ts`,
    // `codex-runtime.ts`): a path lookup against the mesh registry.
    // The slug and the display name are DIFFERENT strings, exactly as a real
    // manifest has them: `ana` addresses the agent, `Ana` renders it. A fixture
    // where the two agree could not tell which one the seam minted (DOR-1264).
    app.locals.meshCore = {
      getByPath: (projectPath: string) =>
        projectPath === REGISTERED ? { name: 'ana', displayName: 'Ana' } : undefined,
    };
    app.use('/api/test', testControlRouter);
  });

  afterEach(() => {
    resetAgentIdentityService();
  });

  it('mints a resolvable identity for an agent that is really registered', async () => {
    const res = await request(app).post('/api/test/agent-token').send({ agentPath: REGISTERED });

    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^[0-9a-f]{32}$/);

    // Resolvable, not merely returned: a token the middleware cannot resolve
    // would leave the browser test silently acting as the operator, which is
    // the whole failure this seam exists to prevent.
    const row = db.select().from(agentIdentityTokens).all()[0]!;
    expect(row.agentPath).toBe(REGISTERED);
    // The manifest's name, not one the caller asked for — a caller-supplied
    // name would let a real agent's token carry a label nobody gave it — and
    // the DISPLAY name rather than the slug, because a room attributes every
    // message an agent writes to whatever label its token carries.
    expect(row.displayName).not.toBe('ana');
    expect(row.displayName).toBe('Ana');
    // NOT the `destructive` default. `act` covers the rooms verbs a test drives
    // (`post_to_room`, `react_to_room_entry`) and refuses everything above them.
    expect(row.tierCeiling).toBe('act');
  });

  it('refuses a path no agent is registered at, and mints nothing', async () => {
    const res = await request(app).post('/api/test/agent-token').send({ agentPath: UNREGISTERED });

    expect(res.status).toBe(404);
    // The message names the path, and — unlike the version this replaced —
    // describes a check that actually ran.
    expect(res.body.error).toContain(UNREGISTERED);

    // The half that matters. A 404 with a row behind it would still have
    // created a usable forged identity, because nothing downstream re-checks
    // registration.
    expect(db.select().from(agentIdentityTokens).all()).toHaveLength(0);
  });

  it('refuses a request with no path at all', async () => {
    const res = await request(app).post('/api/test/agent-token').send({});

    expect(res.status).toBe(400);
    expect(db.select().from(agentIdentityTokens).all()).toHaveLength(0);
  });

  it('refuses when the mesh registry is not wired up, rather than minting blind', async () => {
    // A server whose mesh failed to start knows nothing about any agent. The
    // safe reading of "I cannot tell you if this is registered" is no, because
    // the alternative is minting for every path on a degraded boot.
    delete app.locals.meshCore;

    const res = await request(app).post('/api/test/agent-token').send({ agentPath: REGISTERED });

    expect(res.status).toBe(404);
    expect(db.select().from(agentIdentityTokens).all()).toHaveLength(0);
  });
});
