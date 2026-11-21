import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { controlFixture } from './control-fixture.js';
import { heldProtocolCall } from '../../local-browser/__tests__/page-leases-fixture.js';
const fixtures: Awaited<ReturnType<typeof controlFixture>>[] = [];
async function setup() {
  const f = await controlFixture();
  fixtures.push(f);
  await f.controls().take(f.authorize);
  await f.paint();
  return f;
}
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
  vi.useRealTimers();
});
describe('painted viewport checked inside physical operation awaits', () => {
  it.each(['input', 'copy'] as const)(
    'drops %s when viewport changes during broker authorization',
    async (kind) => {
      const f = await setup(),
        gate = heldProtocolCall();
      let calls = 0;
      f.service.useProfileAccess(
        async () => {
          if (++calls === 2) await gate.run();
        },
        () => true
      );
      const result = f
        .controls()
        .run(
          f.operation(),
          (lease, admit) =>
            kind === 'input'
              ? lease.runPerson({ kind: 'text', text: 'NEVER_DISPATCH_OLD_VIEWPORT' }, admit)
              : lease.readSelection(admit),
          f.authorize
        );
      await gate.started;
      await vi.advanceTimersByTimeAsync(84);
      f.emit(800);
      gate.release();
      expect((await result).outcome.status).toBe('refused');
      expect(f.page.page.keyboard.insertText).not.toHaveBeenCalled();
      expect(f.meta().control?.ready).toBe(false);
    }
  );
  it('drops selection before evaluation if viewport changes while creating its isolated world', async () => {
    const f = await setup(),
      gate = heldProtocolCall();
    const protocol = f.protocolSessions.find((s) =>
      s.send.mock.calls.some(([m]) => m === 'Runtime.evaluate')
    )!;
    const original = protocol.send.getMockImplementation()! as (
      method: string,
      params: unknown
    ) => Promise<unknown>;
    protocol.send.mockImplementation(async (method: string, params: unknown) => {
      if (method === 'Page.createIsolatedWorld') {
        await gate.run();
        return { executionContextId: 99 };
      }
      return original(method, params);
    });
    const before = protocol.send.mock.calls.filter(([m]) => m === 'Runtime.evaluate').length;
    const result = f
      .controls()
      .run(f.operation(), (lease, admit) => lease.readSelection(admit), f.authorize);
    await gate.started;
    await vi.advanceTimersByTimeAsync(84);
    f.emit(800);
    gate.release();
    expect((await result).outcome.status).toBe('refused');
    expect(protocol.send.mock.calls.filter(([m]) => m === 'Runtime.evaluate')).toHaveLength(before);
  });
  it('cancels captured chooser and clears payloads if viewport changes during consumption authorization', async () => {
    const f = await setup(),
      gate = heldProtocolCall();
    await f
      .controls()
      .run(
        f.operation(),
        (lease, admit) => lease.runPerson({ kind: 'text', text: 'fixture' }, admit),
        f.authorize
      );
    const setFiles = vi.fn(async (_files: readonly unknown[]) => undefined);
    f.page.events.emit('filechooser', { isMultiple: () => false, setFiles });
    const ticket = f.meta().chooser!.id,
      buffer = Buffer.from('VOLATILE_FILE');
    let calls = 0;
    f.service.useProfileAccess(
      async () => {
        if (++calls === 2) await gate.run();
      },
      () => true
    );
    const result = f
      .controls()
      .files(
        f.operation(),
        ticket,
        async () => [{ name: 'fixture.txt', mimeType: 'text/plain', buffer }],
        f.authorize
      );
    await gate.started;
    await vi.advanceTimersByTimeAsync(84);
    f.emit(800);
    gate.release();
    expect((await result).outcome.status).toBe('refused');
    expect(setFiles).toHaveBeenCalledExactlyOnceWith([]);
    expect(buffer.every((b) => b === 0)).toBe(true);
  });
});
