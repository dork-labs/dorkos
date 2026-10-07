// @vitest-environment jsdom
import { expect, it, vi, onTestFinished } from 'vitest';
import { createBrowserInputHttp } from '../input-http';
const binding = {
  browserId: 'copy_http_browser_ref_00001',
  browserGeneration: 1,
  tabId: 'copy_http_tab_reference_0001',
  navigationGeneration: 0,
  viewportVersion: 0,
  epoch: 0,
  inputGeneration: 0,
};
const command = { requestId: 'copy_http_request_reference_01', binding },
  controllerId = 'copy_http_controller_reference_01';
function fixture(response: Response) {
  const original = vi.fn(async () => response);
  vi.stubGlobal('fetch', original);
  onTestFinished(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  return original;
}
it('uses the original authenticated POST/cookie path and exact correlation', async () => {
  const fetch = fixture(
    new Response(JSON.stringify({ ...command, outcome: 'selected', text: 'ordinary' }), {
      headers: { 'Content-Type': 'application/json' },
    })
  );
  const signal = new AbortController().signal;
  const port = createBrowserInputHttp('/api');
  if (!port.copyBrowserSelection) throw new Error('COPY_PORT_REQUIRED');
  expect(await port.copyBrowserSelection(command, controllerId, signal)).toEqual({
    ...command,
    outcome: 'selected',
    text: 'ordinary',
  });
  expect(fetch).toHaveBeenCalledWith(
    '/api/browser/copy-selection',
    expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      signal,
      body: JSON.stringify({ command, controllerId }),
    })
  );
});
it('rejects mismatched binding without returning text', async () => {
  fixture(
    new Response(
      JSON.stringify({
        ...command,
        binding: { ...binding, epoch: 2 },
        outcome: 'selected',
        text: 'ordinary',
      })
    )
  );
  const port = createBrowserInputHttp('/api');
  if (!port.copyBrowserSelection) throw new Error('COPY_PORT_REQUIRED');
  await expect(
    port.copyBrowserSelection(command, controllerId, new AbortController().signal)
  ).rejects.toThrow('changed');
});
it('retains actual body cancellation when bounded bytes refuse the response', async () => {
  const cancel = vi.fn(async () => {});
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      value.enqueue(new Uint8Array(16385));
    },
    cancel,
  });
  fixture(new Response(body));
  const port = createBrowserInputHttp('/api');
  if (!port.copyBrowserSelection) throw new Error('COPY_PORT_REQUIRED');
  try {
    await expect(
      port.copyBrowserSelection(command, controllerId, new AbortController().signal)
    ).rejects.toThrow('too large');
    expect(cancel).toHaveBeenCalledTimes(1);
  } finally {
    try {
      controller?.close();
    } catch {
      /* The original canceled stream is already terminal. */
    }
  }
});
