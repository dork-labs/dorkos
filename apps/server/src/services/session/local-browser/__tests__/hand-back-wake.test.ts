/** The server wakes the waiting agent after a hand back, with fixed text only (DOR-3112). */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalBrowserHandoff } from '@dorkos/shared/local-browser';
import { logger } from '../../../../lib/logger.js';
import { HAND_BACK_CLIENT_ID, HANDED_BACK_MESSAGE, handBackWake } from '../hand-back-wake/index.js';
import { handBackWakeHarness } from './hand-back-wake-harness.js';

const handoff = (outcome: LocalBrowserHandoff['outcome']): LocalBrowserHandoff => ({
  id: 'h1',
  sessionId: 'chat-1',
  agentName: 'Ana',
  agentId: 'agent-ana',
  agentFolder: '/agents/ana',
  profileId: null,
  reason: 'wall',
  site: 'checkout.made-up-shop.example',
  askedAt: '2026-11-11T12:00:00.000Z',
  outcome,
});

let home: string;
let harness: Awaited<ReturnType<typeof handBackWakeHarness>>;
const roomSessionPlace = {
  roomFor: vi.fn(() => null as { roomId: string; agentName: string; agentPath: string } | null),
  placeTurn: vi.fn(async () => ({
    cwd: home,
    additionalDirectories: [],
    worktree: null,
    standsInCopy: false,
  })),
};
const meshCore = vi.fn(() => undefined);
const roomPlace = vi.fn(() => roomSessionPlace);
const wake = () => handBackWake({ meshCore, roomSessionPlace: roomPlace });

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'hand-back-wake-'));
  harness = await handBackWakeHarness(home, 'chat-1');
  meshCore.mockClear();
  roomPlace.mockClear();
  roomSessionPlace.roomFor.mockReset().mockReturnValue(null);
  roomSessionPlace.placeTurn.mockClear();
});
afterEach(async () => {
  await harness.dispose();
  await rm(home, { recursive: true, force: true });
});

describe('handBackWake', () => {
  it('sends the fixed message into the handed-back chat as the person’s turn', async () => {
    wake()(handoff('handed-back'));
    await vi.waitFor(() => expect(harness.runtime.sendMessage).toHaveBeenCalledOnce());
    expect(harness.runtime.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      HANDED_BACK_MESSAGE,
      expect.objectContaining({ turnStarter: 'person', cwd: home })
    );
    expect(harness.runtime.acquireLock.mock.calls[0]?.slice(0, 2)).toEqual([
      'chat-1',
      HAND_BACK_CLIENT_ID,
    ]);
    expect(meshCore).toHaveBeenCalledOnce();
    expect(roomPlace).toHaveBeenCalledOnce();
    expect(roomSessionPlace.roomFor).toHaveBeenCalledWith('chat-1');
  });

  it('carries nothing from the handoff but its chat: no site, agent or address', async () => {
    wake()(handoff('handed-back'));
    await vi.waitFor(() => expect(harness.runtime.sendMessage).toHaveBeenCalledOnce());
    const [, content, opts] = harness.runtime.sendMessage.mock.calls[0]!;
    expect(content).toBe('I’m done in the browser. Please continue.');
    const sent = JSON.stringify({ content, opts });
    for (const fromPage of ['made-up-shop', 'http', 'Ana', '/agents/ana'])
      expect(sent).not.toContain(fromPage);
  });

  it('sends nothing on Stop, a closed window, or a handoff still open', () => {
    const listener = wake();
    listener(handoff('stopped'));
    listener(handoff('window-closed'));
    listener(handoff(null));
    expect(meshCore).not.toHaveBeenCalled();
    expect(roomPlace).not.toHaveBeenCalled();
    expect(harness.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('never throws when the chat refuses or the send fails', async () => {
    const warning = vi.spyOn(logger, 'warn');
    roomSessionPlace.roomFor.mockReturnValue({ roomId: 'r1', agentName: 'Test', agentPath: home });
    roomSessionPlace.placeTurn
      .mockResolvedValueOnce({
        cwd: home,
        additionalDirectories: [],
        worktree: null,
        standsInCopy: true,
      })
      .mockRejectedValueOnce(new Error('disk full'));
    try {
      const listener = wake();
      expect(() => listener(handoff('handed-back'))).not.toThrow();
      await vi.waitFor(() =>
        expect(warning).toHaveBeenCalledWith(
          '[Browser] Couldn’t wake the agent after a hand back',
          { handoffId: 'h1', refused: 'ROOM_SESSION_MOVED' }
        )
      );
      expect(() => listener(handoff('handed-back'))).not.toThrow();
      await vi.waitFor(() =>
        expect(warning).toHaveBeenCalledWith(
          '[Browser] Couldn’t wake the agent after a hand back',
          { handoffId: 'h1', error: 'disk full' }
        )
      );
      expect(harness.runtime.sendMessage).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });
});
