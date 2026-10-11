import { describe, expect, it, vi } from 'vitest';

import { createSignalShutdown } from '../shutdown-signal.js';

describe('createSignalShutdown', () => {
  it('shuts down gracefully once, then exits 0', async () => {
    const exit = vi.fn();
    const services = vi.fn(async () => undefined);
    await createSignalShutdown(services, { exit })();
    expect(services).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('a second signal during shutdown exits at once, without a second shutdown', async () => {
    const exit = vi.fn();
    let release!: () => void;
    const services = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const onSignal = createSignalShutdown(services, { exit });
    const first = onSignal();
    await onSignal();
    expect(exit).toHaveBeenCalledWith(1);
    expect(services).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
});
