/** Delayed provider acquisition never replaces the original native runtime or claim. */
import { expect, it, vi } from 'vitest';
import { acquisitionFixture } from './sdk-acquisition-native-fixture.js';
const sdk = vi.hoisted(() => {
  let entered!: () => void;
  let release!: () => void;
  return {
    hold: false,
    acquisitions: 0,
    entered: new Promise<void>((done) => {
      entered = done;
    }),
    release: new Promise<void>((done) => {
      release = done;
    }),
    markEntered: () => entered(),
    releaseAcquisition: () => release(),
    query: vi.fn(() => {
      throw new Error('A retired native owner must never enter SDK query');
    }),
  };
});
vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  sdk.acquisitions += 1;
  sdk.markEntered();
  if (sdk.hold) await sdk.release;
  return { query: sdk.query };
});

it('original native sender return during SDK acquisition retires before query', async () => {
  const own = await acquisitionFixture();
  expect(sdk.acquisitions).toBe(0);
  own.runtime.ensureSession('session-1', { permissionMode: 'default', cwd: own.agentPath });
  sdk.hold = true;
  const stream = own.runtime.sendMessage('session-1', 'Original deferred sender input', {
    cwd: own.agentPath,
  });
  const events: import('@dorkos/shared/types').StreamEvent[] = [];
  const running = (async () => {
    for await (const event of stream) events.push(event);
  })();
  // Attach rejection handling before Stop/currentness can refuse a pending read.
  void running.catch(() => undefined);
  const outcome = running.then(
    () => ({ refused: false }),
    (cause: unknown) => ({ refused: true, cause })
  );
  let failed = false;
  let first: unknown;
  own.nativeDrains.push(async () => {
    sdk.releaseAcquisition();
    await stream.return(undefined);
    await outcome;
  });
  try {
    await sdk.entered;
    expect(sdk.query).not.toHaveBeenCalled();
    const returning = stream.return(undefined);
    void returning.catch(() => undefined);
    sdk.releaseAcquisition();
    await returning;
    await outcome;
    expect(sdk.query).not.toHaveBeenCalled();
    expect(
      events.some(
        (event) =>
          event.type === 'text_delta' ||
          event.type === 'tool_call_start' ||
          event.type === 'tool_call_delta' ||
          event.type === 'tool_call_end'
      )
    ).toBe(false);
    expect((await stream.next()).done).toBe(true);
    // The unrelated protected document was never claimed by this ordinary sender.
    expect(own.receipt().state).toBe('accepted');
    expect(own.queueCount()).toEqual({ n: 1 });
  } catch (cause) {
    failed = true;
    first = cause;
  } finally {
    sdk.releaseAcquisition();
    const joins = await Promise.allSettled([stream.return(undefined), outcome]);
    for (const result of joins)
      if (result.status === 'rejected' && !failed) {
        failed = true;
        first = result.reason;
      }
  }
  if (failed) throw first;
});
