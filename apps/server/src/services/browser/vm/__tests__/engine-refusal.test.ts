import { expect, it } from 'vitest';
import { authors, createDb, runMigrations } from '@dorkos/db';
import { BrowserRegistryStore } from '../../registry/store.js';
import { BrowserRegistry } from '../../registry/registry.js';
import { constructOriginalManagedVMEngine } from '../engine.mjs';
import { issueOriginalVMRuntimeSubject } from '../../runtime/runtime-subject.mjs';
it('does not turn copied installed receipt data into an original runtime subject', async () => {
  await expect(
    issueOriginalVMRuntimeSubject(
      Object.freeze({ runtimeIdentity: 'a'.repeat(64), productionAdmitted: true }),
      0
    )
  ).rejects.toThrow('ORIGINAL_BUILT_RELEASE_REQUIRED');
});
it('captures private dispatchers but refuses copied release before registry birth or native launch', async () => {
  const db = createDb(':memory:');
  let engine: ReturnType<typeof constructOriginalManagedVMEngine> | undefined;
  try {
    runMigrations(db);
    db.insert(authors)
      .values({
        id: 'alice',
        kind: 'human',
        naturalKey: 'user:alice',
        displayName: 'Alice',
        createdAt: '2026-10-09T00:00:00.000Z',
      })
      .run();
    const store = new BrowserRegistryStore(db, 'current'),
      registry = new BrowserRegistry(store, () => true);
    const actual = registry.birthOwner('alice', { mode: 'ephemeral' });
    const captured: unknown[] = [];
    // Explicitly controlled constructor prerequisites only. No prepared network,
    // accepted release, session, native return or profile capability is minted.
    const birthOwner = {
      ...actual,
      capture: {
        registerDispatcher(value: unknown) {
          captured.push(value);
        },
      },
      input: {
        registerDispatcher(value: unknown) {
          captured.push(value);
        },
      },
      navigation: {
        registerDispatcher(value: unknown) {
          captured.push(value);
        },
      },
      semantic: {
        registerDispatcher(value: unknown) {
          captured.push(value);
        },
      },
      network: {
        bindBeforeLaunch() {
          throw new Error('MUST_NOT_LAUNCH');
        },
        activateReady() {
          throw new Error('MUST_NOT_ACTIVATE');
        },
      },
    };
    engine = constructOriginalManagedVMEngine({
      registry: store,
      owner: 'alice',
      dataHome: '/unentered',
      release: {},
      width: 320,
      height: 240,
      birthOwner,
      policy: {
        async authorizeAction() {
          return 'allowed' as const;
        },
        async verifyBrokerLease() {
          return 'valid' as const;
        },
      },
      policyRevision: 0,
    });
    expect(captured).toHaveLength(4);
    await expect(
      engine.open({ kind: 'open', requestId: 'r'.repeat(22), mode: 'ephemeral' })
    ).rejects.toThrow('ORIGINAL_BUILT_RELEASE_REQUIRED');
    expect(store.rows()).toHaveLength(0);
    await engine.shutdown();
  } finally {
    if (engine) await Promise.allSettled([engine.shutdown()]);
    db.$client.close();
  }
});
