import { describe, expect, it } from 'vitest';
import { DeliveryReceiptGate } from '../delivery-receipt-gate.js';

describe('DeliveryReceiptGate', () => {
  it('holds a persisted agent receipt until release and cleans up the one-use gate', async () => {
    const gate = new DeliveryReceiptGate();
    const channelId = 'c8a9058c-1e76-4297-a84f-12b0ce830973';
    const controller = new AbortController();
    expect(gate.arm(channelId)).toEqual({ state: 'armed', channelId, phase: 'after-persist' });
    let complete = false;
    const held = gate
      .holdAfterPersist({ channelId, entryId: 'entry-1', signal: controller.signal })
      .then(() => {
        complete = true;
      });
    expect(gate.observation()).toEqual({ state: 'held', channelId, entryId: 'entry-1' });
    expect(complete).toBe(false);
    expect(gate.release()).toEqual({ state: 'idle' });
    await held;
    expect(complete).toBe(true);
    expect(gate.observation()).toEqual({ state: 'idle' });
  });

  it('releases a held request when its client aborts', async () => {
    const gate = new DeliveryReceiptGate();
    const controller = new AbortController();
    gate.arm('f7a5da48-61c4-43df-8cfe-1acb98333c8e');
    const held = gate.holdAfterPersist({
      channelId: 'f7a5da48-61c4-43df-8cfe-1acb98333c8e',
      entryId: 'entry-2',
      signal: controller.signal,
    });
    controller.abort();
    await held;
    expect(gate.observation()).toEqual({ state: 'idle' });
  });

  it('makes release idempotent, including before a matching post arrives', () => {
    const gate = new DeliveryReceiptGate();
    gate.arm('f7a5da48-61c4-43df-8cfe-1acb98333c8e');
    expect(gate.release()).toEqual({ state: 'idle' });
    expect(gate.release()).toEqual({ state: 'idle' });
  });
  it('holds before persistence independently of the after-persist receipt phase', async () => {
    const gate = new DeliveryReceiptGate();
    const channelId = 'c8a9058c-1e76-4297-a84f-12b0ce830973';
    const signal = new AbortController().signal;
    gate.arm(channelId, 'before-persist');
    await gate.holdAfterPersist({ channelId, entryId: 'unrelated', signal });
    expect(gate.observation().state).toBe('armed');
    let persisted = false;
    const post = gate.holdBeforePersist({ channelId, signal }).then(() => {
      persisted = true;
    });
    expect(gate.observation()).toEqual({ state: 'held-before-persist', channelId });
    expect(persisted).toBe(false);
    gate.release();
    await post;
    expect(persisted).toBe(true);
    expect(gate.observation()).toEqual({ state: 'idle' });
  });

  it('does not continue into persistence when the held request aborts', async () => {
    const gate = new DeliveryReceiptGate();
    const channelId = 'c8a9058c-1e76-4297-a84f-12b0ce830973';
    const controller = new AbortController();
    gate.arm(channelId, 'before-persist');
    let persisted = false;
    const post = gate.holdBeforePersist({ channelId, signal: controller.signal }).then(() => {
      persisted = true;
    });
    const rejected = expect(post).rejects.toThrow();
    controller.abort();
    await rejected;
    expect(persisted).toBe(false);
    expect(gate.observation()).toEqual({ state: 'idle' });
  });
});
