/**
 * A turn DorkOS credits refused reaches a person whoever started it (ADR
 * 261001-000811): a scheduled task, a room turn and a relay delivery consume
 * their own streams and drop the error, so without this a refused background
 * turn did nothing and nobody knew.
 *
 * Driven through the REAL {@link RuntimeRegistry} (the wrap every caller
 * resolves its runtime through), the REAL {@link NotificationService} and the
 * REAL boot wiring, because the property under test is that the refusal is
 * seen at that one seam and told exactly once per reason.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDb, runMigrations } from '@dorkos/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { eventFanOut } from '../../core/event-fan-out.js';
import { RuntimeRegistry } from '../../core/runtime-registry.js';
import { NotificationStore } from '../notification-store.js';
import { NotificationService, setNotificationService } from '../notification-service.js';
import { resetSigninEpisodes, setCreditsRefusedSink } from '../../observability/index.js';
import { watchCreditsRefusals } from '../emitters/credits-refused.js';
import { CreditsUnavailableError } from '../../core/cloud/credits-protocols.js';

let store: NotificationStore;

/** Let the emitter's fire-and-forget notification calls settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

function creditsRows(): NotificationDTO[] {
  return store
    .list({ limit: 50, unread: false })
    .notifications.filter((row) => row.kind === 'credits.refused');
}

/** The event a refused credits launch ends its turn with (`creditsRefusalEvent`). */
function refusedTurn(reason: 'folder-sign-in' | 'off') {
  const refusal = new CreditsUnavailableError(reason, 'Claude Code');
  return async function* (): AsyncGenerator<StreamEvent> {
    yield {
      type: 'error',
      data: { message: refusal.message, code: refusal.code, category: 'execution_error' },
    } as StreamEvent;
  };
}

/** A turn that throws the refusal instead of yielding it. */
async function* thrownRefusal(): AsyncGenerator<StreamEvent> {
  throw new CreditsUnavailableError('off', 'Claude Code');
}

async function* ordinaryError(): AsyncGenerator<StreamEvent> {
  yield {
    type: 'error',
    data: { message: 'The tool exited with code 1', category: 'execution_error' },
  } as StreamEvent;
}

/** A background caller: it drains the stream itself and reads nothing in it. */
async function drainLikeATask(registry: RuntimeRegistry, sessionId: string): Promise<void> {
  try {
    for await (const _ of registry.get('claude-code').sendMessage(sessionId, 'hi', {}));
  } catch {
    // A task run records a failure of its own; what matters here is the notice.
  }
  await flush();
}

function registryRunning(scenarios: Array<() => AsyncGenerator<StreamEvent>>): RuntimeRegistry {
  const registry = new RuntimeRegistry();
  const runtime = new FakeAgentRuntime('claude-code');
  runtime.withScenarios(scenarios);
  registry.register(runtime);
  return registry;
}

let stop: () => void;

beforeEach(() => {
  const db = createDb(':memory:');
  runMigrations(db);
  store = new NotificationStore(db);
  setNotificationService(new NotificationService(store));
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => undefined);
  resetSigninEpisodes();
  // The REAL boot wiring: `index.ts` calls exactly this.
  stop = watchCreditsRefusals();
});

afterEach(() => {
  stop();
  setCreditsRefusedSink(null);
  vi.restoreAllMocks();
});

describe('a turn DorkOS credits refused', () => {
  it('raises a notification a person sees, from a turn nobody was watching', async () => {
    const registry = registryRunning([refusedTurn('folder-sign-in')]);
    await drainLikeATask(registry, 'task-session');
    const rows = creditsRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tier: 'notable',
      title: 'A turn didn’t run on DorkOS credits',
      body: expect.stringContaining('name their own sign-in'),
      sessionId: 'task-session',
    });
  });

  it('is told once per reason, however many turns it stops', async () => {
    const registry = registryRunning([
      refusedTurn('folder-sign-in'),
      refusedTurn('folder-sign-in'),
      refusedTurn('folder-sign-in'),
      refusedTurn('off'),
    ]);
    for (const id of ['a', 'b', 'c', 'd']) await drainLikeATask(registry, id);
    const rows = creditsRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.body).some((body) => body?.includes('turned off'))).toBe(true);
  });

  it('is told when the refusal is thrown rather than yielded', async () => {
    const registry = registryRunning([thrownRefusal]);
    await drainLikeATask(registry, 'thrown');
    expect(creditsRows()).toHaveLength(1);
  });

  it('says nothing for an ordinary error', async () => {
    const registry = registryRunning([ordinaryError]);
    await drainLikeATask(registry, 'plain');
    expect(creditsRows()).toHaveLength(0);
  });
});
