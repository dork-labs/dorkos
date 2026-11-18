/**
 * An identified agent on an ordinary turn still sets an extension's secret at
 * once (DOR-1801). A turn that followed words DorkOS can't vouch for, or an
 * agent header DorkOS can't resolve, is refused and saves nothing: an outsider
 * could otherwise swap the key for one on an account they control (Security S3
 * on DOR-4355 M3), the rule a chat connection's typed secret follows (DOR-3858).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { ExtensionSecretStore } from '@dorkos/shared/extension-secrets';
import type { StreamEvent } from '@dorkos/shared/types';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import {
  countWhileRunning,
  resetLiveOutsiderTurns,
} from '../../services/core/turn-power/live-outsider-turns.js';
import { initConfigManager } from '../../services/core/config-manager.js';
import { createExtensionsRoutes } from '../extensions.js';

const SECRET = 'made-up-northwind-key-0002';
const AGENT_HOME = '/made-up/agents/porter';
const AGENT = ['X-DorkOS-Agent', 'agent-token'] as const;
const URL = '/api/extensions/northwind-tool/secrets/api_key';
const RECORD = {
  id: 'northwind-tool',
  manifest: {
    id: 'northwind-tool',
    name: 'Northwind Tool',
    version: '1.0.0',
    serverCapabilities: { secrets: [{ key: 'api_key', label: 'API key' }] },
  },
  status: 'compiled',
  scope: 'global',
  origin: 'user',
  path: '/made-up/extensions/northwind-tool',
  bundleReady: true,
  hasServerEntry: true,
  hasDataProxy: false,
};

describe('an agent setting an extension secret', () => {
  const target = swappableServer();
  const dorkHome = mkdtempSync(path.join(tmpdir(), 'extension-secret-agent-gate-'));
  const secrets = () => new ExtensionSecretStore('northwind-tool', dorkHome);
  const manager = {
    get: vi.fn(() => RECORD),
    listPublic: vi.fn(() => []),
    listShadowedPublic: vi.fn(() => []),
  };
  const app = () =>
    target.mount(
      honoGroupListener(
        [
          {
            path: '/api/extensions',
            routes: createExtensionsRoutes({
              manager: manager as unknown as Parameters<
                typeof createExtensionsRoutes
              >[0]['manager'],
              dorkHome,
              getCwd: () => null,
            }),
          },
        ],
        {
          before: async (c, next) => {
            if (c.req.header(AGENT[0]) === AGENT[1]) {
              c.set('agentIdentity', {
                agentPath: AGENT_HOME,
                displayName: 'Porter',
                createdAt: '2026-11-01T00:00:00.000Z',
              });
            }
            await next();
          },
        }
      )
    );
  const put = (agent: string) =>
    request(app()).put(URL).set(AGENT[0], agent).send({ value: SECRET });

  /** Run `send` while the verified agent has a turn marked by outside words in progress. */
  async function duringMarkedTurn<T>(send: () => Promise<T>): Promise<T> {
    const turn = countWhileRunning(
      { cwd: AGENT_HOME },
      { outsider: true },
      (async function* () {
        yield { type: 'done', data: {} } as StreamEvent;
      })()
    );
    await turn.next();
    try {
      return await send();
    } finally {
      await turn.return(undefined);
    }
  }

  beforeAll(() => initConfigManager(dorkHome));
  afterAll(() => rmSync(dorkHome, { recursive: true, force: true }));
  beforeEach(async () => {
    resetLiveOutsiderTurns();
    await secrets().delete('api_key');
  });

  it('sets it at once from an ordinary turn', async () => {
    const res = await put(AGENT[1]);
    expect(res.status).toBe(200);
    expect(await secrets().get('api_key')).toBe(SECRET);
  });

  it('refuses a turn marked by outside words, and saves nothing', async () => {
    const res = await duringMarkedTurn(() => put(AGENT[1]));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('marked_turn_typed_secret');
    expect(await secrets().has('api_key')).toBe(false);
  });

  it('refuses an agent it cannot identify, and saves nothing', async () => {
    const res = await put('made-up-unknown-token');
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("couldn't tell which agent");
    expect(await secrets().has('api_key')).toBe(false);
  });
});
