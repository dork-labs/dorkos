import { expect, it, vi } from 'vitest';
import { createBrowserSharePolicy } from '../agent-profiles/sharing-policy.js';
import type { OutsideTurnReason } from '../handoff-guards/outside-turn-reason.js';

function setup() {
  const state = vi.fn(
    async (): Promise<{ sessionId: string | null; profile: { agentId: string } }> => ({
      sessionId: 'panel-chat',
      profile: { agentId: 'atlas' },
    })
  );
  const resolveSessionRuntime = vi.fn(async () => ({ type: 'example', bound: true }));
  const outsideTurn = vi.fn(async (): Promise<OutsideTurnReason | null> => null);
  const getLockInfo = vi.fn(
    (_key: string): { clientId: string; acquiredAt: number } | null => null
  );
  const getInternalSessionId = vi.fn((_id: string): string | undefined => undefined);
  const runtime = { getLockInfo, getInternalSessionId };
  const mayShare = createBrowserSharePolicy({
    state,
    resolveSessionRuntime,
    outsideTurn,
    runtime: () => runtime,
  });
  return { mayShare, state, resolveSessionRuntime, outsideTurn, getLockInfo, getInternalSessionId };
}

it('refuses a stranger chat even while idle', async () => {
  const t = setup();
  t.outsideTurn.mockResolvedValue('stranger_chat');
  await expect(t.mayShare('atlas')).resolves.toBe(false);
});

it('refuses a marked turn while it is running', async () => {
  const t = setup();
  t.outsideTurn.mockResolvedValue('read_outside_text');
  t.getLockInfo.mockReturnValue({ clientId: 'agent', acquiredAt: 1 });
  await expect(t.mayShare('atlas')).resolves.toBe(false);
});

it('uses the internal session id to find a running marked turn', async () => {
  const t = setup();
  t.outsideTurn.mockResolvedValue('outsider_turn');
  t.getInternalSessionId.mockReturnValue('runtime-chat');
  t.getLockInfo.mockImplementation((id) =>
    id === 'runtime-chat' ? { clientId: 'agent', acquiredAt: 1 } : null
  );
  await expect(t.mayShare('atlas')).resolves.toBe(false);
  expect(t.getLockInfo).toHaveBeenCalledWith('runtime-chat');
});

it('allows an idle clean holding chat', async () => {
  const t = setup();
  await expect(t.mayShare('atlas')).resolves.toBe(true);
  expect(t.outsideTurn).toHaveBeenCalledWith('panel-chat');
});

it('refuses when another agent holds the browser', async () => {
  const t = setup();
  await expect(t.mayShare('bolt')).resolves.toBe(false);
});

it('refuses a chat whose runtime is not bound', async () => {
  const t = setup();
  t.resolveSessionRuntime.mockResolvedValue({ type: 'example', bound: false });
  await expect(t.mayShare('atlas')).resolves.toBe(false);
});

it('refuses when no chat holds the browser', async () => {
  const t = setup();
  t.state.mockResolvedValue({ sessionId: null, profile: { agentId: 'atlas' } });
  await expect(t.mayShare('atlas')).resolves.toBe(false);
});
