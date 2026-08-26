/**
 * `GET /api/system/memory` — the operator-visible half of the registry's
 * quarantine-and-fallback design.
 *
 * The registry's own bench/fallback behavior is specified in
 * `services/memory/__tests__/registry.test.ts`. What this file pins is the
 * wiring: the route answers with `memoryProviderStatus()` untouched, for the
 * default posture, a healthy custom backend, and a benched one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BUILTIN_MEMORY_PROVIDER_ID,
  type AgentMemoryRef,
  type MemoryProvider,
} from '@dorkos/shared/memory-provider';
import { FakeMemoryProvider } from '@dorkos/test-utils/fake-memory-provider';

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: { listRuntimes: vi.fn(() => []), has: vi.fn(), get: vi.fn() },
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

/**
 * `hostGuard` reads `configManager.get(...)` on every request regardless of
 * route, and `registry.ts` reads `configManager.getDot('memory.provider')` —
 * both have to answer or the request 500s before it ever reaches the handler.
 */
let mockConfigManager: { get: (key: string) => unknown; getDot: (key: string) => unknown } = {
  get: vi.fn().mockReturnValue(null),
  getDot: vi.fn(),
};

vi.mock('../../services/core/config-manager.js', () => ({
  get configManager() {
    return mockConfigManager;
  },
}));

import request from 'supertest';
import { createApp } from '../../app.js';
import { logger } from '../../lib/logger.js';
import {
  getMemoryProvider,
  registerMemoryProvider,
  resetMemoryProvider,
} from '../../services/memory/registry.js';

const app = createApp();
const CUSTOM = 'acme-memory';

let warn: ReturnType<typeof vi.spyOn>;
let scopes: string[] = [];

function configure(id: string): void {
  mockConfigManager = {
    get: vi.fn().mockReturnValue(null),
    getDot: (key) => (key === 'memory.provider' ? id : undefined),
  };
}

async function makeRef(): Promise<AgentMemoryRef> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dorkos-system-memory-'));
  scopes.push(dir);
  return { agentId: path.basename(dir), agentPath: dir };
}

/** A provider that throws on every call — what benches. */
function throwingProvider(): MemoryProvider {
  const fail = (): never => {
    throw new TypeError('acme backend exploded');
  };
  return {
    info: { id: CUSTOM, capabilities: { search: true, consolidate: true } },
    getSnapshot: fail,
    write: fail,
    query: fail,
    forget: fail,
    consolidate: fail,
  };
}

beforeEach(() => {
  resetMemoryProvider();
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  configure(BUILTIN_MEMORY_PROVIDER_ID);
});

afterEach(async () => {
  resetMemoryProvider();
  warn.mockRestore();
  mockConfigManager = { get: vi.fn().mockReturnValue(null), getDot: vi.fn() };
  await Promise.all(scopes.map((dir) => rm(dir, { recursive: true, force: true })));
  scopes = [];
});

describe('GET /api/system/memory', () => {
  it('reports builtin as configured and active when nothing else is set up', async () => {
    const res = await request(app).get('/api/system/memory');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      configuredId: BUILTIN_MEMORY_PROVIDER_ID,
      activeId: BUILTIN_MEMORY_PROVIDER_ID,
      benched: false,
      benchReason: null,
    });
  });

  it('reports a healthy custom backend as its own active id', async () => {
    registerMemoryProvider(CUSTOM, () => new FakeMemoryProvider({ id: CUSTOM }));
    configure(CUSTOM);

    const res = await request(app).get('/api/system/memory');

    expect(res.body).toEqual({
      configuredId: CUSTOM,
      activeId: CUSTOM,
      benched: false,
      benchReason: null,
    });
  });

  it('reports the fallback as active and names why, once the configured backend faults', async () => {
    registerMemoryProvider(CUSTOM, () => throwingProvider());
    configure(CUSTOM);
    const ref = await makeRef();
    // Trigger the fault the same way an agent turn would: a read.
    await getMemoryProvider().getSnapshot(ref);

    const res = await request(app).get('/api/system/memory');

    expect(res.body).toEqual({
      configuredId: CUSTOM,
      activeId: BUILTIN_MEMORY_PROVIDER_ID,
      benched: true,
      benchReason: expect.stringContaining('acme backend exploded'),
    });
  });
});
