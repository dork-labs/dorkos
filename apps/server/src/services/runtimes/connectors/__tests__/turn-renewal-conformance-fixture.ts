import { connectorRuntimeBindings, createDb, runMigrations } from '@dorkos/db';
import { expect, vi } from 'vitest';
import { ConnectorRuntimePrincipalService } from '../../../connectors/principal/runtime-principal-service.js';
import type {
  ConnectorRuntime,
  OpenConnectorTurnResult,
} from '../../../connectors/runtime-principal-port.js';
import {
  ConnectorTurnLeaseSupervisor,
  type ConnectorLeaseScheduler,
  type ConnectorLeaseTimer,
  type ConnectorTurnLeaseSupervisorFactory,
  type ConnectorTurnLeaseSupervisorHandle,
} from '../connector-turn-lease-supervisor.js';

const START_MS = Date.parse('2026-09-08T00:00:00.000Z');
const HOUR_MS = 60 * 60 * 1_000;

/** Real principal and supervisor fixture driven by an adapter's own live turn. */
export interface RuntimeTurnRenewalConformanceFixture {
  /** Real SQLite principal service installed into the runtime adapter. */
  readonly principals: ConnectorRuntimePrincipalService;
  /** Real supervisor factory with deterministic clock and timer seams. */
  readonly createLeaseSupervisor: ConnectorTurnLeaseSupervisorFactory;
  /** Read the one binding opened by the adapter. */
  opened(): Promise<OpenConnectorTurnResult>;
  /** Drive the adapter-owned lease through deterministic productive hours. */
  advanceHours(hours: number): Promise<void>;
  /** Prove terminal adapter teardown denied the unchanged bearer. */
  expectTerminalDenial(): Promise<void>;
  /** Close the fixture's private in-memory database. */
  close(): void;
}

/**
 * Create a deterministic real-principal/real-supervisor fixture for one adapter.
 *
 * @param runtime - Runtime whose real turn boundary owns the fixture.
 * @returns Initialized fixture ready for adapter injection.
 */
export async function createRuntimeTurnRenewalConformanceFixture(
  runtime: ConnectorRuntime
): Promise<RuntimeTurnRenewalConformanceFixture> {
  const db = createDb(':memory:');
  runMigrations(db);
  let nowMs = START_MS;
  const callbacks: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  const scheduler: ConnectorLeaseScheduler = {
    set: vi.fn((callback, delayMs) => {
      const entry = { callback, delayMs, cleared: false };
      callbacks.push(entry);
      return { unref: vi.fn(), entry } as ConnectorLeaseTimer;
    }),
    clear: vi.fn((timer) => {
      (timer as ConnectorLeaseTimer & { entry: (typeof callbacks)[number] }).entry.cleared = true;
    }),
  };
  const principals = new ConnectorRuntimePrincipalService({
    db,
    authority: {
      authorizeTurn: async () => ({
        owner: { kind: 'local_install', installationId: 'renewal-conformance' },
        agentId: 'renewal-agent',
      }),
      revalidateTurn: async () => true,
    },
    now: () => new Date(nowMs),
    makeBootEpoch: () => `boot-${runtime}`,
    makeBearer: () => `bearer-${runtime}`,
  });
  await principals.initializeBoot();
  const openTurn = vi.spyOn(principals, 'openTurn');
  const renew = vi.spyOn(principals, 'renew');
  const supervisors: ConnectorTurnLeaseSupervisorHandle[] = [];
  const createLeaseSupervisor: ConnectorTurnLeaseSupervisorFactory = vi.fn((options) => {
    expect(options.runtime).toBe(runtime);
    const supervisor = new ConnectorTurnLeaseSupervisor({
      ...options,
      now: () => new Date(nowMs),
      scheduler,
    });
    supervisors.push(supervisor);
    return supervisor;
  });

  async function opened(): Promise<OpenConnectorTurnResult> {
    expect(openTurn).toHaveBeenCalledOnce();
    const result = openTurn.mock.results[0];
    if (!result || result.type !== 'return') throw new Error('Adapter did not open a binding.');
    return result.value;
  }

  async function resolveOpened(): Promise<void> {
    const binding = await opened();
    const input = openTurn.mock.calls[0]?.[0];
    if (!input) throw new Error('Adapter open input is unavailable.');
    await expect(
      principals.resolve({
        bearer: binding.bearer,
        expectedRuntime: runtime,
        expectedCanonicalCwd: input.canonicalCwd,
      })
    ).resolves.toMatchObject({ status: 'resolved' });
  }

  return {
    principals,
    createLeaseSupervisor,
    opened,
    async advanceHours(hours) {
      const binding = await opened();
      expect(binding.expiresAt).toBe(new Date(START_MS + 4 * HOUR_MS).toISOString());
      expect(supervisors).toHaveLength(1);
      expect(callbacks[0]?.delayMs).toBe(HOUR_MS);

      for (let hour = 1; hour <= hours; hour += 1) {
        const beforeTraffic = db.select().from(connectorRuntimeBindings).get()?.expiresAt;
        await resolveOpened();
        expect(db.select().from(connectorRuntimeBindings).get()?.expiresAt).toBe(beforeTraffic);

        nowMs = START_MS + hour * HOUR_MS;
        callbacks[hour - 1]?.callback();
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(renew).toHaveBeenCalledTimes(hour);
        expect(db.select().from(connectorRuntimeBindings).get()?.expiresAt).toBe(
          new Date(START_MS + (hour + 4) * HOUR_MS).toISOString()
        );
        expect(callbacks).toHaveLength(hour + 1);
        await resolveOpened();
      }
    },
    async expectTerminalDenial() {
      const binding = await opened();
      const input = openTurn.mock.calls[0]?.[0];
      if (!input) throw new Error('Adapter open input is unavailable.');
      expect(supervisors[0]?.state).toBe('stopped');
      await expect(
        principals.resolve({
          bearer: binding.bearer,
          expectedRuntime: runtime,
          expectedCanonicalCwd: input.canonicalCwd,
        })
      ).resolves.toMatchObject({ status: 'refused', reason: 'revoked' });
    },
    close() {
      db.$client.close();
    },
  };
}
