/**
 * Shared setup for the `/api/config` route tests in this folder.
 *
 * Every test gets a FRESH app: its own config directory and a freshly imported
 * router (`vi.resetModules()` between tests), because `routes/config.ts` reads
 * the `DORKOS_*_ENABLED` locks at module load. One listener per file is
 * swapped between apps (DOR-483), so no pooled socket reaches the wrong app.
 *
 * `vi.mock` cannot live here; each test file declares the mocks it needs.
 */
import { afterAll, afterEach, beforeEach, vi } from 'vitest';
import type { Hono } from 'hono';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Response as TestResponse, Test } from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { loadCeilingMs } from '@dorkos/shared/test-budget';
import type { ApiEnv } from '../../../http/api-chain.js';
import { preloadConfigRouteModules } from '../fixtures/config-cold-imports.js';
import { confirmFixtureRequest, FIXTURE_BROWSER_HEADER } from '../step-up-fixture.js';

/**
 * The budget for a hook or case that imports a FRESH module graph. About a
 * second on an idle machine; a loaded one took it past vitest's 10-second hook
 * default with nothing wrong, so it scales with the machine's load.
 */
export const FRESH_GRAPH_TIMEOUT_MS = Math.min(60_000, loadCeilingMs(10_000));

/**
 * The subsystem locks `routes/config.ts` reads at MODULE LOAD, by PRESENCE.
 * Left inherited, every assertion about an unlocked subsystem measured the
 * developer's shell instead of the route (DOR-1086, DOR-1304). Deleted rather
 * than assigned, and restored after the file.
 */
const AMBIENT_FLAGS = [
  'DORKOS_TASKS_ENABLED',
  'DORKOS_RELAY_ENABLED',
  'DORKOS_A2A_ENABLED',
  'DORKOS_TODOS_ENABLED',
] as const;
const ambient = Object.fromEntries(AMBIENT_FLAGS.map((k) => [k, process.env[k]]));
for (const key of AMBIENT_FLAGS) delete process.env[key];
await preloadConfigRouteModules();
afterAll(() => {
  for (const key of AMBIENT_FLAGS) if (ambient[key] !== undefined) process.env[key] = ambient[key];
});

/** The one listener for the importing file, with the app behind it swapped per test. */
export const target = swappableServer();
/** The listening server requests go to. */
export const server = target.server;

/** Who the request comes from, as the session gate and agent-identity middleware would say. */
export const caller: {
  signedInUser: { userId: string; credential: 'cookie' | 'api-key' } | undefined;
  agentHeader: string | undefined;
  arrivedVia: 'wifi' | 'own-tunnel' | 'managed' | undefined;
} = { signedInUser: undefined, agentHeader: undefined, arrivedVia: undefined };

/** Make the next requests an agent's: its header, and no signed-in person. */
export function asAgent(): void {
  caller.agentHeader = 'agent-token';
  caller.signedInUser = undefined;
}

/** The owner's made-up password, which the step-up fixture's check accepts. */
export const OWNER_PASSWORD = 'made-up-owner-password';

/** The id of the account that owns this install; the importing file decides. */
let ownerId: () => string | null = () => 'user_cockpit';

/** Set where the owner's id comes from, for files that mock `readOwnerAccount`. */
export function setOwnerId(read: () => string | null): void {
  ownerId = read;
}

/** The real step-up routes, imported after `vi.resetModules()` like the router. */
export async function stepUpGroup() {
  const { stepUpFixtureRoutes } = await import('../step-up-fixture.js');
  return stepUpFixtureRoutes({
    ownerId: () => ownerId(),
    checkPassword: async (password) => (password === OWNER_PASSWORD ? 'ok' : 'wrong'),
  });
}

/** A signed-in person, in the browser a confirmable request names. */
export function asBrowser(
  user: NonNullable<typeof caller.signedInUser>,
  browser: string | undefined
) {
  return browser ? { ...user, sessionId: browser } : user;
}

/** The person at the desk confirming a held save with their password. */
export const asPerson = (ask: Test): Promise<TestResponse> =>
  confirmFixtureRequest(ask, server, OWNER_PASSWORD);

/** The config routes behind the `/api` chain, with the caller this file set. */
export async function configApp(configRouter: Hono<ApiEnv>) {
  const { honoGroupListener } = await import('../../../http/__tests__/hono-group-listener.js');
  caller.signedInUser = { userId: 'user_cockpit', credential: 'cookie' };
  caller.agentHeader = undefined;
  caller.arrivedVia = undefined;
  return honoGroupListener([{ path: '/api/config', routes: configRouter }, await stepUpGroup()], {
    before: async (c, next) => {
      if (caller.signedInUser)
        c.set('user', asBrowser(caller.signedInUser, c.req.header(FIXTURE_BROWSER_HEADER)));
      if (caller.agentHeader) c.env.incoming.headers['x-dorkos-agent'] = caller.agentHeader;
      if (caller.arrivedVia) {
        const { markIngress } = await import('../../../services/core/remote/ingress-mark.js');
        markIngress(c.env.incoming, caller.arrivedVia);
      }
      await next();
    },
  });
}

/**
 * Register the runtimes `GET /api/config` builds `executionDefaults` from: the
 * four shipped declarations, including `test-mode`, whose `configSection: null`
 * the report has to leave out.
 */
export async function registerDeclaringRuntimes(): Promise<void> {
  const { runtimeRegistry } = await import('../../../services/core/runtime-registry.js');
  const { FakeAgentRuntime } = await import('@dorkos/test-utils');
  const declarations = await Promise.all([
    import('../../../services/runtimes/claude-code/runtime-constants.js').then(
      (m) => m.CLAUDE_CODE_CAPABILITIES
    ),
    import('../../../services/runtimes/codex/runtime-constants.js').then(
      (m) => m.CODEX_CAPABILITIES
    ),
    import('../../../services/runtimes/opencode/runtime-constants.js').then(
      (m) => m.OPENCODE_CAPABILITIES
    ),
    import('../../../services/runtimes/test-mode/runtime-constants.js').then(
      (m) => m.TEST_MODE_CAPABILITIES
    ),
  ]);
  for (const capabilities of declarations) {
    runtimeRegistry.register(
      new FakeAgentRuntime(capabilities.type, { settings: capabilities.settings })
    );
  }
}

/** The config manager the freshly imported router is using. */
export async function store() {
  return (await import('../../../services/core/config-manager.js')).configManager;
}

/**
 * Boot a fresh config directory, boundary and router into {@link target}.
 *
 * @param dir - The data directory.
 * @param withRuntimes - Register the declaring runtimes too.
 */
export async function bootConfigApp(dir: string, withRuntimes = false): Promise<void> {
  process.env.DORK_HOME = dir;
  const { initConfigManager } = await import('../../../services/core/config-manager.js');
  initConfigManager(dir);
  const { initBoundary } = await import('../../../lib/boundary.js');
  await initBoundary(dir);
  const configRouter = (await import('../../config.js')).default;
  if (withRuntimes) await registerDeclaringRuntimes();
  target.mount(await configApp(configRouter));
}

/**
 * Give every test in the calling `describe` a fresh app on a fresh directory.
 *
 * @param options.withRuntimes - Register the declaring runtimes too.
 * @returns A handle whose `dir` is the current test's data directory.
 */
export function useFreshConfigApp(options: { withRuntimes?: boolean } = {}): { dir: string } {
  const handle = { dir: '' };
  beforeEach(async () => {
    handle.dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-config-route-')));
    await bootConfigApp(handle.dir, options.withRuntimes);
  }, FRESH_GRAPH_TIMEOUT_MS);
  afterEach(() => {
    fs.rmSync(handle.dir, { recursive: true, force: true });
    vi.resetModules();
  });
  return handle;
}
