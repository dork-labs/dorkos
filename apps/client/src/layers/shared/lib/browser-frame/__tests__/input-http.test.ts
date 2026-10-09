// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createBrowserInputHttp } from '../input-http';
const binding = {
  browserId: 'http_input_browser_ref_0001',
  browserGeneration: 1,
  tabId: 'http_input_tab_reference_001',
  navigationGeneration: 0,
  viewportVersion: 0,
  epoch: 0,
  inputGeneration: 0,
};
const command = {
  kind: 'input' as const,
  requestId: 'http_input_request_ref_0001',
  binding,
  steps: [{ kind: 'text' as const, text: 'hello' }],
};
const controllerId = 'http_input_controller_ref_001';
const completed = { requestId: command.requestId, binding, outcome: 'completed' as const };
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('keeps original controller/local admission references in POST only with actual signal and cookie path', async () => {
  const fetch = vi.fn(async () => json(completed));
  vi.stubGlobal('fetch', fetch);
  const signal = new AbortController().signal,
    localTicket = 'L'.repeat(22),
    grant = { grantId: 'http_input_grant_reference_001', revision: 2 };
  const receipt = await createBrowserInputHttp('/api', () => ({ localTicket, grant })).inputBrowser(
    command,
    controllerId,
    signal
  );
  expect(receipt).toEqual(completed);
  expect(Object.isFrozen(receipt.binding)).toBe(true);
  expect(fetch).toHaveBeenCalledWith(
    '/api/browser/input',
    expect.objectContaining({
      credentials: 'include',
      method: 'POST',
      signal,
      body: JSON.stringify({ command, controllerId, localTicket, grant }),
    })
  );
});
it('rejects invalid command/controller/localTicket before fetch using original strict schema bounds', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  for (const [value, id, localTicket] of [
    [{ ...command, steps: [] }, controllerId, undefined],
    [command, 'short', undefined],
    [command, controllerId, 'short'],
  ]) {
    await expect(
      createBrowserInputHttp('/api', () => ({
        localTicket: localTicket as string | undefined,
      })).inputBrowser(value as typeof command, id as string, new AbortController().signal)
    ).rejects.toThrow();
  }
  expect(fetch).not.toHaveBeenCalled();
});
it('refuses mismatched response request, binding, kind and extra permission fields', async () => {
  for (const value of [
    { ...completed, requestId: 'http_input_other_request_001' },
    { ...completed, binding: { ...binding, epoch: 1 } },
    { ...completed, kind: 'action' },
    { ...completed, allowed: true },
  ]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(value))
    );
    await expect(
      createBrowserInputHttp('/api').inputBrowser(
        command,
        controllerId,
        new AbortController().signal
      )
    ).rejects.toThrow();
  }
});
it('observes original abort after a held response instead of publishing a late completed receipt', async () => {
  let release!: (value: Response) => void;
  const pending = new Promise<Response>((yes) => {
    release = yes;
  });
  const fetch = vi.fn(() => pending);
  vi.stubGlobal('fetch', fetch);
  const abort = new AbortController(),
    original = createBrowserInputHttp('/api').inputBrowser(command, controllerId, abort.signal);
  const reason = new Error('lost input lifetime');
  abort.abort(reason);
  release(json(completed));
  await expect(original).rejects.toBe(reason);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('retains the original held JSON body through abort and refuses its late completed receipt', async () => {
  let release!: () => void;
  const held = new Promise<void>((yes) => {
    release = yes;
  });
  const response = json(completed);
  const originalJSON = response.json.bind(response);
  vi.spyOn(response, 'json').mockImplementation(async () => {
    await held;
    return originalJSON();
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response)
  );
  const abort = new AbortController(),
    cause = false;
  const original = createBrowserInputHttp('/api').inputBrowser(command, controllerId, abort.signal);
  let settled = false;
  void original.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  try {
    await vi.waitFor(() => expect(response.json).toHaveBeenCalledTimes(1));
    abort.abort(cause);
    await Promise.resolve();
    expect(settled).toBe(false);
  } finally {
    release();
    await expect(original).rejects.toBe(cause);
  }
});

it.each([undefined, false, null, 0, ''])(
  'retains late original response body cancellation and preserves first abort (%s)',
  async (cause) => {
    let publish!: (value: Response) => void, release!: () => void;
    const responseArrival = new Promise<Response>((yes) => {
      publish = yes;
    });
    const cancellation = new Promise<void>((yes) => {
      release = yes;
    });
    const cancel = vi.fn(() => cancellation);
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { 'Content-Type': 'application/json' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => responseArrival)
    );
    const abort = new AbortController();
    const original = createBrowserInputHttp('/api').inputBrowser(
      command,
      controllerId,
      abort.signal
    );
    let settled = false;
    void original.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    abort.abort(cause);
    const first = abort.signal.reason;
    publish(response);
    try {
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledExactlyOnceWith(first));
      expect(settled).toBe(false);
      expect(response.body?.locked).toBe(false);
    } finally {
      release();
      await expect(original).rejects.toBe(first);
    }
  }
);
it('late original body cancellation rejection cannot replace the first abort failure', async () => {
  let publish!: (value: Response) => void;
  const arrival = new Promise<Response>((yes) => {
    publish = yes;
  });
  const cleanupFailure = new Error('original cancellation refused');
  const cancel = vi.fn(async () => {
    throw cleanupFailure;
  });
  const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
  vi.stubGlobal(
    'fetch',
    vi.fn(() => arrival)
  );
  const abort = new AbortController(),
    cause = false;
  const original = createBrowserInputHttp('/api').inputBrowser(command, controllerId, abort.signal);
  abort.abort(cause);
  publish(response);
  await expect(original).rejects.toBe(cause);
  expect(cancel).toHaveBeenCalledExactlyOnceWith(cause);
});
