import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock tunnel-manager and agent-manager to avoid side effects
vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null },
  },
}));

vi.mock('../../services/runtimes/claude-code/sdk/sdk-utils.js', () => ({
  resolveClaudeCliPath: () => '/usr/local/bin/claude',
  createHeldUserPrompt: vi.fn(() => ({ prompt: (async function* () {})(), close: vi.fn() })),
}));

vi.mock('../../lib/boundary.js', () => ({
  getBoundary: () => '/Users/test-user',
  // `lib/agents-home.js` reaches through boundary for a directory a person
  // configured themselves. Left real-ish so the resolved-directory assertions
  // below measure the dork-home mapping, not a stub.
  expandTilde: (p: string) => (p.startsWith('~/') ? `/Users/test-user/${p.slice(2)}` : p),
}));

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-config-route-test-'));
}

/**
 * Register the runtimes `GET /api/config` builds `executionDefaults` from.
 *
 * The report is derived from each REGISTERED runtime's own `settings`
 * declaration rather than a list the server keeps, so a test app with an empty
 * registry honestly reports no per-runtime defaults at all. These fakes carry
 * the four shipped declarations verbatim — including `test-mode`, whose
 * `configSection: null` is the case the report has to leave out, and can only
 * be shown leaving out if it was offered.
 *
 * Called after the router is imported so both see the same singleton: every
 * test in this file resets the module registry, which mints a fresh one.
 */
async function registerDeclaringRuntimes(): Promise<void> {
  const { runtimeRegistry } = await import('../../services/core/runtime-registry.js');
  const { FakeAgentRuntime } = await import('@dorkos/test-utils');
  const [
    { CLAUDE_CODE_CAPABILITIES },
    { CODEX_CAPABILITIES },
    { OPENCODE_CAPABILITIES },
    { TEST_MODE_CAPABILITIES },
  ] = await Promise.all([
    import('../../services/runtimes/claude-code/runtime-constants.js'),
    import('../../services/runtimes/codex/runtime-constants.js'),
    import('../../services/runtimes/opencode/runtime-constants.js'),
    import('../../services/runtimes/test-mode/runtime-constants.js'),
  ]);
  for (const capabilities of [
    CLAUDE_CODE_CAPABILITIES,
    CODEX_CAPABILITIES,
    OPENCODE_CAPABILITIES,
    TEST_MODE_CAPABILITIES,
  ]) {
    runtimeRegistry.register(
      new FakeAgentRuntime(capabilities.type, { settings: capabilities.settings })
    );
  }
}

/**
 * Stands in for `sessionGate`'s resolved user. `PATCH /api/config` now skips the
 * operator-only write policy only for a caller that may DECIDE approvals, and
 * with login ON that requires an authenticated user on `res.locals` — which the
 * real cockpit carries and a bare test app otherwise would not (DOR-467).
 */
let signedInUser: { userId: string; credential: 'cookie' | 'api-key' } | undefined;

/** Stands in for the `X-DorkOS-Agent` header an agent's CLI attaches. */
let agentHeader: string | undefined;

/**
 * ONE listener for the whole file, with the app behind it swapped per test
 * (DOR-483). Each test still gets a FRESH app — its own config directory, its
 * own freshly imported router — but no port is ever bound and freed mid-file,
 * so a pooled keep-alive socket can never be handed to a request meant for a
 * different test's server. See {@link swappableServer}.
 */
const target = swappableServer();
const server = target.server;

/** Mount the request-shaping middleware every config-route app needs. */
function mountCallerFixture(app: express.Express): void {
  signedInUser = { userId: 'user_cockpit', credential: 'cookie' };
  agentHeader = undefined;
  app.use((req, res, next) => {
    if (signedInUser) res.locals.user = signedInUser;
    if (agentHeader) req.headers['x-dorkos-agent'] = agentHeader;
    next();
  });
}

describe('PATCH /api/config', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = createTempDir();
    process.env.DORK_HOME = tmpDir;

    // Initialize config manager before importing routes
    const { initConfigManager } = await import('../../services/core/config-manager.js');
    initConfigManager(tmpDir);

    const configRouter = (await import('../config.js')).default;
    const app = express();
    app.use(express.json());
    mountCallerFixture(app);
    app.use('/api/config', configRouter);
    target.mount(app);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('returns 200 with merged config for valid partial update', async () => {
    const response = await request(server)
      .patch('/api/config')
      .send({ ui: { theme: 'dark' } })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.config.ui.theme).toBe('dark');
    // Other values should remain default
    expect(response.body.config.server.port).toBe(4242);
  });

  it('returns 400 with Zod errors for invalid port value', async () => {
    const response = await request(server)
      .patch('/api/config')
      .send({ server: { port: 80 } })
      .expect(400);

    expect(response.body.error).toBe('Validation failed');
    expect(response.body.details).toBeDefined();
    expect(response.body.details.length).toBeGreaterThan(0);
    expect(response.body.details[0]).toContain('server.port');
  });

  it('includes warning for sensitive key', async () => {
    const response = await request(server)
      .patch('/api/config')
      .send({ tunnel: { authtoken: 'my-secret-token' } })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.warnings).toBeDefined();
    expect(response.body.warnings[0]).toContain('sensitive data');
  });

  it('includes warning for the sensitive cloud.instanceToken key', async () => {
    const response = await request(server)
      .patch('/api/config')
      .send({ cloud: { instanceToken: 'dork_inst_secret' } })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.warnings).toBeDefined();
    expect(response.body.warnings.some((w: string) => w.includes('cloud.instanceToken'))).toBe(
      true
    );
  });

  it('returns 200 for empty object body (no-op)', async () => {
    const response = await request(server).patch('/api/config').send({}).expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.config.server.port).toBe(4242);
  });

  it('returns 400 for array body', async () => {
    const response = await request(server)
      .patch('/api/config')
      .send([{ server: { port: 5000 } }])
      .expect(400);

    expect(response.body.error).toContain('JSON object');
  });

  it('persists changes across reads', async () => {
    await request(server)
      .patch('/api/config')
      .send({ ui: { theme: 'dark' } })
      .expect(200);

    // Re-import to verify persistence
    const { configManager } = await import('../../services/core/config-manager.js');
    expect(configManager.getDot('ui.theme')).toBe('dark');
  });

  it('lets a person turn login on and off (the cockpit path)', async () => {
    // DOR-488: the agent-facing `config_patch` capability refuses posture-bearing
    // settings, but the guard sits at the CAPABILITY HANDLER, not inside the
    // shared `applyConfigPatch`. This route is what the cockpit's own enable-login
    // (`OwnerSetupHost.tsx`) and disable-login (`SecurityPanel.tsx`) flows call, so
    // if it ever starts refusing, a person can no longer turn login on at all.
    const { configManager } = await import('../../services/core/config-manager.js');

    const enabled = await request(server)
      .patch('/api/config')
      .send({ auth: { enabled: true } })
      .expect(200);
    expect(enabled.body.success).toBe(true);
    expect(enabled.body.config.auth.enabled).toBe(true);
    expect(configManager.getDot('auth.enabled')).toBe(true);

    const disabled = await request(server)
      .patch('/api/config')
      .send({ auth: { enabled: false } })
      .expect(200);
    expect(disabled.body.success).toBe(true);
    expect(configManager.getDot('auth.enabled')).toBe(false);
  });

  it('refuses an AGENT the settings that protect the instance (DOR-467)', async () => {
    // The door this closes. PR #469 put the operator-only write policy on the
    // agent-facing capability, but this REST route reached the same
    // `applyConfigPatch` with no policy check at all — and with login off
    // `sessionGate` is a pass-through, so `curl -X PATCH /api/config` walked
    // straight around the guard whose whole promise is that agents cannot change
    // the settings protecting the instance.
    agentHeader = 'agent-token';
    signedInUser = undefined;

    const refused = await request(server)
      .patch('/api/config')
      .send({ server: { boundary: '/' } })
      .expect(403);
    expect(refused.body.code).toBe('operator_only_config');
    expect(refused.body.paths).toContain('server.boundary');

    const { configManager } = await import('../../services/core/config-manager.js');
    expect(configManager.getDot('server.boundary')).not.toBe('/');
  });

  it('refuses an agent turning login OFF, the setting approvals depend on', async () => {
    agentHeader = 'agent-token';
    signedInUser = undefined;

    await request(server)
      .patch('/api/config')
      .send({ auth: { enabled: false } })
      .expect(403);
  });

  describe('approvals.* — the settings that additionally need login ON (DOR-501, DOR-505)', () => {
    /** Turn local login on, which is what makes a cookie possible at all. */
    async function enableLogin(): Promise<void> {
      const { configManager } = await import('../../services/core/config-manager.js');
      configManager.set('auth', { enabled: true });
    }

    it('refuses a header-stripping caller, which the agent bar alone lets through', async () => {
      // This is step 1 of the reproduced chain. The agent bar (`trustedCaller`) is
      // satisfied by a caller presenting neither an agent header nor an approval
      // token, so on its own it would let this through.
      //
      // What refuses it is the COOKIE bar, and since DOR-505 that bar covers every
      // operator-only path rather than just this subtree — so this case is no
      // longer special, it is simply the first place the general rule was proven.
      // What remains specific to `approvals.*` is the LOGIN bar, exercised by
      // "refuses everyone while login is off" below.
      await enableLogin();
      agentHeader = undefined;
      signedInUser = undefined;

      const refused = await request(server)
        .patch('/api/config')
        .send({ approvals: { standingGrants: true } })
        .expect(403);
      expect(refused.body.code).toBe('operator_cookie_required');
      expect(refused.body.paths).toEqual(['approvals.standingGrants']);

      const { configManager } = await import('../../services/core/config-manager.js');
      expect(configManager.getDot('approvals.standingGrants')).toBe(false);
    });

    it('refuses a caller holding a per-user API key rather than a session', async () => {
      // Login being ON is not enough. A key satisfies `sessionGate` exactly as a
      // browser session does, so a program handed one would otherwise qualify.
      await enableLogin();
      signedInUser = { userId: 'user_program', credential: 'api-key' };

      const refused = await request(server)
        .patch('/api/config')
        .send({ approvals: { standingGrants: true } })
        .expect(403);
      expect(refused.body.code).toBe('operator_cookie_required');
    });

    it('refuses everyone while login is off, and says why', async () => {
      const { configManager } = await import('../../services/core/config-manager.js');
      configManager.set('auth', { enabled: false });
      signedInUser = { userId: 'user_cockpit', credential: 'cookie' };

      const refused = await request(server)
        .patch('/api/config')
        .send({ approvals: { standingGrants: true } })
        .expect(403);
      expect(refused.body.code).toBe('standing_grants_require_login');
      expect(refused.body.message).toMatch(/Require login/);
    });

    it('catches a patch that stops short of the leaf', async () => {
      await enableLogin();
      signedInUser = undefined;

      const refused = await request(server)
        .patch('/api/config')
        .send({ approvals: {} })
        .expect(403);
      expect(refused.body.code).toBe('operator_cookie_required');
    });

    it('lets a person signed in to the cockpit change them', async () => {
      await enableLogin();
      signedInUser = { userId: 'user_cockpit', credential: 'cookie' };

      const ok = await request(server)
        .patch('/api/config')
        .send({ approvals: { standingGrants: true, trustWindowMinutes: 120 } })
        .expect(200);
      expect(ok.body.config.approvals).toEqual({
        standingGrants: true,
        trustWindowMinutes: 120,
        // Untouched by a widening write: switching the feature ON voids nothing
        // (DOR-520).
        standingGrantsVoidBefore: null,
      });
    });

    it('refuses an array-shaped body, which the path matcher deliberately ignores', async () => {
      // `findLoginRequiredPaths` walks objects and returns nothing for an array,
      // so the login bar never sees this body. It is safe only because the config
      // schema is an object and `applyConfigPatch` rejects the shape outright.
      // Pinned so that stays true: if config ever accepted an array anywhere, this
      // goes red instead of quietly becoming a way around the bar.
      await enableLogin();
      signedInUser = undefined;

      await request(server)
        .patch('/api/config')
        .send([{ approvals: { standingGrants: true } }])
        .expect(400);

      const { configManager } = await import('../../services/core/config-manager.js');
      expect(configManager.getDot('approvals.standingGrants')).toBe(false);
    });

    it('refuses a window longer than a day, so "forever" stays unrepresentable', async () => {
      await enableLogin();
      signedInUser = { userId: 'user_cockpit', credential: 'cookie' };

      await request(server)
        .patch('/api/config')
        .send({ approvals: { trustWindowMinutes: 10080 } })
        .expect(400);
    });
  });

  describe('every operator-only setting, with login on (DOR-505)', () => {
    /** Turn local login on, which is what makes a cookie possible at all. */
    async function enableLogin(): Promise<void> {
      const { configManager } = await import('../../services/core/config-manager.js');
      configManager.set('auth', { enabled: true });
    }

    it('refuses a caller holding a per-user API key the settings that protect the instance', async () => {
      // The hole DOR-505 closes, reproduced. A program handed one of the
      // person's API keys satisfies `sessionGate` exactly as a browser session
      // does (DOR-474), and stripping its agent header clears `trustedCaller`.
      // Before this, both bars were clear and it could turn login off — voiding
      // every approval the instance would ever enforce — while the capability
      // surface refused it that same write.
      await enableLogin();
      agentHeader = undefined;
      signedInUser = { userId: 'user_program', credential: 'api-key' };

      const refused = await request(server)
        .patch('/api/config')
        .send({ auth: { enabled: false } })
        .expect(403);
      expect(refused.body.code).toBe('operator_cookie_required');
      expect(refused.body.paths).toEqual(['auth.enabled']);

      const { configManager } = await import('../../services/core/config-manager.js');
      expect(configManager.getDot('auth.enabled')).toBe(true);
    });

    it('refuses the same key every other operator-only path too, not just the login gate', async () => {
      await enableLogin();
      signedInUser = { userId: 'user_program', credential: 'api-key' };

      for (const patch of [
        { tunnel: { authtoken: 'attacker-ngrok-token' } },
        { mcp: { apiKey: 'attacker-bearer' } },
        { server: { boundary: '/' } },
        { runtimes: { codex: { binaryPath: '/tmp/evil' } } },
      ]) {
        const refused = await request(server).patch('/api/config').send(patch).expect(403);
        expect(refused.body.code).toBe('operator_cookie_required');
      }

      const { configManager } = await import('../../services/core/config-manager.js');
      expect(configManager.getDot('tunnel.authtoken')).toBeNull();
      expect(configManager.getDot('mcp.apiKey')).toBeNull();
    });

    it('leaves ordinary settings alone, so the bar is not a blanket refusal', async () => {
      // A key is a legitimate credential. It just is not a person, and only the
      // operator-only paths turn on that difference.
      await enableLogin();
      signedInUser = { userId: 'user_program', credential: 'api-key' };

      const ok = await request(server)
        .patch('/api/config')
        .send({ ui: { theme: 'dark' } })
        .expect(200);
      expect(ok.body.config.ui.theme).toBe('dark');
    });

    it('lets the person in the cockpit through', async () => {
      await enableLogin();
      signedInUser = { userId: 'user_cockpit', credential: 'cookie' };

      const ok = await request(server)
        .patch('/api/config')
        .send({ tunnel: { authtoken: 'chosen-by-a-person' } })
        .expect(200);
      expect(ok.body.config.tunnel.authtoken).toBe('chosen-by-a-person');
    });

    it('still refuses an agent that names itself, cookie or not', async () => {
      // The cookie bar runs first and this caller CLEARS it, so what refuses here
      // is the agent bar behind it. A session cookie riding along with an agent
      // identity is a contradiction, not a promotion: clearing one bar never
      // softens the other.
      await enableLogin();
      agentHeader = 'agent-token';
      signedInUser = { userId: 'user_cockpit', credential: 'cookie' };

      const refused = await request(server)
        .patch('/api/config')
        .send({ auth: { enabled: false } })
        .expect(403);
      expect(refused.body.code).toBe('operator_only_config');
    });

    it('lets a person turn login ON without a cookie, because there cannot be one yet', async () => {
      // The lockout this must never cause. `OwnerSetupHost.tsx` writes
      // `auth.enabled: true` while login is still OFF, so the caller has no
      // cookie and cannot get one until the write lands. A bar that read the
      // patched state instead of the current state would make login impossible
      // to turn on, and a reviewer locked themselves out of an instance this way.
      signedInUser = undefined;
      agentHeader = undefined;

      const ok = await request(server)
        .patch('/api/config')
        .send({ auth: { enabled: true } })
        .expect(200);
      expect(ok.body.config.auth.enabled).toBe(true);
    });
  });

  it('DOES let a header-stripping caller write these while login is OFF (the open residual)', async () => {
    // Not an oversight, and pinned so nobody has to take the docs' word for it.
    // With login off there is no cookie for ANYONE, so the DOR-505 bar cannot
    // apply without locking a person out of their own settings: the cockpit in
    // the default posture presents nothing this caller does not also present.
    //
    // If this test ever goes red, that is good news, but it means the residual
    // closed and three places now say something false about DorkOS. Update them
    // in the same change: the bar-2 comment in `routes/config.ts`, the
    // "Who may write which setting" section of `contributing/configuration.md`,
    // and "Settings your agents cannot change" in `docs/guides/action-approvals.mdx`.
    signedInUser = undefined;
    agentHeader = undefined;

    const ok = await request(server)
      .patch('/api/config')
      .send({ tunnel: { authtoken: 'planted' }, mcp: { apiKey: 'planted' } })
      .expect(200);
    expect(ok.body.config.tunnel.authtoken).toBe('planted');

    const { configManager } = await import('../../services/core/config-manager.js');
    expect(configManager.getDot('mcp.apiKey')).toBe('planted');
  });

  it('still lets an agent change ordinary settings', async () => {
    // The refusal is scoped to the policy, not to agents: an agent editing a
    // theme is exactly what the operator surface is for.
    agentHeader = 'agent-token';
    signedInUser = undefined;

    const ok = await request(server)
      .patch('/api/config')
      .send({ ui: { theme: 'dark' } })
      .expect(200);
    expect(ok.body.config.ui.theme).toBe('dark');
  });

  it('lets a person change the other operator-only settings too', async () => {
    // The rest of the write allowlist, proven not to have leaked onto the human
    // path: exposure, the MCP endpoint's key, telemetry consent, and the boundary.
    const response = await request(server)
      .patch('/api/config')
      .send({
        tunnel: { enabled: true },
        mcp: { apiKey: 'chosen-by-a-person' },
        telemetry: { usage: false },
        server: { boundary: '/Users/test-user' },
      })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.config.tunnel.enabled).toBe(true);
    expect(response.body.config.telemetry.usage).toBe(false);
    expect(response.body.config.server.boundary).toBe('/Users/test-user');
  });

  it('returns 400 for invalid theme value', async () => {
    const response = await request(server)
      .patch('/api/config')
      .send({ ui: { theme: 'invalid-theme' } })
      .expect(400);

    expect(response.body.error).toBe('Validation failed');
  });

  it('deep merges nested config objects', async () => {
    // First set port to 5000
    await request(server)
      .patch('/api/config')
      .send({ server: { port: 5000 } })
      .expect(200);

    // Then set cwd, port should remain 5000
    const response = await request(server)
      .patch('/api/config')
      .send({ server: { cwd: '/test' } })
      .expect(200);

    expect(response.body.config.server.port).toBe(5000);
    expect(response.body.config.server.cwd).toBe('/test');
  });

  it('warns for multiple sensitive keys', async () => {
    const response = await request(server)
      .patch('/api/config')
      .send({
        tunnel: {
          authtoken: 'token',
          auth: 'user:pass',
        },
      })
      .expect(200);

    expect(response.body.warnings).toBeDefined();
    expect(response.body.warnings.length).toBe(2);
  });

  it('validates port range correctly', async () => {
    const response = await request(server)
      .patch('/api/config')
      .send({ server: { port: 70000 } })
      .expect(400);

    expect(response.body.error).toBe('Validation failed');
  });
});

describe('GET /api/config', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = createTempDir();
    process.env.DORK_HOME = tmpDir;

    const { initConfigManager } = await import('../../services/core/config-manager.js');
    initConfigManager(tmpDir);

    const configRouter = (await import('../config.js')).default;
    await registerDeclaringRuntimes();
    const app = express();
    app.use(express.json());
    mountCallerFixture(app);
    app.use('/api/config', configRouter);
    target.mount(app);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('includes boundary field in response', async () => {
    const res = await request(server).get('/api/config');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('boundary');
    expect(typeof res.body.boundary).toBe('string');
    expect(res.body.boundary).toBe('/Users/test-user');
  });

  it('includes existing config fields alongside boundary', async () => {
    const res = await request(server).get('/api/config').expect(200);

    expect(res.body).toHaveProperty('version');
    expect(res.body).toHaveProperty('workingDirectory');
    expect(res.body).toHaveProperty('boundary');
    expect(res.body).toHaveProperty('tunnel');
    expect(res.body).toHaveProperty('tasks');
    expect(res.body).toHaveProperty('relay');
    expect(res.body).toHaveProperty('mesh');
  });

  // The Defaults card reads this and nothing else. Its shape is a client
  // contract: it survived the move from a server-kept runtime→section list to
  // each runtime's own declaration, and that is what this pins.
  describe('executionDefaults — the shape the cockpit reads', () => {
    it('reports the same keys, with the same types, on a fresh install', async () => {
      const res = await request(server).get('/api/config').expect(200);
      const { executionDefaults } = res.body;

      expect(typeof executionDefaults.runtime).toBe('string');
      expect(executionDefaults.trustStop).toBeNull();
      expect(Array.isArray(executionDefaults.perRuntime)).toBe(true);
      for (const entry of executionDefaults.perRuntime) {
        expect(Object.keys(entry).sort()).toEqual([
          'effort',
          'model',
          'runtime',
          'supportsEffort',
          'trustStop',
        ]);
        expect(typeof entry.runtime).toBe('string');
        expect(typeof entry.supportsEffort).toBe('boolean');
        expect(entry.model).toBeNull();
        expect(entry.effort).toBeNull();
        expect(entry.trustStop).toBeNull();
      }
    });

    it('reports one entry per runtime that declares a config section', async () => {
      // `test-mode` is registered and declares none, so it is absent — the same
      // answer it gave when a hand-kept map left it out, now said by the runtime.
      const res = await request(server).get('/api/config').expect(200);

      expect(
        res.body.executionDefaults.perRuntime.map((e: { runtime: string }) => e.runtime)
      ).toEqual(['claude-code', 'codex', 'opencode']);
    });

    it('reports each runtime’s declared effort support', async () => {
      const res = await request(server).get('/api/config').expect(200);
      const supports = Object.fromEntries(
        res.body.executionDefaults.perRuntime.map(
          (e: { runtime: string; supportsEffort: boolean }) => [e.runtime, e.supportsEffort]
        )
      );

      expect(supports).toEqual({ 'claude-code': true, codex: true, opencode: false });
    });
  });

  // First-run setup asks one question of this response: has the default runtime
  // already been decided? An absent answer would read as "no" and let a machine
  // that is long past onboarding have its setting rewritten.
  describe('onboarding.runtimeDefaultSetAt — the once-only marker', () => {
    it('reports null on a fresh install', async () => {
      const res = await request(server).get('/api/config').expect(200);
      expect(res.body.onboarding).toHaveProperty('runtimeDefaultSetAt', null);
    });

    // The upgrade path, taken from disk rather than through `configManager.set`
    // — which re-validates and would fill the field itself, making the assertion
    // true whatever the loader does. What is under test is that an install that
    // has never heard of this field still REPORTS it, because the first-run gate
    // reads "already decided?" off this one value.
    it('reports null for an install whose config file predates the field', async () => {
      const legacyDir = createTempDir();
      fs.writeFileSync(
        path.join(legacyDir, 'config.json'),
        JSON.stringify({
          version: 1,
          onboarding: {
            completedSteps: ['meet-dorkbot'],
            skippedSteps: [],
            startedAt: '2026-07-01T00:00:00.000Z',
            dismissedAt: null,
            completedAt: '2026-07-01T00:05:00.000Z',
          },
          __internal__: { migrations: { version: '0.55.0' } },
        })
      );
      process.env.DORK_HOME = legacyDir;

      const { initConfigManager } = await import('../../services/core/config-manager.js');
      initConfigManager(legacyDir);
      const legacyRouter = (await import('../config.js')).default;
      const legacyApp = express();
      legacyApp.use(express.json());
      mountCallerFixture(legacyApp);
      legacyApp.use('/api/config', legacyRouter);

      const res = await request(legacyApp).get('/api/config').expect(200);
      expect(res.body.onboarding).toHaveProperty('runtimeDefaultSetAt', null);
      // The values that file DID carry survive the load untouched.
      expect(res.body.onboarding.completedAt).toBe('2026-07-01T00:05:00.000Z');
      expect(res.body.onboarding.completedSteps).toEqual(['meet-dorkbot']);
      fs.rmSync(legacyDir, { recursive: true, force: true });
    });

    it('reports the stamp once first-run setup has decided', async () => {
      const { configManager } = await import('../../services/core/config-manager.js');
      const onboarding = configManager.get('onboarding');
      configManager.set('onboarding', {
        ...onboarding,
        runtimeDefaultSetAt: '2026-07-31T09:00:00.000Z',
      });

      const res = await request(server).get('/api/config').expect(200);
      expect(res.body.onboarding.runtimeDefaultSetAt).toBe('2026-07-31T09:00:00.000Z');
    });
  });

  // The cockpit prints these two numbers inside the sentence that describes the
  // `engaged` response mode — "keeps answering for 10 more minutes or 5 more
  // messages". They are settings, so the sentence is only true if the cockpit
  // reads the numbers actually in force rather than the shipped defaults.
  describe('rooms — the engaged-window numbers the cockpit says out loud', () => {
    it('reports the shipped ceilings when nobody has changed them', async () => {
      const res = await request(server).get('/api/config').expect(200);

      expect(res.body.rooms).toEqual({ engagedWindowMinutes: 10, engagedWindowPosts: 5 });
    });

    it('reports what an operator actually set, not what ships', async () => {
      const { configManager } = await import('../../services/core/config-manager.js');
      configManager.set('rooms', {
        ...configManager.get('rooms')!,
        engagedWindowMinutes: 3,
        engagedWindowPosts: 2,
      });

      const res = await request(server).get('/api/config').expect(200);

      expect(res.body.rooms).toEqual({ engagedWindowMinutes: 3, engagedWindowPosts: 2 });
    });

    it('carries the two ceilings and nothing else out of the rooms block', async () => {
      // The rest of `rooms` is turn budgets and reply waits — real settings the
      // cockpit never states out loud. Widening this to the whole block would
      // put an operator's spend limits on a wire that did not need them.
      const res = await request(server).get('/api/config').expect(200);

      expect(Object.keys(res.body.rooms).sort()).toEqual([
        'engagedWindowMinutes',
        'engagedWindowPosts',
      ]);
    });
  });

  // The Settings Tools tab offers a switch for each of these two subsystems, and
  // the switch is only honest if it can tell "what is running" from "what the
  // setting says". The server starts them once, at boot, so those two facts part
  // ways the moment somebody flips the switch and stay parted until the next
  // restart — or forever, when an environment variable is deciding instead
  // (spec team-room-home D6).
  describe('tasks/relay — what is running versus what the setting says', () => {
    it('reports both as on for a fresh install', async () => {
      const res = await request(server).get('/api/config').expect(200);

      expect(res.body.tasks.enabledInConfig).toBe(true);
      expect(res.body.relay.enabledInConfig).toBe(true);
      expect(res.body.tasks.lockedByEnv).toBe(false);
      expect(res.body.relay.lockedByEnv).toBe(false);
    });

    it('reports the setting a person turned off, while the subsystem is still up', async () => {
      const { configManager } = await import('../../services/core/config-manager.js');
      configManager.set('scheduler', { ...configManager.get('scheduler')!, enabled: false });
      configManager.set('relay', { ...configManager.get('relay')!, enabled: false });

      const res = await request(server).get('/api/config').expect(200);

      // `enabled` answers for the running process, which nothing has restarted.
      expect(res.body.tasks.enabledInConfig).toBe(false);
      expect(res.body.relay.enabledInConfig).toBe(false);
      expect(typeof res.body.tasks.enabled).toBe('boolean');
      expect(typeof res.body.relay.enabled).toBe('boolean');
    });

    it('round-trips a PATCH, so the switch can persist what it shows', async () => {
      // Seeded off the default on purpose: asserting the shipped `1` survives
      // would also pass if the patch had replaced the whole block with defaults,
      // which is precisely the failure this line is here to catch.
      const { configManager } = await import('../../services/core/config-manager.js');
      configManager.set('scheduler', { ...configManager.get('scheduler')!, maxConcurrentRuns: 5 });

      await request(server)
        .patch('/api/config')
        .send({ scheduler: { enabled: false }, relay: { enabled: false } })
        .expect(200);

      const res = await request(server).get('/api/config').expect(200);

      expect(res.body.tasks.enabledInConfig).toBe(false);
      expect(res.body.relay.enabledInConfig).toBe(false);
      // The deep merge leaves the rest of the scheduler block intact.
      expect(res.body.scheduler.maxConcurrentRuns).toBe(5);
    });
  });

  // Settings owns ONE of these three: the on/off switch. The two numbers go out
  // with it so the switch's own sentence can state the threshold actually in
  // force rather than the shipped default, the same reason the `rooms` block
  // carries its ceilings (spec team-room-home D5.2, task 4.3).
  describe('welcomeBack — what agents may say when you come back', () => {
    it('reports the shipped values when nobody has changed them', async () => {
      const res = await request(server).get('/api/config').expect(200);

      expect(res.body.welcomeBack).toEqual({
        enabled: true,
        absenceThresholdMinutes: 240,
        maxPosts: 3,
      });
    });

    it('reports what an operator actually set', async () => {
      const { configManager } = await import('../../services/core/config-manager.js');
      configManager.set('welcomeBack', {
        ...configManager.get('welcomeBack')!,
        enabled: false,
        absenceThresholdMinutes: 720,
      });

      const res = await request(server).get('/api/config').expect(200);

      expect(res.body.welcomeBack).toEqual({
        enabled: false,
        absenceThresholdMinutes: 720,
        maxPosts: 3,
      });
    });

    it('round-trips the switch through PATCH, leaving the numbers alone', async () => {
      const { configManager } = await import('../../services/core/config-manager.js');
      configManager.set('welcomeBack', {
        ...configManager.get('welcomeBack')!,
        maxPosts: 1,
      });

      await request(server)
        .patch('/api/config')
        .send({ welcomeBack: { enabled: false } })
        .expect(200);

      const res = await request(server).get('/api/config').expect(200);

      expect(res.body.welcomeBack.enabled).toBe(false);
      expect(res.body.welcomeBack.maxPosts).toBe(1);
    });

    it('carries the three welcomeBack fields and nothing else', async () => {
      const res = await request(server).get('/api/config').expect(200);

      expect(Object.keys(res.body.welcomeBack).sort()).toEqual([
        'absenceThresholdMinutes',
        'enabled',
        'maxPosts',
      ]);
    });
  });

  // The env vars beat the setting, so the tab must be told to stop offering the
  // switch rather than write a value the server will ignore. Read at module
  // load, hence the fresh import.
  describe('tasks/relay — lockedByEnv', () => {
    const ORIGINAL_TASKS = process.env.DORKOS_TASKS_ENABLED;
    const ORIGINAL_RELAY = process.env.DORKOS_RELAY_ENABLED;

    afterEach(() => {
      if (ORIGINAL_TASKS === undefined) delete process.env.DORKOS_TASKS_ENABLED;
      else process.env.DORKOS_TASKS_ENABLED = ORIGINAL_TASKS;
      if (ORIGINAL_RELAY === undefined) delete process.env.DORKOS_RELAY_ENABLED;
      else process.env.DORKOS_RELAY_ENABLED = ORIGINAL_RELAY;
    });

    it('flags each subsystem whose environment variable is set, whatever its value', async () => {
      // `false` on purpose: presence is the question, because that is what
      // `index.ts` branches on.
      process.env.DORKOS_TASKS_ENABLED = 'false';
      process.env.DORKOS_RELAY_ENABLED = 'true';
      vi.resetModules();

      const { initConfigManager } = await import('../../services/core/config-manager.js');
      initConfigManager(tmpDir);
      const configRouter = (await import('../config.js')).default;
      await registerDeclaringRuntimes();
      const app = express();
      app.use(express.json());
      mountCallerFixture(app);
      app.use('/api/config', configRouter);
      target.mount(app);

      const res = await request(server).get('/api/config').expect(200);

      expect(res.body.tasks.lockedByEnv).toBe(true);
      expect(res.body.relay.lockedByEnv).toBe(true);
    });

    it('flags only the one whose variable is set, leaving the other switchable', async () => {
      // The two are read independently, and a lock reported on both would take
      // away a switch the person can still use.
      process.env.DORKOS_RELAY_ENABLED = 'true';
      delete process.env.DORKOS_TASKS_ENABLED;
      vi.resetModules();

      const { initConfigManager } = await import('../../services/core/config-manager.js');
      initConfigManager(tmpDir);
      const configRouter = (await import('../config.js')).default;
      await registerDeclaringRuntimes();
      const app = express();
      app.use(express.json());
      mountCallerFixture(app);
      app.use('/api/config', configRouter);
      target.mount(app);

      const res = await request(server).get('/api/config').expect(200);

      expect(res.body.relay.lockedByEnv).toBe(true);
      expect(res.body.tasks.lockedByEnv).toBe(false);
    });
  });

  // The cockpit shows a person where a new agent will live and probes that path
  // for a conflict, so the reported directory has to be the one the server will
  // actually create in — the stored `~/.dork/agents` is not it once `DORK_HOME`
  // points somewhere else, which is the whole of DOR-662.
  it('reports agents.defaultDirectory resolved against DORK_HOME, not the home dir', async () => {
    const res = await request(server).get('/api/config').expect(200);

    expect(res.body.agents.defaultDirectory).toBe(path.join(tmpDir, 'agents'));
    expect(res.body.agents.defaultDirectory).not.toContain('~');
    expect(res.body.agents.defaultAgent).toBe('dorkbot');
  });

  // The cockpit cannot see the server process's `CLAUDE_CONFIG_DIR`, so if GET did
  // not resolve the active Claude account the account switcher could only show an
  // empty field where the effective default belongs (spec claude-code-accounts,
  // acceptance criterion 8).
  describe('claudeCode — which Claude account new work runs on', () => {
    const ORIGINAL_ENV = process.env.CLAUDE_CONFIG_DIR;

    afterEach(() => {
      if (ORIGINAL_ENV === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_ENV;
    });

    it('reports the inherited environment as the resolved account', async () => {
      process.env.CLAUDE_CONFIG_DIR = '/tmp/inherited-claude';

      const res = await request(server).get('/api/config').expect(200);

      expect(res.body.claudeCode).toEqual({
        resolvedAccount: '/tmp/inherited-claude',
        inherited: true,
        accounts: [],
      });
    });

    it('reports a chosen account, its roster, and which of them it can find', async () => {
      const real = path.join(tmpDir, 'claude2');
      fs.mkdirSync(path.join(real, 'projects'), { recursive: true });
      const missing = path.join(tmpDir, 'gone');
      process.env.CLAUDE_CONFIG_DIR = '/tmp/inherited-claude';
      const { configManager } = await import('../../services/core/config-manager.js');
      configManager.set('runtimes', {
        ...configManager.get('runtimes'),
        claudeCode: {
          activeAccount: real,
          accounts: [
            { path: real, label: 'Acme Corp' },
            { path: missing, label: null },
          ],
          defaultModel: null,
          defaultEffort: null,
          defaultTrustStop: null,
        },
      });

      const res = await request(server).get('/api/config').expect(200);

      // The chosen account wins over the inherited env var, and the roster says
      // honestly which entries no longer resolve.
      expect(res.body.claudeCode).toEqual({
        resolvedAccount: real,
        inherited: false,
        accounts: [
          { path: real, label: 'Acme Corp', isAccountRoot: true },
          { path: missing, label: null, isAccountRoot: false },
        ],
      });
    });

    it('does not widen the runtimes id list, which other readers treat as flat ids', async () => {
      const res = await request(server).get('/api/config').expect(200);

      expect(res.body.runtimes).toEqual(['claude-code', 'codex', 'opencode']);
    });
  });

  it('reports a directory the person configured as their own, tilde expanded', async () => {
    const { configManager } = await import('../../services/core/config-manager.js');
    configManager.set('agents', { defaultDirectory: '~/work/agents', defaultAgent: 'dorkbot' });

    const res = await request(server).get('/api/config').expect(200);

    expect(res.body.agents.defaultDirectory).toBe('/Users/test-user/work/agents');
  });

  // ── The invariant that makes shipping a RESOLVED value out of GET safe ──────
  //
  // GET reports `agents.defaultDirectory` resolved, while the store keeps the
  // portable `~/.dork/agents` spelling. That split is only safe while nothing
  // round-trips the reported value back into the store: persisting the absolute
  // form would pin the config to one machine's home, and in a dev tree would
  // bake the scratch directory in permanently, so a later `DORK_HOME` change
  // would be silently ignored. No caller does that today — these two fence it
  // so it stays that way rather than holding by absence.
  it('does not persist the resolved directory when a patch touches other config', async () => {
    const { configManager } = await import('../../services/core/config-manager.js');
    const get = await request(server).get('/api/config').expect(200);
    expect(get.body.agents.defaultDirectory).toBe(path.join(tmpDir, 'agents'));

    await request(server)
      .patch('/api/config')
      .send({ ui: { theme: 'dark' } })
      .expect(200);

    expect(configManager.get('agents').defaultDirectory).toBe('~/.dork/agents');
  });

  it('does not persist the resolved directory when the default agent changes', async () => {
    const { configManager } = await import('../../services/core/config-manager.js');
    await request(server).get('/api/config').expect(200);

    await request(server)
      .put('/api/config/agents/defaultAgent')
      .send({ value: 'scout' })
      .expect(200);

    expect(configManager.get('agents')).toEqual({
      defaultDirectory: '~/.dork/agents',
      defaultAgent: 'scout',
    });
  });

  it('includes ui.sidebar organization prefs (DOR-329)', async () => {
    const res = await request(server).get('/api/config').expect(200);

    expect(res.body.ui.sidebar).toBeDefined();
    expect(Array.isArray(res.body.ui.sidebar.pinned)).toBe(true);
    expect(Array.isArray(res.body.ui.sidebar.groups)).toBe(true);
    expect(res.body.ui.sidebar.ungroupedSortMode).toBe('name');
  });

  it('includes ui.shapes state (DOR-355)', async () => {
    const res = await request(server).get('/api/config').expect(200);

    expect(res.body.ui.shapes).toBeDefined();
    expect(res.body.ui.shapes.active).toBeNull();
    expect(res.body.ui.shapes.agentDefaults).toEqual({});
    expect(res.body.ui.shapes.autoFollowAgent).toBe(false);
  });

  it('includes ui.statusBar pins, nothing pinned by default (DOR-431, DOR-452)', async () => {
    const res = await request(server).get('/api/config').expect(200);

    expect(res.body.ui.statusBar).toBeDefined();
    expect(res.body.ui.statusBar).toEqual({ pins: [] });
  });

  it('includes the standing Full-autonomy acknowledgement, unset by default', async () => {
    const res = await request(server).get('/api/config').expect(200);

    expect(res.body.ui.autonomyAcknowledgedAt).toBeNull();
  });

  it('records the standing acknowledgement, and reads it back on the next GET', async () => {
    // The round trip the cockpit relies on: the dialog's "don't show this again"
    // writes here, and every later autonomy PATCH is answered from this read.
    const acknowledgedAt = '2026-08-01T09:30:00.000Z';
    await request(server)
      .patch('/api/config')
      .send({ ui: { autonomyAcknowledgedAt: acknowledgedAt } })
      .expect(200);

    const res = await request(server).get('/api/config').expect(200);
    expect(res.body.ui.autonomyAcknowledgedAt).toBe(acknowledgedAt);
  });

  it('refuses Full autonomy as a default until the person has acknowledged it', async () => {
    // The set-time door (spec `trust-dial`, decision 6). Making autonomy the
    // stop new sessions START at is a wider claim than putting one session
    // there — durable, and a session born from it opens already bypassed with
    // no dialog to show — so the asking happens at the moment of choosing.
    const res = await request(server)
      .patch('/api/config')
      .send({ runtimes: { defaultTrustStop: 'autonomy' } })
      .expect(428);

    expect(res.body.code).toBe('AUTONOMY_ACK_REQUIRED');
    expect(res.body.paths).toEqual(['runtimes.defaultTrustStop']);

    // A refusal changes nothing.
    const after = await request(server).get('/api/config').expect(200);
    expect(after.body.executionDefaults.trustStop).toBeNull();
  });

  it('refuses a per-runtime autonomy default the same way, naming the leaf', async () => {
    const res = await request(server)
      .patch('/api/config')
      .send({ runtimes: { codex: { defaultTrustStop: 'autonomy' } } })
      .expect(428);

    expect(res.body.paths).toEqual(['runtimes.codex.defaultTrustStop']);
  });

  it('lets the gentler stops through with no ritual at all', async () => {
    // Only the stop a person cannot walk back asks twice. A dialog in front of
    // "ask me first" is how people learn to click through the one that matters.
    await request(server)
      .patch('/api/config')
      .send({ runtimes: { defaultTrustStop: 'act', claudeCode: { defaultTrustStop: 'ask' } } })
      .expect(200);

    const res = await request(server).get('/api/config').expect(200);
    expect(res.body.executionDefaults.trustStop).toBe('act');
    expect(
      res.body.executionDefaults.perRuntime.find(
        (e: { runtime: string }) => e.runtime === 'claude-code'
      ).trustStop
    ).toBe('ask');
  });

  it('accepts autonomy when the acknowledgement rides the SAME patch', async () => {
    // What the Settings dialog sends: the consent record and the new default in
    // one write, so there is no window where the stop landed without the consent
    // and no two-request ordering for a client to get wrong.
    await request(server)
      .patch('/api/config')
      .send({
        ui: { autonomyAcknowledgedAt: '2026-08-01T09:30:00.000Z' },
        runtimes: { defaultTrustStop: 'autonomy' },
      })
      .expect(200);

    const res = await request(server).get('/api/config').expect(200);
    expect(res.body.executionDefaults.trustStop).toBe('autonomy');
  });

  it('accepts autonomy on a standing acknowledgement given earlier', async () => {
    await request(server)
      .patch('/api/config')
      .send({ ui: { autonomyAcknowledgedAt: '2026-08-01T09:30:00.000Z' } })
      .expect(200);

    await request(server)
      .patch('/api/config')
      .send({ runtimes: { defaultTrustStop: 'autonomy' } })
      .expect(200);
  });

  it('starts refusing again the moment the acknowledgement is cleared', async () => {
    await request(server)
      .patch('/api/config')
      .send({ ui: { autonomyAcknowledgedAt: '2026-08-01T09:30:00.000Z' } })
      .expect(200);
    await request(server)
      .patch('/api/config')
      .send({ ui: { autonomyAcknowledgedAt: null } });

    await request(server)
      .patch('/api/config')
      .send({ runtimes: { defaultTrustStop: 'autonomy' } })
      .expect(428);
  });

  it('demotes a standing autonomy default when the acknowledgement is cleared', async () => {
    // The record is that default's LICENCE (spec `trust-dial`, decision 6), so a
    // Reset that left the default standing would keep birthing bypassed sessions
    // with no consent on file — and the cockpit's first mode change for one of
    // them would 428 against a door the person believed they had re-armed.
    await request(server)
      .patch('/api/config')
      .send({
        ui: { autonomyAcknowledgedAt: '2026-08-01T09:30:00.000Z' },
        runtimes: { defaultTrustStop: 'autonomy', codex: { defaultTrustStop: 'autonomy' } },
      })
      .expect(200);

    await request(server)
      .patch('/api/config')
      .send({ ui: { autonomyAcknowledgedAt: null } })
      .expect(200);

    const res = await request(server).get('/api/config').expect(200);
    expect(res.body.ui.autonomyAcknowledgedAt).toBeNull();
    expect(res.body.executionDefaults.trustStop).toBeNull();
    expect(
      res.body.executionDefaults.perRuntime.find((e: { runtime: string }) => e.runtime === 'codex')
        .trustStop
    ).toBeNull();
  });

  it('leaves the gentler standing defaults alone when the acknowledgement is cleared', async () => {
    // Only the stop whose justification was the record goes. "Act" needed no
    // acknowledgement, so a Reset has nothing to say about it.
    await request(server)
      .patch('/api/config')
      .send({
        ui: { autonomyAcknowledgedAt: '2026-08-01T09:30:00.000Z' },
        runtimes: { defaultTrustStop: 'act', codex: { defaultTrustStop: 'ask' } },
      })
      .expect(200);

    await request(server)
      .patch('/api/config')
      .send({ ui: { autonomyAcknowledgedAt: null } });

    const res = await request(server).get('/api/config').expect(200);
    expect(res.body.executionDefaults.trustStop).toBe('act');
    expect(
      res.body.executionDefaults.perRuntime.find((e: { runtime: string }) => e.runtime === 'codex')
        .trustStop
    ).toBe('ask');
  });

  it('answers a patch that clears the record AND asks for autonomy with the clear', async () => {
    await request(server)
      .patch('/api/config')
      .send({ ui: { autonomyAcknowledgedAt: '2026-08-01T09:30:00.000Z' } })
      .expect(200);

    // Contradictory, and not argued with: the clear wins and the stop lands null.
    await request(server)
      .patch('/api/config')
      .send({
        ui: { autonomyAcknowledgedAt: null },
        runtimes: { defaultTrustStop: 'autonomy' },
      })
      .expect(200);

    const res = await request(server).get('/api/config').expect(200);
    expect(res.body.ui.autonomyAcknowledgedAt).toBeNull();
    expect(res.body.executionDefaults.trustStop).toBeNull();
  });

  it('touches nothing when a patch says nothing about the acknowledgement', async () => {
    await request(server)
      .patch('/api/config')
      .send({
        ui: { autonomyAcknowledgedAt: '2026-08-01T09:30:00.000Z' },
        runtimes: { defaultTrustStop: 'autonomy' },
      })
      .expect(200);

    await request(server)
      .patch('/api/config')
      .send({ logging: { level: 'debug' } })
      .expect(200);

    const res = await request(server).get('/api/config').expect(200);
    expect(res.body.executionDefaults.trustStop).toBe('autonomy');
  });

  it('lets Settings clear the acknowledgement, which brings the dialog back', async () => {
    await request(server)
      .patch('/api/config')
      .send({ ui: { autonomyAcknowledgedAt: '2026-08-01T09:30:00.000Z' } })
      .expect(200);

    await request(server)
      .patch('/api/config')
      .send({ ui: { autonomyAcknowledgedAt: null } });

    const res = await request(server).get('/api/config').expect(200);
    expect(res.body.ui.autonomyAcknowledgedAt).toBeNull();
  });
});

describe('PUT /api/config/agents/defaultAgent', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = createTempDir();
    process.env.DORK_HOME = tmpDir;

    const { initConfigManager } = await import('../../services/core/config-manager.js');
    initConfigManager(tmpDir);

    const configRouter = (await import('../config.js')).default;
    const app = express();
    app.use(express.json());
    mountCallerFixture(app);
    app.use('/api/config', configRouter);
    target.mount(app);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('sets the default agent and returns success', async () => {
    const res = await request(server)
      .put('/api/config/agents/defaultAgent')
      .send({ value: 'my-agent' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.defaultAgent).toBe('my-agent');
  });

  it('persists the default agent in config', async () => {
    await request(server)
      .put('/api/config/agents/defaultAgent')
      .send({ value: 'my-agent' })
      .expect(200);

    const { configManager } = await import('../../services/core/config-manager.js');
    expect(configManager.get('agents')?.defaultAgent).toBe('my-agent');
  });

  it('returns 400 when value is missing', async () => {
    const res = await request(server).put('/api/config/agents/defaultAgent').send({}).expect(400);

    expect(res.body.error).toContain('non-empty');
  });

  it('returns 400 when value is empty string', async () => {
    const res = await request(server)
      .put('/api/config/agents/defaultAgent')
      .send({ value: '  ' })
      .expect(400);

    expect(res.body.error).toContain('non-empty');
  });

  it('returns 400 when value is not a string', async () => {
    const res = await request(server)
      .put('/api/config/agents/defaultAgent')
      .send({ value: 123 })
      .expect(400);

    expect(res.body.error).toContain('non-empty');
  });

  it('trims whitespace from agent name', async () => {
    const res = await request(server)
      .put('/api/config/agents/defaultAgent')
      .send({ value: '  my-agent  ' })
      .expect(200);

    expect(res.body.defaultAgent).toBe('my-agent');
  });
});
