import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { controlFixture, person } from './control-fixture.js';
const fixtures: Awaited<ReturnType<typeof controlFixture>>[] = [];
async function setup() {
  const f = await controlFixture();
  fixtures.push(f);
  return f;
}
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
  vi.useRealTimers();
});
describe('server-verified paint and address authority', () => {
  it('keeps the first takeover input-off until a consumed real paint and matching address', async () => {
    const f = await setup();
    await f.controls().take(f.authorize);
    expect(f.meta().control?.ready).toBe(false);
    const { frame, state } = await f.paint();
    expect(f.meta().control?.ready).toBe(true);
    const effect = vi.fn(async () => undefined),
      op = f.operation();
    expect((await f.controls().run(op, effect, f.authorize)).outcome.status).toBe('done');
    expect(effect).toHaveBeenCalledTimes(1);
    // A replay returns only the cached content-free outcome, never dispatching twice.
    expect((await f.controls().run(op, effect, f.authorize)).outcome.status).toBe('done');
    expect(effect).toHaveBeenCalledTimes(1);
    await expect(
      f.ack(frame.receipt, {
        addressReceipt: state.viewerAddress!.receipt,
        viewportGeneration: frame.viewport.generation,
      })
    ).rejects.toMatchObject({ code: 'viewer_denied' });
  });
  it('can pair a consumed paint receipt with a later address snapshot on a static page', async () => {
    const f = await setup();
    await f.controls().take(f.authorize);
    await vi.waitFor(() => expect(f.starts().at(-1)!.detach).not.toHaveBeenCalled());
    f.emit();
    const frame = (await f.registry.frame(person, f.viewer.viewerId, f.viewer.nonce))!;
    await f.ack(frame.receipt);
    expect(f.meta().control?.ready).toBe(false);
    const state = await f.address();
    await f.ack(undefined, {
      addressReceipt: state.viewerAddress!.receipt,
      viewportGeneration: frame.viewport.generation,
    });
    expect(f.meta().control?.ready).toBe(true);
  });
  it('does not accept an address or viewport from another viewer', async () => {
    const f = await setup();
    await f.controls().take(f.authorize);
    await vi.waitFor(() => expect(f.starts().at(-1)!.detach).not.toHaveBeenCalled());
    f.emit();
    const frame = (await f.registry.frame(person, f.viewer.viewerId, f.viewer.nonce))!;
    const other = await f.registry.subscribe({ ...person, clientId: 'other' }, 'chat-a');
    const state = await f.registry.address(
      { ...person, clientId: 'other' },
      other.viewerId,
      other.nonce,
      'chat-a',
      () => f.service.personState('chat-a')
    );
    // Populate this viewer's receipt too: dropping the exact receipt comparison must fail.
    await f.address();
    await f.ack(frame.receipt, {
      addressReceipt: state.viewerAddress!.receipt,
      viewportGeneration: frame.viewport.generation,
    });
    expect(f.meta().control?.ready).toBe(false);
    const own = await f.address();
    await f.ack(undefined, {
      addressReceipt: own.viewerAddress!.receipt,
      viewportGeneration: frame.viewport.generation + 1,
    });
    expect(f.meta().control?.ready).toBe(false);
  });
  it('retains same-site custody but rejects old operations until a fresh generation is painted', async () => {
    const f = await setup();
    await f.controls().take(f.authorize);
    await f.paint();
    const old = f.operation(),
      id = f.meta().control!.id,
      count = f.starts().length;
    f.page.navigate('https://example.com/next');
    expect(f.meta().control?.ready).toBe(false);
    const effect = vi.fn(async () => undefined);
    expect(() => f.controls().run(old, effect, f.authorize)).toThrow();
    await vi.waitFor(() => expect(f.starts()).toHaveLength(count + 1));
    await f.paint();
    expect(f.meta().control?.id).toBe(id);
    expect(f.meta().control?.ready).toBe(true);
    expect((await f.controls().run(f.operation(), effect, f.authorize)).outcome.status).toBe(
      'done'
    );
  });
  it('rechecks session admission after queuing and never runs a refused operation', async () => {
    const f = await setup();
    await f.controls().take(f.authorize);
    await f.paint();
    const effect = vi.fn(async () => undefined),
      op = f.operation();
    const denied = async () => {
      throw Error('session ended');
    };
    expect((await f.controls().run(op, effect, denied)).outcome.status).toBe('refused');
    expect(effect).not.toHaveBeenCalled();
  });
  it.each(['resume', 'abandon', 'off'] as const)(
    '%s clears controller authority without closing the Page',
    async (action) => {
      const f = await setup();
      await f.controls().take(f.authorize);
      await f.paint();
      const op = f.operation(),
        effect = vi.fn(async () => undefined);
      if (action === 'off') f.off();
      else
        await f.controls().end(op.controllerId, op.controlEpoch, action === 'resume', f.authorize);
      expect(f.meta().control).toBeNull();
      expect(f.page.page.isClosed()).toBe(false);
      expect(() => f.controls().run(op, effect, f.authorize)).toThrow();
      if (action === 'resume') await expect(f.observe('chat-a')).resolves.toBeDefined();
      else await expect(f.observe('chat-a')).rejects.toBeDefined();
    }
  );
});
