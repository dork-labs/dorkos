import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { controlFixture } from './control-fixture.js';
const fixtures: Awaited<ReturnType<typeof controlFixture>>[] = [];
async function setup(setFiles = vi.fn(async (_files: readonly unknown[]) => undefined)) {
  const f = await controlFixture();
  fixtures.push(f);
  await f.controls().take(f.authorize);
  await f.paint();
  await f
    .controls()
    .run(f.operation(), (lease) => lease.runPerson({ kind: 'text', text: 'fixture' }), f.authorize);
  f.page.events.emit('filechooser', { isMultiple: () => true, setFiles });
  expect(f.meta().chooser).not.toBeNull();
  return { ...f, setFiles, ticket: f.meta().chooser! };
}
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
  vi.useRealTimers();
});
describe('captured chooser control before multipart allocation', () => {
  it('uses one captured ticket, clears consumed bytes and refuses replay before reading', async () => {
    const f = await setup();
    const buffer = Buffer.from('MADE_UP_FILE_BYTES');
    const read = vi.fn(async () => [{ name: 'made-up.txt', mimeType: 'text/plain', buffer }]);
    const op = f.operation();
    expect((await f.controls().files(op, f.ticket.id, read, f.authorize)).outcome.status).toBe(
      'done'
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(f.setFiles).toHaveBeenCalledTimes(1);
    expect(buffer.every((b) => b === 0)).toBe(true);
    expect(f.meta().chooser).toBeNull();
    expect(() => f.controls().files(op, f.ticket.id, read, f.authorize)).toThrow();
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('refuses another ticket or navigation before calling the body reader', async () => {
    const f = await setup(),
      read = vi.fn(async () => []);
    expect(() => f.controls().files(f.operation(), 'x'.repeat(43), read, f.authorize)).toThrow(
      'viewer_stale'
    );
    f.page.navigate('https://example.com/next');
    expect(f.meta().chooser).toBeNull();
    await vi.waitFor(() => expect(f.starts().at(-1)!.detach).not.toHaveBeenCalled());
    await f.paint();
    expect(() => f.controls().files(f.operation(), f.ticket.id, read, f.authorize)).toThrow(
      'viewer_stale'
    );
    expect(read).not.toHaveBeenCalled();
  });
  it('cancels a captured chooser after body failure and keeps the error content-free', async () => {
    const f = await setup();
    const result = await f.controls().files(
      f.operation(),
      f.ticket.id,
      async () => {
        throw Error('MADE_UP_BODY_MARKER');
      },
      f.authorize
    );
    expect(result.outcome.status).toBe('refused');
    expect(JSON.stringify(result)).not.toContain('MADE_UP_BODY_MARKER');
    expect(f.setFiles).toHaveBeenCalledWith([]);
    expect(f.meta().chooser).toBeNull();
  });
  it('retains the stuck-picker refusal and custody until the captured page closes', async () => {
    const f = await setup(
      vi.fn(async () => {
        throw Error('cancel failed');
      })
    );
    const op = f.operation();
    await expect(
      f.controls().cancel(op.controllerId, op.controlEpoch, f.ticket.id)
    ).rejects.toMatchObject({ code: 'file_picker_stuck' });
    await expect(
      f.controls().end(op.controllerId, op.controlEpoch, true, f.authorize)
    ).rejects.toMatchObject({ code: 'file_picker_stuck' });
    await expect(f.observe('chat-a')).rejects.toBeDefined();
    await f.page.page.close();
  });
});
