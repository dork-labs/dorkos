import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BeforeSendFn, CaptureResult, PostHogConfig } from 'posthog-js';

vi.mock('posthog-js', () => ({ default: { init: vi.fn() } }));

import posthog from 'posthog-js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('instrumentation-client (DOR-4992)', () => {
  it('scrubs error messages from every exception PostHog sends, caught or uncaught', async () => {
    // `@/env` parses process.env when first imported, so the key is set before
    // the module graph loads: PostHog only initialises when a key is present.
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test_key');
    await import('../../instrumentation-client');

    const init = posthog.init as unknown as ReturnType<typeof vi.fn>;
    expect(init).toHaveBeenCalledTimes(1);
    const config = init.mock.calls[0]![1] as Partial<PostHogConfig>;
    // Uncaught errors are captured automatically, so the scrub has to sit on
    // the send path rather than at each call site.
    expect(config.capture_exceptions).toBe(true);

    const beforeSend = config.before_send as BeforeSendFn;
    expect(typeof beforeSend).toBe('function');
    const sent = beforeSend({
      uuid: 'u-1',
      event: '$exception',
      properties: { $exception_list: [{ type: 'Error', value: 'typed text' }] },
    } as CaptureResult);

    expect(JSON.stringify(sent)).not.toContain('typed text');
  });
});
