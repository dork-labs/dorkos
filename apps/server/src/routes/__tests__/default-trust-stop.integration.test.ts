/**
 * Full autonomy as a standing default, from the Settings write to the session it
 * births — the one claim neither half's own tests can make (spec `trust-dial`,
 * decision 6).
 *
 * The halves are tested apart and pass apart: `config.test.ts` proves the config
 * door refuses autonomy without an acknowledgement, and `sessions.test.ts` proves
 * the session door refuses an autonomy mode without one. What only this file
 * asks is whether they COMPOSE — because the design rests on a claim about the
 * pair of them:
 *
 * > set-time is consent-time, and that standing ack satisfies the server's
 * > autonomy requirement for every session the default births.
 *
 * If it did not hold, the feature would look correct in both test files and be
 * unusable in a person's hands: every new session would open bypassed and the
 * first PATCH the cockpit sent — restoring a mode after Plan, say — would bounce
 * off a 428 the person already answered.
 *
 * So nothing here is mocked that matters: the real config manager over a real
 * temp `DORK_HOME`, the real config route, the real `RuntimeRegistry` over a
 * real SQLite db, and the real sessions route.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  expandTilde: (p: string) => p,
  BoundaryError: class BoundaryError extends Error {},
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: { status: { enabled: false, connected: false, url: null } },
}));

vi.mock('../../services/runtimes/claude-code/sdk/sdk-utils.js', () => ({
  resolveClaudeCliPath: () => '/usr/local/bin/claude',
  createHeldUserPrompt: vi.fn(() => ({
    prompt: (async function* () {})(),
    close: vi.fn(),
    push: vi.fn(),
  })),
}));

/** The session a person is about to start. */
const SESSION_ID = '11111111-2222-4333-8444-555555555555';

describe('a standing Full-autonomy default, end to end', () => {
  let app: express.Express;
  let tmpDir: string;
  let fake: FakeAgentRuntime;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-default-stop-e2e-'));
    process.env.DORK_HOME = tmpDir;

    const { initConfigManager } = await import('../../services/core/config-manager.js');
    initConfigManager(tmpDir);

    // The REAL registry, over a real db, holding a runtime that declares real
    // trust semantics. The stop→mode translation under test is the registry
    // reading THIS profile, so a stub profile would test the stub.
    const { runtimeRegistry } = await import('../../services/core/runtime-registry.js');
    fake = new FakeAgentRuntime();
    fake.updateSession.mockReturnValue(true);
    fake.getSession.mockResolvedValue(null);
    runtimeRegistry.register(fake);
    runtimeRegistry.setDefault('fake');
    runtimeRegistry.setDb(createTestDb());

    const configRouter = (await import('../config.js')).default;
    const sessionsRouter = (await import('../sessions.js')).default;
    app = express();
    app.use(express.json());
    // Stands in for `sessionGate`'s resolved user — the cockpit's own posture,
    // which the operator-only write policy on these leaves requires.
    app.use((_req, res, next) => {
      res.locals.user = { userId: 'user_cockpit', credential: 'cookie' };
      next();
    });
    app.use('/api/config', configRouter);
    app.use('/api/sessions', sessionsRouter);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  /** The id this runtime gives its Full-autonomy stop, read from its own profile. */
  function autonomyModeId(): string {
    const descriptor = fake
      .getCapabilities()
      .permissionModes.values.find((d) => d.stop === 'autonomy');
    if (!descriptor) throw new Error('the fake runtime declares no autonomy stop');
    return descriptor.id;
  }

  it('births a bypassed session, and the session door lets that session through', async () => {
    // 1. Settings, in one write: the consent record and the new default. This is
    //    exactly what the confirmation dialog sends.
    await request(app)
      .patch('/api/config')
      .send({
        ui: { autonomyAcknowledgedAt: '2026-08-01T09:30:00.000Z' },
        runtimes: { defaultTrustStop: 'autonomy' },
      })
      .expect(200);

    // 2. A new session is created the way the cockpit creates one — the real
    //    seeding path, with no permission mode passed by anybody.
    const { runtimeRegistry } = await import('../../services/core/runtime-registry.js');
    await runtimeRegistry.persistSessionRuntime(SESSION_ID, 'fake', undefined, {
      interactive: true,
    });

    const settings = await runtimeRegistry.getSessionSettings(SESSION_ID);
    expect(settings?.permissionMode).toBe(autonomyModeId());

    // 3. The door the standing ack has to open. The cockpit re-sends this mode
    //    on ordinary journeys — coming out of Plan is the common one — and
    //    without a standing record every one of them would 428 on a session that
    //    was ALREADY running in autonomy.
    const patched = await request(app)
      .patch(`/api/sessions/${SESSION_ID}`)
      .send({ permissionMode: autonomyModeId() });
    expect(patched.status).toBe(200);
  });

  it('never seeds a session the person is not watching', async () => {
    // The same config, the unattended path — a room turn, a scheduled run, a
    // relay binding. They keep the runtime's own default however the cockpit's
    // default is set.
    await request(app)
      .patch('/api/config')
      .send({
        ui: { autonomyAcknowledgedAt: '2026-08-01T09:30:00.000Z' },
        runtimes: { defaultTrustStop: 'autonomy' },
      })
      .expect(200);

    const { runtimeRegistry } = await import('../../services/core/runtime-registry.js');
    await runtimeRegistry.persistSessionRuntime('22222222-3333-4444-8555-666666666666', 'fake');

    const settings = await runtimeRegistry.getSessionSettings(
      '22222222-3333-4444-8555-666666666666'
    );
    expect(settings?.permissionMode).toBeUndefined();
  });

  it('refuses the default until the acknowledgement exists, and seeds nothing meanwhile', async () => {
    const refused = await request(app)
      .patch('/api/config')
      .send({ runtimes: { defaultTrustStop: 'autonomy' } });
    expect(refused.status).toBe(428);
    expect(refused.body.code).toBe('AUTONOMY_ACK_REQUIRED');

    const { runtimeRegistry } = await import('../../services/core/runtime-registry.js');
    await runtimeRegistry.persistSessionRuntime(SESSION_ID, 'fake', undefined, {
      interactive: true,
    });

    const settings = await runtimeRegistry.getSessionSettings(SESSION_ID);
    expect(settings?.permissionMode).toBeUndefined();

    // And the session door is exactly where it was: still asking.
    const patched = await request(app)
      .patch(`/api/sessions/${SESSION_ID}`)
      .send({ permissionMode: autonomyModeId() });
    expect(patched.status).toBe(428);
  });

  it('stops birthing bypassed sessions the moment the acknowledgement is Reset', async () => {
    // The composition in reverse, and the failure it exists to make unreachable:
    // clearing the record while the default stood left new sessions opening
    // bypassed with no consent on file, and the cockpit's first mode change for
    // one of them bounced off the session door — the person running without
    // asking, unable to change it back without a dialog they thought they had
    // just re-armed.
    await request(app)
      .patch('/api/config')
      .send({
        ui: { autonomyAcknowledgedAt: '2026-08-01T09:30:00.000Z' },
        runtimes: { defaultTrustStop: 'autonomy' },
      })
      .expect(200);

    await request(app)
      .patch('/api/config')
      .send({ ui: { autonomyAcknowledgedAt: null } })
      .expect(200);

    const { runtimeRegistry } = await import('../../services/core/runtime-registry.js');
    await runtimeRegistry.persistSessionRuntime(SESSION_ID, 'fake', undefined, {
      interactive: true,
    });

    // Nothing seeded, because nothing is configured any more.
    const settings = await runtimeRegistry.getSessionSettings(SESSION_ID);
    expect(settings?.permissionMode).toBeUndefined();

    // And the door asks again, which is what Reset promised.
    const patched = await request(app)
      .patch(`/api/sessions/${SESSION_ID}`)
      .send({ permissionMode: autonomyModeId() });
    expect(patched.status).toBe(428);
  });

  it('starts a new session at a gentler configured stop with no ritual at all', async () => {
    await request(app)
      .patch('/api/config')
      .send({ runtimes: { defaultTrustStop: 'act' } })
      .expect(200);

    const { runtimeRegistry } = await import('../../services/core/runtime-registry.js');
    await runtimeRegistry.persistSessionRuntime(SESSION_ID, 'fake', undefined, {
      interactive: true,
    });

    const settings = await runtimeRegistry.getSessionSettings(SESSION_ID);
    // The runtime's own first-declared mode at that stop, never a stop word.
    expect(settings?.permissionMode).toBe('acceptEdits');
  });

  describe('the write leaves a trail a person can read (DOR-1237)', () => {
    /**
     * Every `info` line this request wrote.
     *
     * Spied on the real singleton rather than mocked at the module: the router
     * was imported in `beforeEach`, into the same module registry this import
     * resolves against, so it is the very object the route calls. A module mock
     * would also have to stand in for every other logger method the two routers
     * use, and would go stale the moment one of them used another.
     */
    async function infoLines(run: () => Promise<unknown>): Promise<string[]> {
      const { logger } = await import('../../lib/logger.js');
      const lines: string[] = [];
      const spy = vi.spyOn(logger, 'info').mockImplementation((...args: unknown[]) => {
        lines.push(String(args[0]));
      });
      try {
        await run();
      } finally {
        spy.mockRestore();
      }
      return lines;
    }

    /** The one line this feature exists to write. */
    function patchedLine(lines: string[]): string | undefined {
      return lines.find((line) => line.startsWith('[Config] Patched:'));
    }

    it('names the operator-only leaf that moved, at info', async () => {
      // DOR-1237 in one assertion. `runtimes.claudeCode.defaultTrustStop` moved
      // twice on a real install with nothing on disk that could name the write:
      // the line was `debug`, which a production install never writes, and it
      // named only the section. Both halves are fixed here.
      const lines = await infoLines(() =>
        request(app)
          .patch('/api/config')
          .send({ runtimes: { claudeCode: { defaultTrustStop: 'act' } } })
          .expect(200)
      );

      expect(patchedLine(lines)).toBe('[Config] Patched: runtimes.claudeCode.defaultTrustStop');
    });

    it('names the leaves the SERVER demoted, not just the ones asked for', async () => {
      // Reset clears the acknowledgement and takes every standing autonomy
      // default with it, in the same write. Those leaves are the ones nobody
      // asked to change, so they are the ones most worth having in the log —
      // and reading the WRITE rather than the request is what catches them.
      await request(app)
        .patch('/api/config')
        .send({
          ui: { autonomyAcknowledgedAt: '2026-08-01T09:30:00.000Z' },
          runtimes: { defaultTrustStop: 'autonomy' },
        })
        .expect(200);

      const lines = await infoLines(() =>
        request(app)
          .patch('/api/config')
          .send({ ui: { autonomyAcknowledgedAt: null } })
          .expect(200)
      );

      expect(patchedLine(lines)).toBe(
        '[Config] Patched: runtimes.defaultTrustStop, ui.autonomyAcknowledgedAt'
      );
    });

    it('never writes a value — a path names a setting, a value can be a token', async () => {
      // Logs get read by people, attached to bug reports and pasted into
      // issues. `mcp.apiKey` is declared sensitive by the schema, and the write
      // is allowed; what must never happen is the key landing in the log.
      const lines = await infoLines(() =>
        request(app)
          .patch('/api/config')
          .send({ mcp: { apiKey: 'sk-do-not-log-me-4242' } })
          .expect(200)
      );

      expect(patchedLine(lines)).toBe('[Config] Patched: mcp.apiKey');
      expect(lines.join('\n')).not.toContain('sk-do-not-log-me-4242');
    });

    it('says nothing about a request that changes nothing', async () => {
      // An empty body, and a body that re-sends what is already stored. The
      // second is the one that matters: a client refreshing its whole section
      // must not fill the log with writes that never happened.
      await request(app)
        .patch('/api/config')
        .send({ ui: { theme: 'dark' } })
        .expect(200);

      const empty = await infoLines(() => request(app).patch('/api/config').send({}).expect(200));
      const unchanged = await infoLines(() =>
        request(app)
          .patch('/api/config')
          .send({ ui: { theme: 'dark' } })
          .expect(200)
      );

      expect(patchedLine(empty)).toBeUndefined();
      expect(patchedLine(unchanged)).toBeUndefined();
    });

    it('says nothing about a key the schema threw away', async () => {
      // Zod strips what it does not declare, so this request changed nothing.
      // A line reporting it would send the next investigation after a setting
      // that does not exist.
      const lines = await infoLines(() =>
        request(app)
          .patch('/api/config')
          .send({ ui: { totallyMadeUpKey: 'x' } })
          .expect(200)
      );

      expect(patchedLine(lines)).toBeUndefined();
    });

    it('cannot be forged by an agent through a caller-chosen key', async () => {
      // Reproduced against this route during review. `ui.shapes.agentDefaults`
      // is a `z.record`, so its keys are whatever the caller typed, and it is
      // `agent-writable` — the route's agent bar never applies. A key carrying
      // a newline and a counterfeit `[Config] Patched: …` line wrote a perfect
      // fake of the record this feature exists to make trustworthy.
      const forged = 'proj\n[info] [Config] Patched: runtimes.claudeCode.defaultTrustStop';

      const lines = await infoLines(() =>
        request(app)
          .patch('/api/config')
          .send({ ui: { shapes: { agentDefaults: { [forged]: 'shapeA' } } } })
          .expect(200)
      );

      const line = patchedLine(lines);
      expect(line).toBeDefined();
      // One line, and the counterfeit is inside a quoted segment rather than
      // standing on its own. Reported, not dropped: the write really happened.
      expect(line).not.toContain('\n');
      expect(line).toContain('ui.shapes.agentDefaults.');
      expect(line).toContain('\\n');
      expect(lines.filter((l) => l.startsWith('[Config] Patched:'))).toHaveLength(1);
    });
  });
});
