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

it('original protected Relay drive retirement during SDK acquisition prevents native FIRST and SDK query', async () => {
  const own = await acquisitionFixture();
  expect(sdk.acquisitions).toBe(0);
  const accepted = own.receipt();
  expect(accepted.state).toBe('accepted');
  expect(own.queueCount()).toEqual({ n: 1 });
  sdk.hold = true;
  const drive = own.drive();
  void drive.catch(() => undefined);
  const outcome = drive.then(
    () => ({ refused: false }),
    (cause: unknown) => ({ refused: true, cause })
  );
  let stopping: Promise<void> | undefined;
  let failed = false;
  let first: unknown;
  try {
    await sdk.entered;
    expect(sdk.query).not.toHaveBeenCalled();
    expect(own.receipt()).toEqual(accepted);
    stopping = own.stop();
    void stopping.catch(() => undefined);
    // The original stop owns the queued retirement before acquisition resumes.
    await Promise.resolve();
    sdk.releaseAcquisition();
    await stopping;
    expect(await outcome).toMatchObject({ refused: true });
    expect(sdk.query).not.toHaveBeenCalled();
    expect(own.receipt()).toEqual(accepted);
    expect(own.queueCount()).toEqual({ n: 1 });
    expect(own.f.store.getBatch(own.batch.batchId)).toMatchObject({
      status: 'accepted',
      attempt: 0,
    });
  } catch (cause) {
    failed = true;
    first = cause;
  } finally {
    sdk.releaseAcquisition();
    const joins = await Promise.allSettled([stopping ?? own.stop(), outcome]);
    for (const result of joins)
      if (result.status === 'rejected' && !failed) {
        failed = true;
        first = result.reason;
      }
  }
  if (failed) throw first;
});
