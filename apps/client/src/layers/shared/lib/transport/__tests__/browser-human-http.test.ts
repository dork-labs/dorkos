import { afterEach, expect, it, vi } from 'vitest';
import { createBrowserHumanHttp, BrowserHumanHttpRefusal } from '../browser-human-http';
const binding = {
  browserId: 'browser_http_human_fixture01',
  browserGeneration: 1,
  tabId: 'tab_http_human_fixture001',
  navigationGeneration: 0,
  viewportVersion: 0,
  epoch: 0,
  inputGeneration: 0,
};
const grant = { grantId: 'grant_http_human_fixture01', revision: 0 };
const stage = {
  binding,
  artifactGrant: grant,
  name: 'file.txt',
  mimeType: 'text/plain' as const,
  base64: 'aGk=',
};
const signal = () => new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());
it('stages bounded JSON with original same-origin credentials and no actor/path payload', async () => {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ artifactId: 'artifact_http_human_fixture01', byteLength: 2 }))
  );
  vi.stubGlobal('fetch', fetch);
  await createBrowserHumanHttp('/api').files.stageBrowserFile(stage, signal());
  expect(fetch).toHaveBeenCalledWith(
    '/api/browser/files/stage',
    expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify(stage),
    })
  );
});
it('a forged actor/path or mismatched command binding is refused before original fetch', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const http = createBrowserHumanHttp('/api');
  await expect(
    http.files.stageBrowserFile({ ...stage, owner: 'forged' } as typeof stage, signal())
  ).rejects.toThrow();
  await expect(
    http.files.uploadBrowserFile(
      {
        binding,
        artifactGrant: grant,
        transferGrant: grant,
        controllerId: 'controller_http_fixture001',
        command: {
          kind: 'upload',
          requestId: 'request_http_human_fixture01',
          binding: { ...binding, epoch: 1 },
          artifactId: 'artifact_http_human_fixture01',
          activation: { x: 1, y: 2 },
        },
      },
      signal()
    )
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it('artifact ID and decoded length remain exact; metadata cannot substitute another original download', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            artifactId: 'artifact_other_human_fixture01',
            byteLength: 2,
            name: 'file.txt',
            mimeType: 'text/plain',
            base64: 'aGk=',
          })
        )
    )
  );
  await expect(
    createBrowserHumanHttp('/api').files.readBrowserArtifact(
      { binding, artifactGrant: grant, artifactId: 'artifact_http_human_fixture01' },
      signal()
    )
  ).rejects.toThrow('BROWSER_ARTIFACT_MISMATCH');
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            artifactId: 'artifact_http_human_fixture01',
            byteLength: 3,
            name: 'file.txt',
            mimeType: 'text/plain',
            base64: 'aGk=',
          })
        )
    )
  );
  await expect(
    createBrowserHumanHttp('/api').files.readBrowserArtifact(
      { binding, artifactGrant: grant, artifactId: 'artifact_http_human_fixture01' },
      signal()
    )
  ).rejects.toThrow('BROWSER_ARTIFACT_LENGTH');
});
it('retains original HTTP refusal when original response cancellation throws a falsy cause', async () => {
  const cancelled = vi.fn(() => {
    throw false;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled }), { status: 404 }))
  );
  let failure: unknown;
  try {
    await createBrowserHumanHttp('/api').files.stageBrowserFile(stage, signal());
  } catch (value) {
    failure = value;
  }
  expect(failure).toBeInstanceOf(BrowserHumanHttpRefusal);
  expect(failure).toMatchObject({ status: 404 });
  expect(cancelled).toHaveBeenCalledOnce();
});
it('aborted admission enters no request and oversized JSON response is bounded before parse', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const abort = new AbortController();
  abort.abort(false);
  await expect(
    createBrowserHumanHttp('/api').files.stageBrowserFile(stage, abort.signal)
  ).rejects.toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('x'.repeat(16385)))
  );
  await expect(
    createBrowserHumanHttp('/api').files.stageBrowserFile(stage, signal())
  ).rejects.toThrow('BROWSER_RESPONSE_BOUND');
});

it.each(['overflow', 'readFailure', 'abort'] as const)(
  'clears all original returned response chunks after %s and preserves first cause',
  async (mode) => {
    const first = new Uint8Array([65, 66, 67]);
    const second = new Uint8Array(mode === 'overflow' ? 16384 : 3).fill(68);
    const abort = new AbortController();
    let pull = 0;
    const cancel = vi.fn(() => {
      throw false;
    });
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (pull++ === 0) {
            controller.enqueue(first);
            return;
          }
          if (mode === 'readFailure') {
            controller.error(undefined);
            return;
          }
          controller.enqueue(second);
          if (mode === 'abort') abort.abort(undefined);
        },
        cancel,
      },
      { highWaterMark: 0 }
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body))
    );
    let failure: Readonly<{ value: unknown }> | undefined;
    try {
      await createBrowserHumanHttp('/api').files.stageBrowserFile(stage, abort.signal);
    } catch (value) {
      failure = { value };
    }
    expect(first.every((value) => value === 0)).toBe(true);
    if (mode !== 'readFailure') expect(second.every((value) => value === 0)).toBe(true);
    expect(failure).toBeDefined();
    if (mode === 'overflow')
      expect(failure?.value).toMatchObject({ message: 'BROWSER_RESPONSE_BOUND' });
    if (mode === 'readFailure') expect(failure?.value).toBeUndefined();
    if (mode === 'abort') expect(failure?.value).toBe(abort.signal.reason);
  }
);
