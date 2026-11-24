/** Shared setup for the delivery-runner integration suites; cleaned up after every test. */

import { rmSync } from 'node:fs';

import { afterEach, expect, vi } from 'vitest';
import { sessionMessageAcceptanceReceipts, sessionMessageQueue, type Db } from '@dorkos/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';

import { type BatchFixture } from '../batch-fixtures.js';
import { DocChannelAuthorization } from '../../authorization.js';

import { DocBatchDeliveryPump } from '../../delivery/pump.js';
import { DocDeliveryRunner } from '../../delivery/runner.js';

import { RuntimeRegistry } from '../../../../core/runtime-registry.js';
import {
  adoptAcceptedPrivateMessages,
  resetMessageDispatcher,
} from '../../../../session/message-dispatcher.js';
import { setPrivateSessionMessageAcceptanceService } from '../../../../session/private-messages/acceptance.js';
import { setMessageQueueStore } from '../../../../session/message-queue-store.js';
import { SessionEventStore } from '../../../../session/session-event-store.js';
import {
  getOrCreateProjector,
  disposeProjector,
  setSessionEventStore,
} from '../../../../session/session-state-projector.js';

export const databases: Db[] = [];
export const directories: string[] = [];
export const runners: DocDeliveryRunner[] = [];
export const detach: (() => void)[] = [];
export const release: (() => void)[] = [];
afterEach(async () => {
  for (const stop of detach.splice(0)) stop();
  for (const runner of runners.splice(0)) await runner.stop();
  for (const done of release.splice(0)) done();
  await vi.advanceTimersByTimeAsync(1000);
  resetMessageDispatcher();
  setPrivateSessionMessageAcceptanceService(undefined);
  setMessageQueueStore(undefined);
  disposeProjector('session-1');
  disposeProjector('canonical');
  setSessionEventStore(undefined);
  vi.useRealTimers();
  for (const db of databases.splice(0)) if (db.$client.open) db.$client.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
export function barrier() {
  let done!: () => void;
  const promise = new Promise<void>((resolve) => {
    done = resolve;
  });
  release.push(done);
  return { promise, done };
}
export function authorization(f: BatchFixture, principal = f.actor.principal) {
  return new DocChannelAuthorization(f.db, f.documents, {
    ownsInstallation: (claims) =>
      claims.owner.kind === 'local_install' && claims.owner.installationId === 'installation',
    principalCurrent: (proof) => proof === principal,
    revalidateRuntime: async (proof) => proof === principal,
    roomMembership: () => undefined,
  });
}
export function install(f: BatchFixture, fake: FakeAgentRuntime) {
  const registry = new RuntimeRegistry();
  registry.setDb(f.db);
  registry.register(fake);
  setMessageQueueStore(f.queue);
  setPrivateSessionMessageAcceptanceService(f.admission.acceptance);
  const events = new SessionEventStore(f.db);
  setSessionEventStore(events);
  return { registry, events };
}
export function runner(
  f: BatchFixture,
  registry: RuntimeRegistry,
  now: () => Date,
  beforeAdopt?: () => void
) {
  const nudges: { sessionId: string; ids: string[]; receipt: unknown; queue: unknown }[] = [];
  const errors: unknown[] = [];
  const pendingNudges: Promise<void>[] = [];
  const pump = new DocBatchDeliveryPump({
    db: f.db,
    store: f.store,
    grants: f.grants,
    admission: f.admission,
    now,
    ...createPrivateDocPumpGates({ grants: f.grants, runtimes: registry, now }),
    markWaitingWarning: (id, generation, at, tx) =>
      f.store.markWaitingWarning(id, generation, at, tx),
    nudge(sessionId, receiptIds) {
      expect(f.db.$client.inTransaction).toBe(false);
      nudges.push({
        sessionId,
        ids: [...receiptIds],
        receipt: f.db.select().from(sessionMessageAcceptanceReceipts).all(),
        queue: f.db.select().from(sessionMessageQueue).all(),
      });
      beforeAdopt?.();
      pendingNudges.push(
        Promise.all([
          registry.resolveForSession(sessionId),
          registry.getSessionAgentPath(sessionId),
        ])
          .then(([runtime, cwd]) => {
            if (!cwd) throw new Error('No canonical bound path');
            adoptAcceptedPrivateMessages({
              sessionId,
              cwd,
              runtime,
              projector: getOrCreateProjector(sessionId, cwd, { persist: 'history' }),
              privateReceiptSelection: {
                sourceKind: 'document_event_batch',
                receiptIds: [...receiptIds],
              },
            });
          })
          .catch((error: unknown) => {
            errors.push(error);
          })
      );
      return undefined;
    },
  });
  const service = new DocDeliveryRunner({
    pump,
    now,
    onError: (error) => {
      errors.push(error);
    },
  });
  runners.push(service);
  return { service, nudges, errors, flush: async () => Promise.all(pendingNudges) };
}
