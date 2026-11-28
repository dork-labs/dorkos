// @vitest-environment jsdom
/**
 * `sendUiAction` names each click with its own `eventId` (spec
 * `turns-survive-restarts` §6.3), so the server starts at most one turn per click.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionMethods } from '../session-methods';

/** The body each `fetch` call sent, parsed. */
function bodies(): Record<string, unknown>[] {
  return vi
    .mocked(globalThis.fetch)
    .mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: () => Promise.resolve({ sessionId: 's1' }),
    })
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('sendUiAction', () => {
  it('sends a fresh event id with every click, and keeps one it was given', async () => {
    const methods = createSessionMethods('/api', () => 'client-1', new Map(), new Map());
    await methods.sendUiAction('s1', { actionId: 'move' });
    await methods.sendUiAction('s1', { actionId: 'move' });
    await methods.sendUiAction('s1', { actionId: 'move', eventId: 'click-7f3a' });
    const [first, second, given] = bodies();
    expect(first).toMatchObject({ actionId: 'move', eventId: expect.stringMatching(/^[\w-]+$/) });
    expect(second!.eventId).not.toBe(first!.eventId);
    expect(given!.eventId).toBe('click-7f3a');
  });
});
