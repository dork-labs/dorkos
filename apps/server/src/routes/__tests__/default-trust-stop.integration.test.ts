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
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

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
    fake.updateSession.mockReturnValue({ updated: true });
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

    fixtureTarget.mount(app);
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
    await request(fixtureServer)
      .patch('/api/config')
      .send({
        ui: { autonomyAcknowledgedAt: '2026-08-01T09:30:00.000Z' },
        runtimes: { defaultTrustStop: 'autonomy' },
      })
      .expect(200);

    // 2. A new session is created the way the cockpit creates one — the real
    //    seeding path, with no permission mode passed by anybody.
    const { runtimeRegistry } = await import('../../services/core/runtime-registry.js');
    await runtimeRegistry.persistSessionRuntime(SESSION_ID, 'fake', { kind: 'interactive' });

    const settings = await runtimeRegistry.getSessionSettings(SESSION_ID);
    expect(settings?.permissionMode).toBe(autonomyModeId());

    // 3. The door the standing ack has to open. The cockpit re-sends this mode
    //    on ordinary journeys — coming out of Plan is the common one — and
    //    without a standing record every one of them would 428 on a session that
    //    was ALREADY running in autonomy.
    const patched = await request(fixtureServer)
      .patch(`/api/sessions/${SESSION_ID}`)
      .send({ permissionMode: autonomyModeId() });
    expect(patched.status).toBe(200);
  });

  it('seeds a room turn from the same standing default, and a binding from nothing', async () => {
    // The unattended half of the same config, through the required turn origin
    // (DOR-2105). A room FOLLOWS the operator's level — nobody is watching, and
    // that is the reason to follow it rather than the reason not to (DOR-1917)
    // — while a relay binding carries the grant a person set on the binding and
    // must never inherit the operator's own (DOR-604).
    await request(fixtureServer)
      .patch('/api/config')
      .send({
        ui: { autonomyAcknowledgedAt: '2026-08-01T09:30:00.000Z' },
        runtimes: { defaultTrustStop: 'autonomy' },
      })
      .expect(200);

    const { runtimeRegistry } = await import('../../services/core/runtime-registry.js');
    const roomSession = '22222222-3333-4444-8555-666666666666';
    const bindingSession = '33333333-4444-4555-8666-777777777777';
    await runtimeRegistry.persistSessionRuntime(roomSession, 'fake', {
      kind: 'room',
      externalAuthor: false,
    });
    await runtimeRegistry.persistSessionRuntime(bindingSession, 'fake', {
      kind: 'relay-binding',
    });

    expect((await runtimeRegistry.getSessionSettings(roomSession))?.permissionMode).toBe(
      autonomyModeId()
    );
    expect(
      (await runtimeRegistry.getSessionSettings(bindingSession))?.permissionMode
    ).toBeUndefined();
  });

  it('leaves a room conversation that already has a row where it was', async () => {
    // **The case the DOR-2105 review caught**, over the real config, the real
    // registry and a real database. A settings change made before the first
    // message creates an UNBOUND row (DOR-812's pre-launch picker, which E3
    // made the normal way a session starts). A person's own binding write may
    // seed such a row — it is their row, from their sitting. A room's may not:
    // the row is evidence the conversation already exists, and ADR
    // 260908-170643 promises it is untouched.
    await request(fixtureServer)
      .patch('/api/config')
      .send({
        ui: { autonomyAcknowledgedAt: '2026-08-01T09:30:00.000Z' },
        runtimes: { defaultTrustStop: 'autonomy' },
      })
      .expect(200);

    const { runtimeRegistry } = await import('../../services/core/runtime-registry.js');
    const roomSession = '44444444-5555-4666-8777-888888888888';
    const personSession = '55555555-6666-4777-8888-999999999999';
    await runtimeRegistry.saveSessionSettings(roomSession, { model: 'sonnet' });
    await runtimeRegistry.saveSessionSettings(personSession, { model: 'sonnet' });

    await runtimeRegistry.persistSessionRuntime(roomSession, 'fake', {
      kind: 'room',
      externalAuthor: false,
    });
    await runtimeRegistry.persistSessionRuntime(personSession, 'fake', { kind: 'interactive' });

    const room = await runtimeRegistry.getSessionSettings(roomSession);
    const person = await runtimeRegistry.getSessionSettings(personSession);
    expect(room?.permissionMode).toBeUndefined();
    expect(person?.permissionMode).toBe(autonomyModeId());
    // The choice the person actually made survives on both, which is what says
    // the rows really were claimed rather than skipped.
    expect(room?.model).toBe('sonnet');
    expect(person?.model).toBe('sonnet');
  });

  it('refuses the default until the acknowledgement exists, and seeds nothing meanwhile', async () => {
    const refused = await request(fixtureServer)
      .patch('/api/config')
      .send({ runtimes: { defaultTrustStop: 'autonomy' } });
    expect(refused.status).toBe(428);
    expect(refused.body.code).toBe('AUTONOMY_ACK_REQUIRED');

    const { runtimeRegistry } = await import('../../services/core/runtime-registry.js');
    await runtimeRegistry.persistSessionRuntime(SESSION_ID, 'fake', { kind: 'interactive' });

    const settings = await runtimeRegistry.getSessionSettings(SESSION_ID);
    expect(settings?.permissionMode).toBeUndefined();

    // And the session door is exactly where it was: still asking.
    const patched = await request(fixtureServer)
      .patch(`/api/sessions/${SESSION_ID}`)
      .send({ permissionMode: autonomyModeId() });
    expect(patched.status).toBe(428);
  });

  it('lets the screen read a choice made before the first message, after a reload', async () => {
    // THE PROBE (DOR-2103). A settings change made before sending writes an
    // UNBOUND `session_metadata` row (DOR-812), and until this read existed
    // nothing on this server could see one: every session endpoint resolves a
    // session out of its RUNTIME's store (ADR-0310), so a row with no
    // transcript is a 404 on `GET /api/sessions/:id` and absent from the list.
    //
    // What that cost, measured here: the operator's default is Full autonomy,
    // the person deliberately moved THIS conversation down to `default` before
    // sending, and after a reload the client had nothing to read and fell back
    // to the configured stop — the dial claiming more power than the turn would
    // run at. The direction this product must never be confidently wrong in.
    await request(fixtureServer)
      .patch('/api/config')
      .send({
        ui: { autonomyAcknowledgedAt: '2026-08-01T09:30:00.000Z' },
        runtimes: { defaultTrustStop: 'autonomy' },
      })
      .expect(200);

    const { runtimeRegistry } = await import('../../services/core/runtime-registry.js');
    // Exactly what the pre-launch picker's PATCH leaves behind: a row, a chosen
    // mode, and no runtime.
    await runtimeRegistry.saveSessionSettings(SESSION_ID, { permissionMode: 'default' });

    // The reload shape: the session is in no list and has no transcript, so
    // this is the only read that can answer.
    expect((await request(fixtureServer).get(`/api/sessions/${SESSION_ID}`)).status).toBe(404);

    const stored = await request(fixtureServer).get(`/api/sessions/${SESSION_ID}/settings`);
    expect(stored.status).toBe(200);
    expect(stored.body.settings.permissionMode).toBe('default');
    // And it is NOT the operator's configured stop, which is what the screen
    // would otherwise have shown.
    expect(stored.body.settings.permissionMode).not.toBe(autonomyModeId());

    // The choice still wins at the binding write, which is the behaviour the
    // screen now matches rather than contradicts.
    await runtimeRegistry.persistSessionRuntime(SESSION_ID, 'fake', { kind: 'interactive' });
    expect((await runtimeRegistry.getSessionSettings(SESSION_ID))?.permissionMode).toBe('default');
  });

  it('answers null for an id nothing is stored under, and writes no row', async () => {
    // A read that back-filled would mint a row for any id it was handed, and
    // `persistSessionRuntime` is first-write-wins — so the guess would become
    // the binding (DOR-812). `null` is the honest shape for "nothing stored",
    // and the absence of a row afterwards is what says nothing was written.
    const unknown = '66666666-7777-4888-8999-aaaaaaaaaaaa';
    const res = await request(fixtureServer).get(`/api/sessions/${unknown}/settings`);
    expect(res.status).toBe(200);
    expect(res.body.settings).toBeNull();

    const { runtimeRegistry } = await import('../../services/core/runtime-registry.js');
    expect(await runtimeRegistry.getSessionSettings(unknown)).toBeNull();
    // Still unbound, so the first turn is still free to decide the owner.
    expect((await runtimeRegistry.resolveSessionRuntime(unknown)).bound).toBe(false);
  });

  it('stops birthing bypassed sessions the moment the acknowledgement is Reset', async () => {
    // The composition in reverse, and the failure it exists to make unreachable:
    // clearing the record while the default stood left new sessions opening
    // bypassed with no consent on file, and the cockpit's first mode change for
    // one of them bounced off the session door — the person running without
    // asking, unable to change it back without a dialog they thought they had
    // just re-armed.
    await request(fixtureServer)
      .patch('/api/config')
      .send({
        ui: { autonomyAcknowledgedAt: '2026-08-01T09:30:00.000Z' },
        runtimes: { defaultTrustStop: 'autonomy' },
      })
      .expect(200);

    await request(fixtureServer)
      .patch('/api/config')
      .send({ ui: { autonomyAcknowledgedAt: null } })
      .expect(200);

    const { runtimeRegistry } = await import('../../services/core/runtime-registry.js');
    await runtimeRegistry.persistSessionRuntime(SESSION_ID, 'fake', { kind: 'interactive' });

    // Nothing seeded, because nothing is configured any more.
    const settings = await runtimeRegistry.getSessionSettings(SESSION_ID);
    expect(settings?.permissionMode).toBeUndefined();

    // And the door asks again, which is what Reset promised.
    const patched = await request(fixtureServer)
      .patch(`/api/sessions/${SESSION_ID}`)
      .send({ permissionMode: autonomyModeId() });
    expect(patched.status).toBe(428);
  });

  it('starts a new session at a gentler configured stop with no ritual at all', async () => {
    await request(fixtureServer)
      .patch('/api/config')
      .send({ runtimes: { defaultTrustStop: 'act' } })
      .expect(200);

    const { runtimeRegistry } = await import('../../services/core/runtime-registry.js');
    await runtimeRegistry.persistSessionRuntime(SESSION_ID, 'fake', { kind: 'interactive' });

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
      return lines.find((line) => line.startsWith('[Config] Patched by'));
    }

    it('names the operator-only leaf that moved, and the door it came through', async () => {
      // DOR-1237 in one assertion. `runtimes.claudeCode.defaultTrustStop` moved
      // twice on a real install with nothing on disk that could name the write:
      // the line was `debug`, which a production install never writes, and it
      // named only the section. Both halves are fixed here.
      //
      // The line names the DOOR as well (DOR-1247), because the same question —
      // what wrote it? — has three possible answers now that `dorkos config set`
      // and the `config_patch` tool write the same line through the same step.
      const lines = await infoLines(() =>
        request(fixtureServer)
          .patch('/api/config')
          .send({ runtimes: { claudeCode: { defaultTrustStop: 'act' } } })
          .expect(200)
      );

      expect(patchedLine(lines)).toBe(
        '[Config] Patched by PATCH /api/config: runtimes.claudeCode.defaultTrustStop'
      );
    });

    it('names the leaves the SERVER demoted, not just the ones asked for', async () => {
      // Reset clears the acknowledgement and takes every standing autonomy
      // default with it, in the same write. Those leaves are the ones nobody
      // asked to change, so they are the ones most worth having in the log —
      // and reading the WRITE rather than the request is what catches them.
      await request(fixtureServer)
        .patch('/api/config')
        .send({
          ui: { autonomyAcknowledgedAt: '2026-08-01T09:30:00.000Z' },
          runtimes: { defaultTrustStop: 'autonomy' },
        })
        .expect(200);

      const lines = await infoLines(() =>
        request(fixtureServer)
          .patch('/api/config')
          .send({ ui: { autonomyAcknowledgedAt: null } })
          .expect(200)
      );

      expect(patchedLine(lines)).toBe(
        '[Config] Patched by PATCH /api/config: runtimes.defaultTrustStop, ui.autonomyAcknowledgedAt'
      );
    });

    it('never writes a value — a path names a setting, a value can be a token', async () => {
      // Logs get read by people, attached to bug reports and pasted into
      // issues. `mcp.apiKey` is declared sensitive by the schema, and the write
      // is allowed; what must never happen is the key landing in the log.
      const lines = await infoLines(() =>
        request(fixtureServer)
          .patch('/api/config')
          .send({ mcp: { apiKey: 'sk-do-not-log-me-4242' } })
          .expect(200)
      );

      expect(patchedLine(lines)).toBe('[Config] Patched by PATCH /api/config: mcp.apiKey');
      expect(lines.join('\n')).not.toContain('sk-do-not-log-me-4242');
    });

    it('says nothing about a request that changes nothing', async () => {
      // An empty body, and a body that re-sends what is already stored. The
      // second is the one that matters: a client refreshing its whole section
      // must not fill the log with writes that never happened.
      await request(fixtureServer)
        .patch('/api/config')
        .send({ ui: { theme: 'dark' } })
        .expect(200);

      const empty = await infoLines(() =>
        request(fixtureServer).patch('/api/config').send({}).expect(200)
      );
      const unchanged = await infoLines(() =>
        request(fixtureServer)
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
        request(fixtureServer)
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
      // a newline and a counterfeit `[Config] Patched by …` line wrote a perfect
      // fake of the record this feature exists to make trustworthy.
      const forged =
        'proj\n[info] [Config] Patched by PATCH /api/config: runtimes.claudeCode.defaultTrustStop';

      const lines = await infoLines(() =>
        request(fixtureServer)
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
      expect(lines.filter((l) => l.startsWith('[Config] Patched by'))).toHaveLength(1);
    });
  });
});
