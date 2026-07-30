import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
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
 * Stands in for `sessionGate`'s resolved user. `PATCH /api/config` now skips the
 * operator-only write policy only for a caller that may DECIDE approvals, and
 * with login ON that requires an authenticated user on `res.locals` — which the
 * real cockpit carries and a bare test app otherwise would not (DOR-467).
 */
let signedInUser: { userId: string; credential: 'cookie' | 'api-key' } | undefined;

/** Stands in for the `X-DorkOS-Agent` header an agent's CLI attaches. */
let agentHeader: string | undefined;

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
  let app: express.Express;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = createTempDir();
    process.env.DORK_HOME = tmpDir;

    // Initialize config manager before importing routes
    const { initConfigManager } = await import('../../services/core/config-manager.js');
    initConfigManager(tmpDir);

    const configRouter = (await import('../config.js')).default;
    app = express();
    app.use(express.json());
    mountCallerFixture(app);
    app.use('/api/config', configRouter);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('returns 200 with merged config for valid partial update', async () => {
    const response = await request(app)
      .patch('/api/config')
      .send({ ui: { theme: 'dark' } })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.config.ui.theme).toBe('dark');
    // Other values should remain default
    expect(response.body.config.server.port).toBe(4242);
  });

  it('returns 400 with Zod errors for invalid port value', async () => {
    const response = await request(app)
      .patch('/api/config')
      .send({ server: { port: 80 } })
      .expect(400);

    expect(response.body.error).toBe('Validation failed');
    expect(response.body.details).toBeDefined();
    expect(response.body.details.length).toBeGreaterThan(0);
    expect(response.body.details[0]).toContain('server.port');
  });

  it('includes warning for sensitive key', async () => {
    const response = await request(app)
      .patch('/api/config')
      .send({ tunnel: { authtoken: 'my-secret-token' } })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.warnings).toBeDefined();
    expect(response.body.warnings[0]).toContain('sensitive data');
  });

  it('includes warning for the sensitive cloud.instanceToken key', async () => {
    const response = await request(app)
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
    const response = await request(app).patch('/api/config').send({}).expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.config.server.port).toBe(4242);
  });

  it('returns 400 for array body', async () => {
    const response = await request(app)
      .patch('/api/config')
      .send([{ server: { port: 5000 } }])
      .expect(400);

    expect(response.body.error).toContain('JSON object');
  });

  it('persists changes across reads', async () => {
    await request(app)
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

    const enabled = await request(app)
      .patch('/api/config')
      .send({ auth: { enabled: true } })
      .expect(200);
    expect(enabled.body.success).toBe(true);
    expect(enabled.body.config.auth.enabled).toBe(true);
    expect(configManager.getDot('auth.enabled')).toBe(true);

    const disabled = await request(app)
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

    const refused = await request(app)
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

    await request(app)
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

      const refused = await request(app)
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

      const refused = await request(app)
        .patch('/api/config')
        .send({ approvals: { standingGrants: true } })
        .expect(403);
      expect(refused.body.code).toBe('operator_cookie_required');
    });

    it('refuses everyone while login is off, and says why', async () => {
      const { configManager } = await import('../../services/core/config-manager.js');
      configManager.set('auth', { enabled: false });
      signedInUser = { userId: 'user_cockpit', credential: 'cookie' };

      const refused = await request(app)
        .patch('/api/config')
        .send({ approvals: { standingGrants: true } })
        .expect(403);
      expect(refused.body.code).toBe('standing_grants_require_login');
      expect(refused.body.message).toMatch(/Require login/);
    });

    it('catches a patch that stops short of the leaf', async () => {
      await enableLogin();
      signedInUser = undefined;

      const refused = await request(app).patch('/api/config').send({ approvals: {} }).expect(403);
      expect(refused.body.code).toBe('operator_cookie_required');
    });

    it('lets a person signed in to the cockpit change them', async () => {
      await enableLogin();
      signedInUser = { userId: 'user_cockpit', credential: 'cookie' };

      const ok = await request(app)
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

      await request(app)
        .patch('/api/config')
        .send([{ approvals: { standingGrants: true } }])
        .expect(400);

      const { configManager } = await import('../../services/core/config-manager.js');
      expect(configManager.getDot('approvals.standingGrants')).toBe(false);
    });

    it('refuses a window longer than a day, so "forever" stays unrepresentable', async () => {
      await enableLogin();
      signedInUser = { userId: 'user_cockpit', credential: 'cookie' };

      await request(app)
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

      const refused = await request(app)
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
        const refused = await request(app).patch('/api/config').send(patch).expect(403);
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

      const ok = await request(app)
        .patch('/api/config')
        .send({ ui: { theme: 'dark' } })
        .expect(200);
      expect(ok.body.config.ui.theme).toBe('dark');
    });

    it('lets the person in the cockpit through', async () => {
      await enableLogin();
      signedInUser = { userId: 'user_cockpit', credential: 'cookie' };

      const ok = await request(app)
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

      const refused = await request(app)
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

      const ok = await request(app)
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

    const ok = await request(app)
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

    const ok = await request(app)
      .patch('/api/config')
      .send({ ui: { theme: 'dark' } })
      .expect(200);
    expect(ok.body.config.ui.theme).toBe('dark');
  });

  it('lets a person change the other operator-only settings too', async () => {
    // The rest of the write allowlist, proven not to have leaked onto the human
    // path: exposure, the MCP endpoint's key, telemetry consent, and the boundary.
    const response = await request(app)
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
    const response = await request(app)
      .patch('/api/config')
      .send({ ui: { theme: 'invalid-theme' } })
      .expect(400);

    expect(response.body.error).toBe('Validation failed');
  });

  it('deep merges nested config objects', async () => {
    // First set port to 5000
    await request(app)
      .patch('/api/config')
      .send({ server: { port: 5000 } })
      .expect(200);

    // Then set cwd, port should remain 5000
    const response = await request(app)
      .patch('/api/config')
      .send({ server: { cwd: '/test' } })
      .expect(200);

    expect(response.body.config.server.port).toBe(5000);
    expect(response.body.config.server.cwd).toBe('/test');
  });

  it('warns for multiple sensitive keys', async () => {
    const response = await request(app)
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
    const response = await request(app)
      .patch('/api/config')
      .send({ server: { port: 70000 } })
      .expect(400);

    expect(response.body.error).toBe('Validation failed');
  });
});

describe('GET /api/config', () => {
  let app: express.Express;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = createTempDir();
    process.env.DORK_HOME = tmpDir;

    const { initConfigManager } = await import('../../services/core/config-manager.js');
    initConfigManager(tmpDir);

    const configRouter = (await import('../config.js')).default;
    app = express();
    app.use(express.json());
    mountCallerFixture(app);
    app.use('/api/config', configRouter);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('includes boundary field in response', async () => {
    const res = await request(app).get('/api/config');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('boundary');
    expect(typeof res.body.boundary).toBe('string');
    expect(res.body.boundary).toBe('/Users/test-user');
  });

  it('includes existing config fields alongside boundary', async () => {
    const res = await request(app).get('/api/config').expect(200);

    expect(res.body).toHaveProperty('version');
    expect(res.body).toHaveProperty('workingDirectory');
    expect(res.body).toHaveProperty('boundary');
    expect(res.body).toHaveProperty('tunnel');
    expect(res.body).toHaveProperty('tasks');
    expect(res.body).toHaveProperty('relay');
    expect(res.body).toHaveProperty('mesh');
  });

  // The cockpit prints these two numbers inside the sentence that describes the
  // `engaged` response mode — "keeps answering for 10 more minutes or 5 more
  // messages". They are settings, so the sentence is only true if the cockpit
  // reads the numbers actually in force rather than the shipped defaults.
  describe('rooms — the engaged-window numbers the cockpit says out loud', () => {
    it('reports the shipped ceilings when nobody has changed them', async () => {
      const res = await request(app).get('/api/config').expect(200);

      expect(res.body.rooms).toEqual({ engagedWindowMinutes: 10, engagedWindowPosts: 5 });
    });

    it('reports what an operator actually set, not what ships', async () => {
      const { configManager } = await import('../../services/core/config-manager.js');
      configManager.set('rooms', {
        ...configManager.get('rooms')!,
        engagedWindowMinutes: 3,
        engagedWindowPosts: 2,
      });

      const res = await request(app).get('/api/config').expect(200);

      expect(res.body.rooms).toEqual({ engagedWindowMinutes: 3, engagedWindowPosts: 2 });
    });

    it('carries the two ceilings and nothing else out of the rooms block', async () => {
      // The rest of `rooms` is turn budgets and reply waits — real settings the
      // cockpit never states out loud. Widening this to the whole block would
      // put an operator's spend limits on a wire that did not need them.
      const res = await request(app).get('/api/config').expect(200);

      expect(Object.keys(res.body.rooms).sort()).toEqual([
        'engagedWindowMinutes',
        'engagedWindowPosts',
      ]);
    });
  });

  // The cockpit shows a person where a new agent will live and probes that path
  // for a conflict, so the reported directory has to be the one the server will
  // actually create in — the stored `~/.dork/agents` is not it once `DORK_HOME`
  // points somewhere else, which is the whole of DOR-662.
  it('reports agents.defaultDirectory resolved against DORK_HOME, not the home dir', async () => {
    const res = await request(app).get('/api/config').expect(200);

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

      const res = await request(app).get('/api/config').expect(200);

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
        },
      });

      const res = await request(app).get('/api/config').expect(200);

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
      const res = await request(app).get('/api/config').expect(200);

      expect(res.body.runtimes).toEqual(['claude-code', 'codex', 'opencode']);
    });
  });

  it('reports a directory the person configured as their own, tilde expanded', async () => {
    const { configManager } = await import('../../services/core/config-manager.js');
    configManager.set('agents', { defaultDirectory: '~/work/agents', defaultAgent: 'dorkbot' });

    const res = await request(app).get('/api/config').expect(200);

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
    const get = await request(app).get('/api/config').expect(200);
    expect(get.body.agents.defaultDirectory).toBe(path.join(tmpDir, 'agents'));

    await request(app)
      .patch('/api/config')
      .send({ ui: { theme: 'dark' } })
      .expect(200);

    expect(configManager.get('agents').defaultDirectory).toBe('~/.dork/agents');
  });

  it('does not persist the resolved directory when the default agent changes', async () => {
    const { configManager } = await import('../../services/core/config-manager.js');
    await request(app).get('/api/config').expect(200);

    await request(app).put('/api/config/agents/defaultAgent').send({ value: 'scout' }).expect(200);

    expect(configManager.get('agents')).toEqual({
      defaultDirectory: '~/.dork/agents',
      defaultAgent: 'scout',
    });
  });

  it('includes ui.sidebar organization prefs (DOR-329)', async () => {
    const res = await request(app).get('/api/config').expect(200);

    expect(res.body.ui.sidebar).toBeDefined();
    expect(Array.isArray(res.body.ui.sidebar.pinned)).toBe(true);
    expect(Array.isArray(res.body.ui.sidebar.groups)).toBe(true);
    expect(res.body.ui.sidebar.ungroupedSortMode).toBe('name');
  });

  it('includes ui.shapes state (DOR-355)', async () => {
    const res = await request(app).get('/api/config').expect(200);

    expect(res.body.ui.shapes).toBeDefined();
    expect(res.body.ui.shapes.active).toBeNull();
    expect(res.body.ui.shapes.agentDefaults).toEqual({});
    expect(res.body.ui.shapes.autoFollowAgent).toBe(false);
  });

  it('includes ui.statusBar pins, nothing pinned by default (DOR-431, DOR-452)', async () => {
    const res = await request(app).get('/api/config').expect(200);

    expect(res.body.ui.statusBar).toBeDefined();
    expect(res.body.ui.statusBar).toEqual({ pins: [] });
  });
});

describe('PUT /api/config/agents/defaultAgent', () => {
  let app: express.Express;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = createTempDir();
    process.env.DORK_HOME = tmpDir;

    const { initConfigManager } = await import('../../services/core/config-manager.js');
    initConfigManager(tmpDir);

    const configRouter = (await import('../config.js')).default;
    app = express();
    app.use(express.json());
    mountCallerFixture(app);
    app.use('/api/config', configRouter);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('sets the default agent and returns success', async () => {
    const res = await request(app)
      .put('/api/config/agents/defaultAgent')
      .send({ value: 'my-agent' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.defaultAgent).toBe('my-agent');
  });

  it('persists the default agent in config', async () => {
    await request(app)
      .put('/api/config/agents/defaultAgent')
      .send({ value: 'my-agent' })
      .expect(200);

    const { configManager } = await import('../../services/core/config-manager.js');
    expect(configManager.get('agents')?.defaultAgent).toBe('my-agent');
  });

  it('returns 400 when value is missing', async () => {
    const res = await request(app).put('/api/config/agents/defaultAgent').send({}).expect(400);

    expect(res.body.error).toContain('non-empty');
  });

  it('returns 400 when value is empty string', async () => {
    const res = await request(app)
      .put('/api/config/agents/defaultAgent')
      .send({ value: '  ' })
      .expect(400);

    expect(res.body.error).toContain('non-empty');
  });

  it('returns 400 when value is not a string', async () => {
    const res = await request(app)
      .put('/api/config/agents/defaultAgent')
      .send({ value: 123 })
      .expect(400);

    expect(res.body.error).toContain('non-empty');
  });

  it('trims whitespace from agent name', async () => {
    const res = await request(app)
      .put('/api/config/agents/defaultAgent')
      .send({ value: '  my-agent  ' })
      .expect(200);

    expect(res.body.defaultAgent).toBe('my-agent');
  });
});
