/** Nonissuing mechanics controls, not production ownership fixtures. UNRUN. */
import { expect, it, vi } from 'vitest';
import type { PageEvent } from '@dorkos/shared/canvas-channel-schemas';
import { createDocChannelNativePorts } from '../model/doc-channel-native-ports';
const event = {
  v: 1 as const,
  id: '00000000-0000-4000-8000-000000000001',
  type: 'save',
  payload: {},
};
const receipt = {
  receipt: { id: event.id, status: 'recorded' as const, docSeq: 1 },
  deliveries: [],
};
it('retains one original and inspects after generic absence without another submit', async () => {
  const submit = vi.fn(async () => {
    throw new Error('lost');
  });
  const inspect = vi.fn(async () => {
    throw Object.assign(new Error('unknown'), { status: 404 });
  });
  const current = () => true;
  const ports = createDocChannelNativePorts({
    current,
    submit,
    inspect,
    capture: () => ({ current, submit, inspect }),
  });
  const original = ports.captureOriginal(event)!;
  await expect(original.submit(new AbortController().signal)).rejects.toThrow('lost');
  await expect(original.inspect(new AbortController().signal)).rejects.toMatchObject({
    status: 404,
  });
  await expect(original.submit(new AbortController().signal)).rejects.toMatchObject({
    status: 409,
  });
  expect(submit).toHaveBeenCalledTimes(1);
  expect(inspect).toHaveBeenCalledWith(event.id, expect.any(AbortSignal));
  expect(original.bytes).toBe(JSON.stringify(event));
});
it('cannot create a capture when the closed owner callback retires during capture', () => {
  let active = true;
  const current = () => active;
  const submit = vi.fn(async () => receipt),
    inspect = vi.fn(async () => receipt);
  const ports = createDocChannelNativePorts({
    current,
    submit,
    inspect,
    capture: () => {
      active = false;
      return { current, submit, inspect };
    },
  });
  expect(ports.captureOriginal(event)).toBeNull();
  expect(submit).not.toHaveBeenCalled();
});
it('rejects late receipts after a closed operation loses currentness', async () => {
  let active = true;
  const current = () => active;
  const submit = vi.fn(async () => {
    active = false;
    return receipt;
  });
  const inspect = vi.fn(async () => receipt);
  const ports = createDocChannelNativePorts({
    current,
    submit,
    inspect,
    capture: () => ({ current, submit, inspect }),
  });
  await expect(
    ports.captureOriginal(event)!.submit(new AbortController().signal)
  ).rejects.toMatchObject({ status: 409 });
});

it.each(['accepted-b', 'rejected'] as const)(
  'keeps primitive UUID and bytes when closed submit mutates callback input (%s)',
  async (outcome) => {
    const originalEvent = { ...event, payload: { nested: { text: 'original' } } };
    const originalBytes = JSON.stringify(originalEvent),
      otherId = '00000000-0000-4000-8000-000000000002';
    const current = () => true;
    const submit = vi.fn(async (input: PageEvent) => {
      input.id = otherId;
      (input.payload as { nested: { text: string } }).nested.text = 'changed';
      if (outcome === 'rejected') throw new Error('lost after mutation');
      return { receipt: { ...receipt.receipt, id: otherId }, deliveries: [] };
    });
    const inspect = vi.fn(async () => receipt);
    const ports = createDocChannelNativePorts({
      current,
      submit,
      inspect,
      capture: () => ({ current, submit, inspect }),
    });
    const original = ports.captureOriginal(originalEvent)!;
    await expect(original.submit(new AbortController().signal)).rejects.toThrow(
      outcome === 'rejected' ? 'lost after mutation' : 'does not match'
    );
    await expect(original.inspect(new AbortController().signal)).resolves.toEqual(receipt);
    expect(inspect).toHaveBeenCalledWith(event.id, expect.any(AbortSignal));
    expect(original.id).toBe(event.id);
    expect(original.bytes).toBe(originalBytes);
    expect(JSON.stringify(originalEvent)).toBe(originalBytes);
    await expect(original.submit(new AbortController().signal)).rejects.toMatchObject({
      status: 409,
    });
    expect(submit).toHaveBeenCalledTimes(1);
  }
);
