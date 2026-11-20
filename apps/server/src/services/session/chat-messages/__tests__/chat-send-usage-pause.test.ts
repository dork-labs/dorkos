/** A usage-paused DM never silently accepts a message it cannot run. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { ChatMessageStore } from '../chat-message-store.js';
import { ChatMessageService } from '../chat-message-service.js';

const caller = { sessionId: 'chat-a', agentPath: '/agents/ana' };
const agents = [{ id: 'agent-bo', name: 'bo', displayName: 'Bo', projectPath: '/agents/bo' }];
const RESET = '2026-11-21T07:00:00.000Z';

let service: ChatMessageService;
let store: ChatMessageStore;
let dispatch: ReturnType<typeof vi.fn>;
let busy: boolean;
let pause: { resetsAt: string | null } | null;

beforeEach(() => {
  store = new ChatMessageStore(createTestDb());
  store.keepDmChat(caller.agentPath, 'agent-bo', 'paused-dm');
  busy = false;
  pause = { resetsAt: RESET };
  dispatch = vi.fn(async (opts) => ({
    accepted: true,
    queued: busy,
    canonicalId: opts.sessionId,
    outcome: { messageId: opts.messageId, requested: 'queue', applied: 'queue' },
  }));
  service = new ChatMessageService({
    store,
    meshCore: () =>
      ({
        get: (id: string) => agents.find((a) => a.id === id),
        getProjectPath: (id: string) => agents.find((a) => a.id === id)?.projectPath,
        listWithPaths: () => agents,
      }) as never,
    describeSession: async () => ({
      bound: true,
      launchOrigin: 'chat-message',
      agentPath: '/agents/bo',
      roomBound: false,
      startedByExtension: null,
    }),
    chatTitle: async () => 'Review',
    sessionCwd: async () => '/work/demo',
    isBusy: async () => busy,
    usagePauseOf: async () => pause,
    dispatch: dispatch as never,
    interruptTurn: async () => false,
    steerInto: async () => false,
    canonicalId: async (id) => id,
    turnLevelOf: () => undefined,
    emitActivity: () => {},
    onLifecycle: () => () => {},
  });
});

afterEach(() => service.stop());

describe('sending to an account-limited DM', () => {
  it('tells the sender when it is paused, without claiming acceptance', async () => {
    await expect(
      service.send(caller, { to: 'agent-bo', message: 'Please review.' })
    ).rejects.toThrow(`paused until ${RESET}`);
    expect(dispatch).not.toHaveBeenCalled();
    expect(store.listSentFrom(caller.sessionId)).toEqual([]);
    expect(store.dmChat(caller.agentPath, 'agent-bo')).toBe('paused-dm');
  });

  it('reports an unknown reset honestly', async () => {
    pause!.resetsAt = null;
    await expect(
      service.send(caller, { to: 'agent-bo', message: 'Please review.' })
    ).rejects.toThrow('reset time is unknown');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('never replaces a chat the sender explicitly named', async () => {
    await expect(
      service.send(caller, { to: 'paused-dm', message: 'Please review.' })
    ).rejects.toThrow(`paused until ${RESET}`);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('keeps a healthy DM and its existing account', async () => {
    pause = null;
    const receipt = await service.send(caller, { to: 'agent-bo', message: 'Please review.' });
    expect(receipt.chatId).toBe('paused-dm');
    expect(dispatch.mock.calls[0]![0].request).not.toHaveProperty('account');
  });

  it('keeps messages behind an ongoing turn on their original chat', async () => {
    busy = true;
    const receipt = await service.send(caller, { to: 'agent-bo', message: 'Please review.' });
    expect(receipt.chatId).toBe('paused-dm');
    expect(receipt.status).toBe('queued');
    expect(dispatch.mock.calls[0]![0].request).not.toHaveProperty('account');
  });
});
