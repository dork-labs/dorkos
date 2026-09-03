import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ROOM_TURN_LIMIT_DEFAULTS } from '@dorkos/shared/config-schema';

// Mock tunnel-manager and agent-manager to avoid side effects
vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null },
  },
}));

vi.mock('../../services/runtimes/claude-code/sdk/sdk-utils.js', () => ({
  resolveClaudeCliPath: () => '/usr/local/bin/claude',
  createHeldUserPrompt: vi.fn(() => ({
    prompt: (async function* () {})(),
    close: vi.fn(),
    push: vi.fn(),
  })),
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

/**
 * A fresh install is BUILT here, not inherited: this file runs with
 * `DORKOS_TASKS_ENABLED` and `DORKOS_RELAY_ENABLED` absent, whatever the
 * developer's shell exports.
 *
 * `routes/config.ts` reads both at MODULE LOAD to answer `lockedByEnv`, and the
 * question it asks is PRESENCE, not value — `index.ts` branches the same way, so
 * `DORKOS_RELAY_ENABLED=false` is still a lock. Left inherited, every assertion
 * about an unlocked subsystem measured the machine instead of the route: the
 * pre-push gate runs the suite through `dotenv`, so a developer whose `.env`
 * sets either flag got a red on every push for a lock unrelated to their change,
 * while CI — which loads no `.env` — stayed green. That is a gate people learn
 * to bypass, and two did (DOR-1086).
 *
 * Deleted rather than assigned, because assigning `'false'` would swap one piece
 * of ambient state for another and report a lock. The `lockedByEnv` block sets
 * them deliberately for the positive half and restores this baseline after.
 *
 * Module scope, so it lands before the first `beforeEach` imports the router.
 * Vitest gives each test FILE its own process, so nothing outside this file sees
 * it; `afterAll` restores anyway rather than leaving that to the pool's shape.
 */
const AMBIENT_TASKS_ENABLED = process.env.DORKOS_TASKS_ENABLED;
const AMBIENT_RELAY_ENABLED = process.env.DORKOS_RELAY_ENABLED;
// `DORKOS_A2A_ENABLED` joins them for the same reason (DOR-1304): the
// `experiments` block reports the A2A entry as `lockedByEnv` on presence, so a
// developer whose shell exports it would otherwise red every unlocked assertion.
const AMBIENT_A2A_ENABLED = process.env.DORKOS_A2A_ENABLED;
delete process.env.DORKOS_TASKS_ENABLED;
delete process.env.DORKOS_RELAY_ENABLED;
delete process.env.DORKOS_A2A_ENABLED;

afterAll(() => {
  if (AMBIENT_TASKS_ENABLED !== undefined) process.env.DORKOS_TASKS_ENABLED = AMBIENT_TASKS_ENABLED;
  if (AMBIENT_RELAY_ENABLED !== undefined) process.env.DORKOS_RELAY_ENABLED = AMBIENT_RELAY_ENABLED;
  if (AMBIENT_A2A_ENABLED !== undefined) process.env.DORKOS_A2A_ENABLED = AMBIENT_A2A_ENABLED;
});

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

  describe('settings a config wipe refuses to reverse (DOR-1497)', () => {
    // The reproduction, kept as the test. Every leaf below is on
    // `PROTECTIVE_CARRYOVERS`: recovery from a corrupt config carries the
    // person's value across rather than landing on the shipped default, because
    // a wipe may lose a preference and must never lose a protection. The
    // original nine were `agent-writable` anyway — so the ACCIDENT was refused
    // and the DELIBERATE write by an agent was not. Measured before the fix:
    // every one of these returned 200 and the stored protective value was
    // gone. `uploads.allowedTypes` joined the ten as DOR-1505's fix, the same
    // way and for the same reason.
    //
    // Each case is driven through the real route with the real header, and each
    // asserts the STORE as well as the status: a refusal that still wrote would
    // pass a status-only test.
    //
    // The ten share ONE test per direction rather than getting a case each.
    // That is a memory decision, not a style one: every test in this file mints
    // a fresh app, a fresh config directory and a fresh module graph
    // (`vi.resetModules()`), and twenty more of those took the worker past the
    // heap limit — a `FATAL ERROR: JavaScript heap out of memory` that reads
    // like a hang rather than a failure. Each leaf still carries its own
    // assertion message, so a red names the leaf that broke.

    /** One leaf, the value a person tightened it to, and the write an agent tried. */
    const carried: Array<{
      path: string;
      protective: unknown;
      agentWants: unknown;
      patch: object;
    }> = [
      {
        path: 'runtimes.claudeCode.persistentSession',
        protective: false,
        agentWants: true,
        patch: { runtimes: { claudeCode: { persistentSession: true } } },
      },
      {
        path: 'agentContext.relayTools',
        protective: false,
        agentWants: true,
        patch: { agentContext: { relayTools: true } },
      },
      {
        path: 'agentContext.meshTools',
        protective: false,
        agentWants: true,
        patch: { agentContext: { meshTools: true } },
      },
      {
        path: 'agentContext.adapterTools',
        protective: false,
        agentWants: true,
        patch: { agentContext: { adapterTools: true } },
      },
      {
        path: 'agentContext.tasksTools',
        protective: false,
        agentWants: true,
        patch: { agentContext: { tasksTools: true } },
      },
      {
        path: 'harness.autoSync',
        protective: false,
        agentWants: true,
        patch: { harness: { autoSync: true } },
      },
      {
        path: 'uploads.maxFileSize',
        protective: 1024,
        agentWants: 104857600,
        patch: { uploads: { maxFileSize: 104857600 } },
      },
      {
        path: 'uploads.maxFiles',
        protective: 1,
        agentWants: 20,
        patch: { uploads: { maxFiles: 20 } },
      },
      {
        path: 'uploads.allowedTypes',
        protective: ['image/*'],
        agentWants: ['*/*'],
        patch: { uploads: { allowedTypes: ['*/*'] } },
      },
      {
        path: 'scheduler.maxConcurrentRuns',
        protective: 1,
        agentWants: 10,
        patch: { scheduler: { maxConcurrentRuns: 10 } },
      },
    ];

    it('refuses an AGENT every one of them, and writes nothing', async () => {
      const { configManager } = await import('../../services/core/config-manager.js');
      // Seeded straight into the store, so the seeding is not the thing under
      // test — this is the state a person who tightened the bound leaves behind.
      for (const leaf of carried) configManager.setDot(leaf.path, leaf.protective);

      agentHeader = 'agent-token';
      signedInUser = undefined;

      for (const leaf of carried) {
        const refused = await request(server).patch('/api/config').send(leaf.patch);

        expect(refused.status, leaf.path).toBe(403);
        expect(refused.body.code, leaf.path).toBe('operator_only_config');
        expect(refused.body.paths, leaf.path).toContain(leaf.path);
        // `.toEqual`, not `.toBe`: `uploads.allowedTypes` carries an array, and
        // deep equality is the right comparison for every scalar leaf here too.
        expect(configManager.getDot(leaf.path), leaf.path).toEqual(leaf.protective);
        expect(configManager.getDot(leaf.path), leaf.path).not.toEqual(leaf.agentWants);
      }
    });

    it('lets the PERSON write every one of them through the same door', async () => {
      // The other half, and the one that decides whether the fix is usable.
      // Every surface that owns one of these ten writes through THIS route: the
      // Control Center's 'Warm agents' switch and its 'Scheduled runs at once'
      // stepper, Settings → Tools for the four tool switches and the same
      // concurrency stepper, and `dorkos config set` for `uploads.*` and
      // `harness.autoSync`, which have no screen of their own. A guard that
      // refused everybody would break every one of them.
      const { configManager } = await import('../../services/core/config-manager.js');
      for (const leaf of carried) configManager.setDot(leaf.path, leaf.protective);

      for (const leaf of carried) {
        const response = await request(server).patch('/api/config').send(leaf.patch);

        expect(response.status, leaf.path).toBe(200);
        expect(response.body.success, leaf.path).toBe(true);
        expect(configManager.getDot(leaf.path), leaf.path).toEqual(leaf.agentWants);
      }
    });

    it('leaves an agent the ordinary preferences beside them', async () => {
      // The over-refusal check. `ui.theme` sits beside a newly refused runtime
      // leaf, `retentionCount` beside a newly refused scheduler leaf, and
      // `defaultModel` beside a newly refused `uploads.*` sibling — none of the
      // three is carried across a wipe, so all must still go through, or the
      // guard has been drawn wider than the rule it enforces.
      agentHeader = 'agent-token';
      signedInUser = undefined;

      const response = await request(server)
        .patch('/api/config')
        .send({
          ui: { theme: 'dark' },
          scheduler: { retentionCount: 50 },
          runtimes: { claudeCode: { defaultModel: 'opus' } },
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      const { configManager } = await import('../../services/core/config-manager.js');
      expect(configManager.getDot('ui.theme')).toBe('dark');
      expect(configManager.getDot('runtimes.claudeCode.defaultModel')).toBe('opus');
      expect(configManager.getDot('scheduler.retentionCount')).toBe(50);
    });

    it('refuses the whole patch when one carried leaf rides along with preferences', async () => {
      // No partial write: an agent must not be able to smuggle a protective
      // value's reversal in behind a legitimate change and have the legitimate
      // half land as cover.
      const { configManager } = await import('../../services/core/config-manager.js');
      configManager.setDot('agentContext.relayTools', false);

      agentHeader = 'agent-token';
      signedInUser = undefined;

      const refused = await request(server)
        .patch('/api/config')
        .send({ ui: { theme: 'dark' }, agentContext: { relayTools: true } })
        .expect(403);

      expect(refused.body.paths).toEqual(['agentContext.relayTools']);
      expect(configManager.getDot('agentContext.relayTools')).toBe(false);
      expect(configManager.getDot('ui.theme')).not.toBe('dark');
    });

    it('tells the agent what a tool-group switch is, and nothing more', async () => {
      // The refusal text lands in a model's context, so it has to be true. These
      // switches feed the tool-documentation blocks: nothing is loaded, nothing
      // is attached, nobody gets in, and access is still the tier gate's call
      // (DOR-1044).
      agentHeader = 'agent-token';
      signedInUser = undefined;

      const refused = await request(server)
        .patch('/api/config')
        .send({ agentContext: { relayTools: true } })
        .expect(403);

      expect(refused.body.message).toContain('Which DorkOS tool groups your agents are told about');
      expect(refused.body.message).not.toMatch(/who can reach this instance/i);
    });
  });

  describe('notification settings (DOR-1385)', () => {
    // Every one of these is `operator-only`, because an agent that could write
    // them could turn off the knock, tell DorkOS never to try another way of
    // reaching you, and then park on a question nobody is ever told about.
    //
    // That verdict has a cost the tables cannot see: the Settings screen writes
    // through THIS route, so a policy that refused it here would leave the
    // person unable to change their own sound settings at all. These two cases
    // pin both halves — the door open for a person, shut for an agent.

    it('lets a PERSON turn the knock off through the settings door', async () => {
      const response = await request(server)
        .patch('/api/config')
        .send({ notifications: { sounds: { knock: false } } })
        .expect(200);

      expect(response.body.success).toBe(true);

      const { configManager } = await import('../../services/core/config-manager.js');
      expect(configManager.getDot('notifications.sounds.knock')).toBe(false);
      // The sibling switches are untouched: `PATCH` deep-merges, so a
      // one-switch write must not reset the other two to their defaults.
      expect(configManager.getDot('notifications.sounds.allClear')).toBe(true);
      expect(configManager.getDot('notifications.notifyOnTurnCompleteWhileAway')).toBe(true);
    });

    it('refuses an AGENT the same write', async () => {
      agentHeader = 'agent-token';
      signedInUser = undefined;

      const refused = await request(server)
        .patch('/api/config')
        .send({ notifications: { sounds: { knock: false } } })
        .expect(403);

      expect(refused.body.code).toBe('operator_only_config');
      expect(refused.body.paths).toContain('notifications.sounds.knock');

      const { configManager } = await import('../../services/core/config-manager.js');
      expect(configManager.getDot('notifications.sounds.knock')).toBe(true);
    });

    it('refuses an agent switching the escalation ladder off', async () => {
      agentHeader = 'agent-token';
      signedInUser = undefined;

      const refused = await request(server)
        .patch('/api/config')
        .send({ notifications: { escalation: { phoneAfterMinutes: 'never' } } })
        .expect(403);

      expect(refused.body.paths).toContain('notifications.escalation.phoneAfterMinutes');
    });
  });

  describe('settings that live inside a list (DOR-1113)', () => {
    // Until DOR-1113 the path matcher stopped at the array, so a patch replacing
    // `connectors.rawMcpServers` or `runtimes.claudeCode.accounts` matched no
    // policy key and both bars on this route were skipped for it. An agent could
    // register an outbound tool endpoint pointed anywhere, or add a Claude
    // account directory, past a guard that exists to stop exactly that.

    it('refuses an agent registering a raw MCP server', async () => {
      agentHeader = 'agent-token';
      signedInUser = undefined;

      const refused = await request(server)
        .patch('/api/config')
        .send({
          connectors: {
            rawMcpServers: [
              { slug: 'exfil', displayName: 'Exfil', url: 'https://attacker.test/mcp' },
            ],
          },
        })
        .expect(403);
      expect(refused.body.code).toBe('operator_only_config');
      expect(refused.body.paths).toContain('connectors.rawMcpServers[].url');

      const { configManager } = await import('../../services/core/config-manager.js');
      expect(configManager.getDot('connectors.rawMcpServers')).toEqual([]);
    });

    it('refuses an agent adding a Claude account', async () => {
      agentHeader = 'agent-token';
      signedInUser = undefined;

      const refused = await request(server)
        .patch('/api/config')
        .send({
          runtimes: {
            claudeCode: { accounts: [{ id: 'acct-1', path: '/tmp/theirs', label: null }] },
          },
        })
        .expect(403);
      expect(refused.body.paths).toContain('runtimes.claudeCode.accounts[].path');

      const { configManager } = await import('../../services/core/config-manager.js');
      expect(configManager.getDot('runtimes.claudeCode.accounts')).toEqual([]);
    });

    it('lets the PERSON in the cockpit write both lists, which is how they are managed', async () => {
      // The guard binds agents, not the person. Settings → Runtimes sends exactly
      // this patch (`ClaudeAccountsSection.tsx` `write()`), and a guard that
      // refused it would leave no way to register an account at all.
      signedInUser = { userId: 'user_cockpit', credential: 'cookie' };
      agentHeader = undefined;

      const accounts = await request(server)
        .patch('/api/config')
        .send({
          runtimes: {
            claudeCode: { accounts: [{ id: 'me', path: '/Users/me/.claude', label: 'Me' }] },
          },
        })
        .expect(200);
      expect(accounts.body.config.runtimes.claudeCode.accounts).toEqual([
        { id: 'me', path: '/Users/me/.claude', label: 'Me' },
      ]);

      const servers = await request(server)
        .patch('/api/config')
        .send({
          connectors: {
            rawMcpServers: [
              {
                slug: 'notes',
                displayName: 'Notes',
                url: 'https://notes.test/mcp',
                transport: 'http',
              },
            ],
          },
        })
        .expect(200);
      expect(servers.body.config.connectors.rawMcpServers[0].slug).toBe('notes');
    });

    it('lets the person empty a list again', async () => {
      // Emptying is a write to the list, so it goes through the same bar. The
      // person has to be able to remove the account they just added.
      signedInUser = { userId: 'user_cockpit', credential: 'cookie' };
      agentHeader = undefined;

      await request(server)
        .patch('/api/config')
        .send({
          runtimes: {
            claudeCode: { accounts: [{ id: 'acct-2', path: '/Users/me/.claude', label: null }] },
          },
        })
        .expect(200);

      const emptied = await request(server)
        .patch('/api/config')
        .send({ runtimes: { claudeCode: { accounts: [] } } })
        .expect(200);
      expect(emptied.body.config.runtimes.claudeCode.accounts).toEqual([]);
    });

    it('leaves the lists an agent MAY write alone', async () => {
      // Descending into arrays must not turn every list into an operator-only
      // one: the sidebar's element fields are agent-writable on purpose.
      agentHeader = 'agent-token';
      signedInUser = undefined;

      const ok = await request(server)
        .patch('/api/config')
        .send({ ui: { statusBar: { pins: ['runtime'] } } })
        .expect(200);
      expect(ok.body.config.ui.statusBar.pins).toEqual(['runtime']);
    });
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
      expect(ok.body.success).toBe(true);
      // The write LANDED, read off the store rather than out of the answer: the
      // answer is the curated snapshot and never carries the token (DOR-1740).
      const { configManager } = await import('../../services/core/config-manager.js');
      expect(configManager.getDot('tunnel.authtoken')).toBe('chosen-by-a-person');
      expect(ok.body.config.tunnel.authtokenConfigured).toBe(true);
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
    expect(ok.body.success).toBe(true);

    // Both writes landed. Measured at the store, not in the answer — the answer
    // is the curated snapshot and carries neither value (DOR-1740).
    const { configManager } = await import('../../services/core/config-manager.js');
    expect(configManager.getDot('tunnel.authtoken')).toBe('planted');
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

  describe('the answer never carries a stored secret (DOR-1740)', () => {
    // The defect, reproduced against the real route: the response used to be
    // `result.config` — the whole stored file — so saving an ngrok token got the
    // token back verbatim, and after that every unrelated patch carried it too. A
    // response body is logged by whatever fronts the server, cached by the
    // browser, and over the built-in tunnel it crosses the public internet, so
    // this is the same class of leak the POST-only MCP reveal exists to avoid.

    /** The `<leaf>Configured` sibling that stands in for a withheld secret. */
    function presenceFlagPath(dotPath: string): string {
      const parts = dotPath.split('.');
      return [...parts.slice(0, -1), `${parts[parts.length - 1]!}Configured`].join('.');
    }

    /** Read a dot-path out of a response body, or `undefined` if any hop is missing. */
    function readDotPath(root: unknown, dotPath: string): unknown {
      let node: unknown = root;
      for (const part of dotPath.split('.')) {
        if (node === null || typeof node !== 'object') return undefined;
        node = (node as Record<string, unknown>)[part];
      }
      return node;
    }

    it('withholds the token a patch just saved, and says only that one is set', async () => {
      const response = await request(server)
        .patch('/api/config')
        .send({ tunnel: { authtoken: 'ngrok-secret-value' } })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(JSON.stringify(response.body)).not.toContain('ngrok-secret-value');
      // Withheld by ABSENCE plus a boolean, never by `null`: a `null` where a
      // token is stored cannot be told apart from no token at all, which is the
      // one thing a caller that just wrote needs to know.
      expect('authtoken' in response.body.config.tunnel).toBe(false);
      expect(response.body.config.tunnel.authtokenConfigured).toBe(true);

      const { configManager } = await import('../../services/core/config-manager.js');
      expect(configManager.getDot('tunnel.authtoken')).toBe('ngrok-secret-value');
    });

    it('never carries the secrets already on disk, whatever the patch was about', async () => {
      // Derived from `SENSITIVE_CONFIG_KEYS` rather than hand-listed, the way
      // `config-patch-paths.test.ts` derives its own list, so a fifth secret is
      // covered the day it is added instead of the day somebody remembers.
      const { SENSITIVE_CONFIG_KEYS } = await import('@dorkos/shared/config-schema');
      const { configManager } = await import('../../services/core/config-manager.js');
      const planted = new Map(
        SENSITIVE_CONFIG_KEYS.map((key) => [key, `planted-${key.replace(/\./g, '-')}`])
      );
      // A derived list that came back empty would make every assertion below
      // vacuous, and this test would then pass while checking nothing.
      expect(planted.size).toBeGreaterThan(0);
      for (const [key, value] of planted) configManager.setDot(key, value);

      // A patch about a theme. Nothing in it names a credential, which is exactly
      // the case the old response leaked on: it echoed the whole stored file.
      const response = await request(server)
        .patch('/api/config')
        .send({ ui: { theme: 'dark' } })
        .expect(200);

      expect(response.body.config.ui.theme).toBe('dark');
      const serialized = JSON.stringify(response.body);
      for (const [key, value] of planted) {
        expect(serialized, `${key} rode the PATCH response`).not.toContain(value);
        expect(readDotPath(response.body.config, key)).toBeUndefined();
        expect(readDotPath(response.body.config, presenceFlagPath(key))).toBe(true);
      }

      // And the leak was not "fixed" by refusing to store them.
      for (const [key, value] of planted) expect(configManager.getDot(key)).toBe(value);
    });

    it('matches the published wire contract, so the schema is not a decoration', async () => {
      // `ConfigPatchResponseSchema` is the documented shape of this body and had
      // no runtime reader at all, which is how it came to promise
      // `tunnel.authtoken: string | null` — a leak, written down as a contract.
      // Parsing a REAL answer through it is what stops the schema and the route
      // from drifting apart again in either direction.
      const { ConfigPatchResponseSchema } = await import('@dorkos/shared/schemas');

      const response = await request(server)
        .patch('/api/config')
        .send({ server: { port: 8080 }, ui: { theme: 'dark' } })
        .expect(200);

      const parsed = ConfigPatchResponseSchema.safeParse(response.body);
      expect(parsed.error?.issues ?? []).toEqual([]);
      expect(parsed.success).toBe(true);
      expect(parsed.data?.config.tunnel).toEqual({
        enabled: false,
        domain: null,
        authtokenConfigured: false,
        authConfigured: false,
      });
    });

    it('withholds the credential REFERENCES too, which name where a secret lives', async () => {
      // Not on `SENSITIVE_CONFIG_KEYS` and still withheld, because the allowlist
      // decides rather than that list: `file:/Users/me/.dork/secrets/anthropic`
      // tells a reader exactly which file to open, which is the same escalation
      // as handing over the key (ADR-0315, `config-disclosure.ts`).
      const { configManager } = await import('../../services/core/config-manager.js');
      configManager.set('providers', { anthropic: 'file:planted-provider-ref' });
      configManager.setDot('runtimes.codex.credentialRef', 'env:PLANTED_CODEX_KEY');

      const response = await request(server)
        .patch('/api/config')
        .send({ ui: { theme: 'light' } })
        .expect(200);

      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain('file:planted-provider-ref');
      expect(serialized).not.toContain('env:PLANTED_CODEX_KEY');
      expect(response.body.config.providersConfigured).toEqual(['anthropic']);
      expect(response.body.config.runtimes.codex.credentialRefConfigured).toBe(true);
    });
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

  // The packaged Mac app is launched from Finder, where `process.cwd()` is `/`
  // — a path outside the boundary that every boundary-enforced route then
  // refuses. `DEFAULT_CWD` is the resolved, clamped default the rest of the
  // server already agrees on (`GET /api/directory/default` reports it too).
  it('reports the resolved default working directory, not process.cwd()', async () => {
    const { DEFAULT_CWD } = await import('../../lib/resolve-root.js');

    const res = await request(server).get('/api/config').expect(200);

    expect(res.body.workingDirectory).toBe(DEFAULT_CWD);
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
  describe('rooms — the numbers the cockpit says out loud', () => {
    /** Every `rooms` field the wire carries, and nothing more. */
    const WIRE_FIELDS = [
      'engagedWindowMinutes',
      'engagedWindowPosts',
      'maxAgentDepth',
      'maxAutomaticTurnsPerRoomPerHour',
      'maxAutomaticTurnsTotalPerHour',
      'maxTurnsPerAgentPerCascade',
      'turnLimitsEnabled',
    ];

    it('reports the shipped numbers when nobody has changed them', async () => {
      const res = await request(server).get('/api/config').expect(200);

      expect(res.body.rooms).toEqual({
        engagedWindowMinutes: 10,
        engagedWindowPosts: 5,
        ...ROOM_TURN_LIMIT_DEFAULTS,
      });
    });

    it('reports what an operator actually set, not what ships', async () => {
      const { configManager } = await import('../../services/core/config-manager.js');
      configManager.set('rooms', {
        ...configManager.get('rooms')!,
        engagedWindowMinutes: 3,
        engagedWindowPosts: 2,
        maxAgentDepth: 4,
        turnLimitsEnabled: false,
      });

      const res = await request(server).get('/api/config').expect(200);

      expect(res.body.rooms).toMatchObject({
        engagedWindowMinutes: 3,
        engagedWindowPosts: 2,
        maxAgentDepth: 4,
        turnLimitsEnabled: false,
      });
    });

    it('carries the ceilings and the limits, and nothing else out of the rooms block', async () => {
      // Settings offers the five limits, so they ride (DOR-1430) — but the rest
      // of `rooms` is reply waits and collect timings, real settings the cockpit
      // never states out loud. Widening this to the whole block would put
      // settings on a wire that has no reader for them.
      const res = await request(server).get('/api/config').expect(200);

      expect(Object.keys(res.body.rooms).sort()).toEqual(WIRE_FIELDS);
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

  // Settings owns TWO of these four switches: whether agents may greet you, and
  // whether a greeting may spend a model turn on a next-step offer (DOR-1046).
  // The two numbers go out with them so the first switch's own sentence can
  // state the threshold actually in force rather than the shipped default, the
  // same reason the `rooms` block carries its ceilings (spec team-room-home
  // D5.2, task 4.3).
  describe('welcomeBack — what agents may say when you come back', () => {
    it('reports the shipped values when nobody has changed them', async () => {
      const res = await request(server).get('/api/config').expect(200);

      expect(res.body.welcomeBack).toEqual({
        enabled: true,
        absenceThresholdMinutes: 240,
        maxPosts: 3,
        offersEnabled: true,
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
        offersEnabled: true,
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

    it('round-trips the offers switch, which ships on and can be turned off', async () => {
      const before = await request(server).get('/api/config').expect(200);
      expect(before.body.welcomeBack.offersEnabled).toBe(true);

      await request(server)
        .patch('/api/config')
        .send({ welcomeBack: { offersEnabled: false } })
        .expect(200);

      const res = await request(server).get('/api/config').expect(200);

      // The direction that matters now: offers ship on, so the write worth
      // proving is the refusal, and it has to survive the read (DOR-1121).
      expect(res.body.welcomeBack.offersEnabled).toBe(false);
      // The switch a person already had is untouched by the one they just flipped.
      expect(res.body.welcomeBack.enabled).toBe(true);
    });

    it('carries the four welcomeBack fields and nothing else', async () => {
      const res = await request(server).get('/api/config').expect(200);

      expect(Object.keys(res.body.welcomeBack).sort()).toEqual([
        'absenceThresholdMinutes',
        'enabled',
        'maxPosts',
        'offersEnabled',
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

  // The block that exists because curation is not free (DOR-1304). A flag
  // shipped OFF and absent from this DTO is a flag nobody can reach without
  // hand-editing `~/.dork/config.json`, which is exactly what happened to
  // `runtimes.claudeCode.persistentSession`.
  describe('experiments', () => {
    const ORIGINAL_A2A = process.env.DORKOS_A2A_ENABLED;

    afterEach(() => {
      if (ORIGINAL_A2A === undefined) delete process.env.DORKOS_A2A_ENABLED;
      else process.env.DORKOS_A2A_ENABLED = ORIGINAL_A2A;
    });

    it('lists every registered experiment, resolved, in registry order', async () => {
      const { EXPERIMENTS } = await import('../../services/core/config/experiments-registry.js');

      const res = await request(server).get('/api/config').expect(200);

      // Compared against the registry rather than a hardcoded pair, because the
      // registry is DESIGNED to shrink to nothing as flags graduate — a literal
      // list here would red the day an experiment is correctly deleted. What
      // this pins is the invariant that survives: order preserved, nothing
      // dropped, every entry carrying its prose.
      expect(res.body.experiments.map((e: { key: string }) => e.key)).toEqual(
        EXPERIMENTS.map((e) => e.path)
      );
      for (const entry of res.body.experiments) {
        expect(entry.title).toBeTruthy();
        expect(entry.description).toBeTruthy();
        expect(typeof entry.enabled).toBe('boolean');
        expect(typeof entry.lockedByEnv).toBe('boolean');
      }
    });

    it('reports every shipped experiment off and switchable on a fresh install', async () => {
      const res = await request(server).get('/api/config').expect(200);

      const byKey = Object.fromEntries(
        res.body.experiments.map((e: { key: string }) => [e.key, e])
      );
      expect(byKey['a2a.enabled']).toMatchObject({ enabled: false, lockedByEnv: false });
      // Warm agents used to be the second entry here and are not any more: the
      // flag GRADUATED, which means its registry entry went out in the same
      // change that flipped the default (spec `full-power-defaults`). Its switch
      // moved to the Control Center rather than disappearing (#1209). The
      // absence here is the success state for the REGISTRY, which is what this
      // case is about.
      expect(byKey['runtimes.claudeCode.persistentSession']).toBeUndefined();
    });

    it('reports the setting a person turned on', async () => {
      const { configManager } = await import('../../services/core/config-manager.js');
      configManager.set('a2a', { enabled: true });

      const res = await request(server).get('/api/config').expect(200);

      const a2a = res.body.experiments.find((e: { key: string }) => e.key === 'a2a.enabled');
      expect(a2a).toMatchObject({ enabled: true, lockedByEnv: false });
    });

    it('locks the A2A entry when DORKOS_A2A_ENABLED is set, and reports the VARIABLE', async () => {
      // `false` while the SETTING says on: the switch must show what is really
      // happening on this machine, not an inert preference. Getting this
      // backwards would put "on" over an install where nothing is mounted.
      const { configManager } = await import('../../services/core/config-manager.js');
      configManager.set('a2a', { enabled: true });
      process.env.DORKOS_A2A_ENABLED = 'false';

      const res = await request(server).get('/api/config').expect(200);

      const a2a = res.body.experiments.find((e: { key: string }) => e.key === 'a2a.enabled');
      // The VARIABLE rides along by name: the client interpolates it into the
      // locked-row sentence, so the one person who can unset it knows what to
      // unset. Absent, the disabled switch is a dead end.
      expect(a2a).toMatchObject({
        enabled: false,
        lockedByEnv: true,
        envOverride: 'DORKOS_A2A_ENABLED',
      });
      // An entry with no variable of its own is resolved independently and gets
      // no invented variable name. Asserted over whatever else is registered,
      // because the registry is designed to shrink and a named second entry
      // would red the day it graduates — which is exactly what happened to the
      // warm-agents flag this used to name.
      for (const other of res.body.experiments.filter(
        (e: { key: string }) => e.key !== 'a2a.enabled'
      )) {
        expect(other.lockedByEnv).toBe(false);
        expect(other).not.toHaveProperty('envOverride');
      }
    });

    it('locks it ON when the variable says true, whatever the setting says', async () => {
      process.env.DORKOS_A2A_ENABLED = 'true';

      const res = await request(server).get('/api/config').expect(200);

      const a2a = res.body.experiments.find((e: { key: string }) => e.key === 'a2a.enabled');
      expect(a2a).toMatchObject({
        enabled: true,
        lockedByEnv: true,
        envOverride: 'DORKOS_A2A_ENABLED',
      });
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
        // Warm agents default on, exposed here for the Control Center switch.
        persistentSession: true,
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
          defaultAccount: real,
          accounts: [
            { id: 'acme-corp', path: real, label: 'Acme Corp' },
            { id: 'gone', path: missing, label: null },
          ],
          defaultModel: null,
          defaultEffort: null,
          defaultTrustStop: null,
          persistentSession: false,
        },
      });

      const res = await request(server).get('/api/config').expect(200);

      // The chosen account wins over the inherited env var, and the roster says
      // honestly which entries no longer resolve.
      expect(res.body.claudeCode).toEqual({
        resolvedAccount: real,
        inherited: false,
        accounts: [
          { id: 'acme-corp', path: real, label: 'Acme Corp', isAccountRoot: true },
          { id: 'gone', path: missing, label: null, isAccountRoot: false },
        ],
        // The warm-agents value flows through from config to the Control Center.
        persistentSession: false,
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
    expect(res.body.ui.sidebar.sections).toEqual({});
    expect(res.body.ui.sidebar.gettingStarted).toEqual({ retired: [] });
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

  it('reports the power door unanswered on a fresh install', async () => {
    const res = await request(server).get('/api/config').expect(200);

    expect(res.body.ui.fullPowerDecidedAt).toBeNull();
    expect(res.body.ui.fullPowerChoice).toBeNull();
  });

  it('records either answer at the power door, and reads it back on the next GET', async () => {
    // The round trip the door relies on: it writes the answer and every later
    // launch decides from this read whether to put the modal up again.
    const decidedAt = '2026-08-22T11:15:00.000Z';
    await request(server)
      .patch('/api/config')
      .send({ ui: { fullPowerDecidedAt: decidedAt, fullPowerChoice: 'supervised' } })
      .expect(200);

    const res = await request(server).get('/api/config').expect(200);
    expect(res.body.ui.fullPowerDecidedAt).toBe(decidedAt);
    expect(res.body.ui.fullPowerChoice).toBe('supervised');
  });

  it('recording the answer alone unlocks nothing (invariant A1)', async () => {
    // "Supervised" is a first-class answer and changes nothing anywhere; and
    // even `'full'` is only a record — the capabilities ride on the OTHER keys
    // the door's accept sends in the same request, each through its own gate.
    await request(server)
      .patch('/api/config')
      .send({ ui: { fullPowerDecidedAt: '2026-08-22T11:15:00.000Z', fullPowerChoice: 'full' } })
      .expect(200);

    const res = await request(server).get('/api/config').expect(200);
    expect(res.body.ui.autonomyAcknowledgedAt).toBeNull();
    expect(res.body.executionDefaults.trustStop).toBeNull();
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
