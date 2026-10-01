/** Actual source → existing dispatcher → trigger → assembler path, without paid runtimes. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@dorkos/db';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import { sessionMessageAcceptanceReceipts, type Db } from '@dorkos/db';
import { batchFixture, FROM, TO } from './batch-fixtures.js';
import {
  adoptAcceptedPrivateMessages,
  adoptQueuedMessages,
  resetMessageDispatcher,
  noteRuntimeTurnOpen,
} from '../../../session/message-dispatcher.js';
import { setPrivateSessionMessageAcceptanceService } from '../../../session/private-messages/acceptance.js';
import { setMessageQueueStore } from '../../../session/message-queue-store.js';
import {
  disposeProjector,
  getOrCreateProjector,
} from '../../../session/session-state-projector.js';
const databases: Db[] = [];
const directories: string[] = [];
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 40));
}
afterEach(async () => {
  await settle();
  resetMessageDispatcher();
  setPrivateSessionMessageAcceptanceService(undefined);
  setMessageQueueStore(undefined);
  disposeProjector('session-1');
  disposeProjector('canonical');
  for (const db of databases.splice(0)) db.$client.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe('owning-session document dispatch', () => {
  it.each(['claude-code', 'codex', 'opencode', 'test-mode'] as const)(
    'keeps structured document input private through the actual %s trigger',
    async (type) => {
      const f = batchFixture(':memory:', null, undefined, 'boot-1', type);
      databases.push(f.db);
      f.input({ text: 'private-marker' });
      const accepted = f.admission.admit(f.batchId());
      const runtime = new FakeAgentRuntime(type);
      runtime.getInternalSessionId.mockReturnValue(undefined);
      runtime.withScenarios([
        async function* (): AsyncGenerator<StreamEvent> {
          yield { type: 'done', data: {} };
        },
      ]);
      setMessageQueueStore(f.queue);
      setPrivateSessionMessageAcceptanceService(f.admission.acceptance);
      const options = {
        sessionId: 'session-1',
        projector: getOrCreateProjector('session-1'),
        runtime,
      };
      expect(adoptQueuedMessages(options)).toBe(0);
      expect(adoptAcceptedPrivateMessages(options)).toBe(1);
      expect(adoptAcceptedPrivateMessages(options)).toBe(0);
      await settle();
      expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
      expect(runtime.sendMessage).toHaveBeenCalledWith(
        'session-1',
        '[Document update: 1 action]',
        expect.objectContaining({
          additionalContext: expect.arrayContaining([
            expect.objectContaining({
              kind: 'doc_events',
              scope: 'per-turn',
              data: expect.objectContaining({
                documentId: f.documentId,
                scope: FROM,
                events: expect.arrayContaining([
                  expect.objectContaining({ payload: { text: 'private-marker' } }),
                ]),
              }),
            }),
          ]),
        })
      );
      expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()[0]).toMatchObject({
        id: accepted.receipt.id,
        state: 'settled',
        settleOutcome: 'completed',
        originRuntime: type,
      });
    }
  );
  it('refuses a private pump using the wrong runtime even though the stored grant remains valid', async () => {
    const f = batchFixture();
    databases.push(f.db);
    f.input();
    f.admission.admit(f.batchId());
    const runtime = new FakeAgentRuntime('codex');
    runtime.getInternalSessionId.mockReturnValue(undefined);
    setMessageQueueStore(f.queue);
    setPrivateSessionMessageAcceptanceService(f.admission.acceptance);
    adoptAcceptedPrivateMessages({
      sessionId: 'session-1',
      projector: getOrCreateProjector('session-1'),
      runtime,
    });
    await settle();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()[0]?.state).toBe('cancelled');
  });
  it('moves a queued first-turn batch before dispatch, then one canonical pump sends the original receipt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-dispatch-restart-'));
    directories.push(dir);
    const file = join(dir, 'state.db');
    const f = batchFixture(file);
    f.input();
    const accepted = f.admission.admit(f.batchId());
    const before = new FakeAgentRuntime('claude-code');
    before.getInternalSessionId.mockReturnValue(undefined);
    setMessageQueueStore(f.queue);
    setPrivateSessionMessageAcceptanceService(f.admission.acceptance);
    noteRuntimeTurnOpen('session-1');
    expect(
      adoptAcceptedPrivateMessages({
        sessionId: 'session-1',
        projector: getOrCreateProjector('session-1'),
        runtime: before,
      })
    ).toBe(1);
    await settle();
    expect(before.sendMessage).not.toHaveBeenCalled();
    f.documents.rekeyScope(FROM, TO);
    resetMessageDispatcher();
    disposeProjector('session-1');
    f.db.$client.close();
    const db = createDb(file);
    databases.push(db);
    const reboot = batchFixture(
      file,
      null,
      { db, documentId: f.documentId, grantId: f.grantId },
      'boot-2'
    );
    const runtime = new FakeAgentRuntime('claude-code');
    runtime.getInternalSessionId.mockReturnValue(undefined);
    runtime.withScenarios([
      async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} };
      },
    ]);
    setMessageQueueStore(reboot.queue);
    setPrivateSessionMessageAcceptanceService(reboot.admission.acceptance);
    expect(
      adoptAcceptedPrivateMessages({
        sessionId: 'session-1',
        projector: getOrCreateProjector('session-1'),
        runtime,
      })
    ).toBe(0);
    const options = {
      sessionId: 'canonical',
      projector: getOrCreateProjector('canonical'),
      runtime,
    };
    expect(adoptAcceptedPrivateMessages(options)).toBe(1);
    expect(adoptAcceptedPrivateMessages(options)).toBe(0);
    await settle();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(runtime.sendMessage.mock.calls[0]?.[0]).toBe('canonical');
    expect(db.select().from(sessionMessageAcceptanceReceipts).all()[0]?.id).toBe(
      accepted.receipt.id
    );
  });
});
