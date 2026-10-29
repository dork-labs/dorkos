/**
 * An adapter that deliberately sends nothing (`skipped`) leaves nothing behind:
 * no dead letter, and nothing in the pending buffer for a late subscriber.
 * A paused connection drops every message this way (DOR-3271), so a dropped
 * message must not be held anywhere it could be handed on later.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { RelayCore } from '../relay-core.js';
import { noopLogger, type AdapterRegistryLike } from '../types.js';
import type { SubscriptionRegistry } from '../subscription-registry.js';

const dirs: string[] = [];
const cores: RelayCore[] = [];
afterEach(async () => {
  for (const core of cores.splice(0)) await core.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function db(): Db {
  const database = createDb(':memory:');
  runMigrations(database);
  return database;
}

it('neither buffers nor dead-letters a message an adapter skipped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-skipped-'));
  dirs.push(dir);
  const registry = {
    deliver: vi.fn(async () => ({ success: true, skipped: true, durationMs: 0 })),
    setRelay() {},
    shutdown: async () => {},
  } satisfies AdapterRegistryLike;
  const core = new RelayCore({
    db: db(),
    dataDir: dir,
    adapterRegistry: registry,
    logger: noopLogger,
  });
  cores.push(core);
  const subscriptions = (core as unknown as { subscriptionRegistry: SubscriptionRegistry })
    .subscriptionRegistry;
  const buffer = vi.spyOn(subscriptions, 'bufferForPendingSubscriber');

  await core.publish('relay.webhook.paused', { n: 1 }, { from: 'relay.agent.backend' });

  expect(registry.deliver).toHaveBeenCalledTimes(1);
  expect(buffer).not.toHaveBeenCalled();
  expect(await core.getDeadLetters()).toEqual([]);
});
