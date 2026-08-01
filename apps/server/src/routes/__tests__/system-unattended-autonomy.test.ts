/**
 * `GET /api/system/unattended-autonomy` — the one aggregate the standing banner
 * reads, and the two ways it is allowed to be empty.
 *
 * The rule itself is specified beside the collector, in
 * `services/core/unattended-autonomy/__tests__/`. What this file pins is the
 * wiring: that the handler reaches the real stores through `app.locals`,
 * that it resolves the runtime profile rather than trusting mode ids, and that
 * an install without relay or Tasks answers `200` with nothing rather than
 * failing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: { listRuntimes: vi.fn(() => []), has: vi.fn(), get: vi.fn() },
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import request from 'supertest';
import { createApp } from '../../app.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import type { UnattendedAutonomyDeps } from '../../services/core/unattended-autonomy/unattended-autonomy.js';

const app = createApp();

/** A profile declaring one asking mode and one autonomy mode. */
const CAPABILITIES = {
  type: 'claude-code',
  permissionModes: {
    supported: true,
    default: 'default',
    values: [
      {
        id: 'default',
        label: 'Default',
        stop: 'ask',
        asks: 'always',
        reach: 'edit',
        promise: 'Asks first.',
      },
      {
        id: 'bypassPermissions',
        label: 'Bypass permissions',
        stop: 'autonomy',
        asks: 'never',
        reach: 'everything',
        promise: 'Runs everything without asking.',
      },
    ],
  },
} as unknown as RuntimeCapabilities;

/** Register a runtime profile for the type both unattended drivers run on. */
function withProfile(): void {
  vi.mocked(runtimeRegistry.has).mockImplementation((type: string) => type === 'claude-code');
  vi.mocked(runtimeRegistry.get).mockReturnValue({
    getCapabilities: () => CAPABILITIES,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  delete app.locals.unattendedAutonomyDeps;
});

describe('GET /api/system/unattended-autonomy', () => {
  it('answers with nothing when neither relay nor Tasks is running', async () => {
    withProfile();

    const res = await request(app).get('/api/system/unattended-autonomy');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ drivers: [] });
  });

  it('names the live bindings and tasks that run without asking', async () => {
    withProfile();
    app.locals.unattendedAutonomyDeps = {
      bindings: () => [
        {
          id: 'b1',
          label: 'Deploys',
          adapterId: 'telegram-1',
          agentId: 'agent-a',
          enabled: true,
          canReceive: true,
          permissionMode: 'bypassPermissions',
        },
        {
          id: 'b2',
          label: 'Support',
          adapterId: 'telegram-1',
          agentId: 'agent-a',
          enabled: true,
          canReceive: true,
          permissionMode: 'default',
        },
      ],
      tasks: () => [
        {
          id: 't1',
          name: 'nightly-cleanup',
          displayName: 'Nightly cleanup',
          enabled: true,
          status: 'active',
          permissionMode: 'bypassPermissions',
        },
      ],
      adapterName: (id) => id,
      adapterLive: () => true,
      agentLive: () => true,
    } satisfies UnattendedAutonomyDeps;

    const res = await request(app).get('/api/system/unattended-autonomy');

    expect(res.body).toEqual({
      drivers: [
        { kind: 'binding', id: 'b1', name: 'Deploys' },
        { kind: 'task', id: 't1', name: 'Nightly cleanup' },
      ],
    });
  });

  it('keeps warning when Mesh is not running to answer whether the agent exists', async () => {
    // The permissive default, and the direction it deliberately fails in: a
    // subsystem that cannot answer must not be able to silence a standing
    // warning about autonomy. Over-reporting is recoverable; going quiet is not.
    withProfile();
    app.locals.unattendedAutonomyDeps = {
      bindings: () => [
        {
          id: 'b1',
          label: 'Deploys',
          adapterId: 'telegram-1',
          agentId: 'agent-a',
          enabled: true,
          canReceive: true,
          permissionMode: 'bypassPermissions',
        },
      ],
      adapterName: (id) => id,
      // adapterLive and agentLive deliberately absent.
    } satisfies UnattendedAutonomyDeps;

    const res = await request(app).get('/api/system/unattended-autonomy');

    expect(res.body.drivers).toHaveLength(1);
  });

  it('claims nothing when the runtime behind both drivers is not registered', async () => {
    // A test-mode boot. The stores still hold rows; nothing in this process can
    // read what their mode ids mean, so the honest answer is silence.
    vi.mocked(runtimeRegistry.has).mockReturnValue(false);
    app.locals.unattendedAutonomyDeps = {
      bindings: () => [
        {
          id: 'b1',
          label: 'Deploys',
          adapterId: 'telegram-1',
          agentId: 'agent-a',
          enabled: true,
          canReceive: true,
          permissionMode: 'bypassPermissions',
        },
      ],
    } satisfies UnattendedAutonomyDeps;

    const res = await request(app).get('/api/system/unattended-autonomy');

    expect(res.body).toEqual({ drivers: [] });
    expect(runtimeRegistry.get).not.toHaveBeenCalled();
  });
});
