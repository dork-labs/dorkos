/** The server wakes the waiting agent after a hand back, with fixed text only (DOR-3112). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalBrowserHandoff } from '@dorkos/shared/local-browser';

const dispatch = vi.hoisted(() => vi.fn());
vi.mock('../../launch/launch-session.js', () => ({
  dispatchSessionMessage: dispatch,
  isSessionLaunchRefusal: (result: { refused?: string }) => typeof result?.refused === 'string',
}));

const { HAND_BACK_CLIENT_ID, HANDED_BACK_MESSAGE, handBackWake } =
  await import('../hand-back-wake/index.js');

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

const meshCore = { fake: 'mesh' } as never;
const roomSessionPlace = { fake: 'rooms' } as never;
const wake = () =>
  handBackWake({ meshCore: () => meshCore, roomSessionPlace: () => roomSessionPlace });

beforeEach(() => {
  dispatch.mockReset();
  dispatch.mockResolvedValue({ accepted: true });
});

describe('handBackWake', () => {
  it('sends the fixed message into the handed-back chat as the person’s turn', async () => {
    wake()(handoff('handed-back'));
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(dispatch).toHaveBeenCalledWith({
      origin: { kind: 'interactive' },
      sessionId: 'chat-1',
      request: { content: HANDED_BACK_MESSAGE },
      clientId: HAND_BACK_CLIENT_ID,
      meshCore,
      roomSessionPlace,
    });
  });

  it('carries nothing from the handoff but its chat: no site, agent or address', async () => {
    wake()(handoff('handed-back'));
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    const [opts] = dispatch.mock.calls[0] as [{ request: { content: string } }];
    expect(opts.request.content).toBe('I’m done in the browser. Please continue.');
    const sent = JSON.stringify(opts);
    for (const fromPage of ['made-up-shop', 'http', 'Ana', '/agents/ana'])
      expect(sent).not.toContain(fromPage);
  });

  it('sends nothing on Stop, a closed window, or a handoff still open', () => {
    const listener = wake();
    listener(handoff('stopped'));
    listener(handoff('window-closed'));
    listener(handoff(null));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('never throws when the chat refuses or the send fails', async () => {
    dispatch
      .mockResolvedValueOnce({ refused: 'SESSION_NOT_FOUND', message: 'gone' })
      .mockRejectedValueOnce(new Error('disk full'));
    const listener = wake();
    expect(() => listener(handoff('handed-back'))).not.toThrow();
    expect(() => listener(handoff('handed-back'))).not.toThrow();
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
  });
});
