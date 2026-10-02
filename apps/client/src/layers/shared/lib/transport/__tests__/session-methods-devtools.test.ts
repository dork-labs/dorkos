/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { createSessionMethods } from '../session-methods';
const methods = () => createSessionMethods('/api', () => 'host', new Map(), new Map());
afterEach(() => vi.unstubAllGlobals());
it('preserves host-owned recording binding and outcome classification in the credentialed multipart request', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetch);
  const abort = new AbortController();
  await methods().uploadDevtoolsRecording(
    'canonical',
    {
      requestId: 'stop',
      documentId: 'doc',
      bridgeGeneration: 'generation',
      hostOutcome: 'host',
      error: 'retired',
    },
    { signal: abort.signal }
  );
  expect(fetch).toHaveBeenCalledWith(
    '/api/sessions/canonical/devtools/recording',
    expect.objectContaining({
      credentials: 'include',
      headers: { 'X-Client-Id': 'host' },
      signal: abort.signal,
    })
  );
  const form = fetch.mock.calls[0][1].body as FormData;
  expect(
    ['requestId', 'documentId', 'bridgeGeneration', 'hostOutcome', 'error'].map((key) =>
      form.get(key)
    )
  ).toEqual(['stop', 'doc', 'generation', 'host', 'retired']);
});
it('stops after a deferred recording-byte await retires, before reading keyframe or publishing HTTP', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  let release!: (bytes: ArrayBuffer) => void;
  const recording = {
    name: 'recording.gif',
    type: 'image/gif',
    size: 1,
    arrayBuffer: () =>
      new Promise<ArrayBuffer>((resolve) => {
        release = resolve;
      }),
  };
  const keyframe = {
    name: 'keyframe.png',
    type: 'image/png',
    size: 1,
    arrayBuffer: vi.fn(async () => new ArrayBuffer(1)),
  };
  const abort = new AbortController();
  const result = methods().uploadDevtoolsRecording(
    'session',
    { requestId: 'stop', frames: 1, durationMs: 500, recording, keyframe },
    { signal: abort.signal }
  );
  const rejected = expect(result).rejects.toThrow();
  abort.abort();
  release(new ArrayBuffer(1));
  await rejected;
  expect(keyframe.arrayBuffer).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
