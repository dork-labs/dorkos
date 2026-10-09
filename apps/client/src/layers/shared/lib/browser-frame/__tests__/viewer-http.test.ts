// @vitest-environment jsdom
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { createBrowserViewerHttp, BROWSER_FRAME_CONTENT_TYPE } from '../viewer-http';
import { readBrowserFrameBody } from '../../transport/browser-frame-body';
import { getAuthRequired, setAuthRequired } from '../../auth-signal';

const base = 'http://localhost:4242/api';
const binding = {
  browserId: 'browser_fixture_000000001',
  browserGeneration: 1,
  tabId: 'tab_fixture_00000000000001',
  navigationGeneration: 0,
  viewportVersion: 0,
  epoch: 0,
  inputGeneration: 0,
};
const viewer = {
  viewerId: 'viewer_fixture_000000000001',
  binding,
  expiresAt: '2099-01-01T00:00:00.000Z',
};
const ticket = 'T'.repeat(43),
  localTicket = 'L'.repeat(43);
function serve(response: Response, issueResponse = false) {
  const fetch = vi.fn(async (url: string, _opts?: RequestInit) =>
    url.endsWith('/issue') && !issueResponse ? json({ viewer, ticket }) : response
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
async function delivery(context: () => { localTicket?: string } = () => ({})) {
  const port = createBrowserViewerHttp(base, context);
  await port.issueBrowserViewer(binding, new AbortController().signal);
  return port;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setAuthRequired(false);
});

it('issues exact binding with actual captured context and original cookie/signal path', async () => {
  const signal = new AbortController().signal;
  const grant = { grantId: 'grant_fixture_000000000001', revision: 2 };
  const fetch = serve(json({ viewer, ticket }), true);
  const result = await createBrowserViewerHttp(base, () => ({
    grant,
    localTicket,
  })).issueBrowserViewer(binding, signal);
  expect(result).toEqual({ viewer, ticket });
  expect(Object.isFrozen(result.viewer.binding)).toBe(true);
  expect(fetch).toHaveBeenCalledWith(
    `${base}/browser/viewers/issue`,
    expect.objectContaining({
      credentials: 'include',
      method: 'POST',
      signal,
      body: JSON.stringify({ binding, localTicket, grant }),
    })
  );
});
it('refuses extra issue keys, wrong binding and malformed ticket rather than returning a new viewer', async () => {
  for (const body of [
    { viewer, ticket, authority: true },
    { viewer: { ...viewer, binding: { ...binding, epoch: 1 } }, ticket },
    { viewer, ticket: 'short' },
  ]) {
    serve(json(body), true);
    await expect(
      createBrowserViewerHttp(base).issueBrowserViewer(binding, new AbortController().signal)
    ).rejects.toThrow();
  }
});
it('next keeps ticket in POST body, returns the original stream and enters no reader', async () => {
  const response = new Response(new Uint8Array([1, 2, 3]), {
    headers: { 'Content-Type': BROWSER_FRAME_CONTENT_TYPE },
  });
  const body = response.body!;
  const read = vi.spyOn(body, 'getReader');
  const signal = new AbortController().signal;
  const fetch = serve(response);
  expect(
    await (
      await delivery(() => ({
        localTicket,
      }))
    ).nextBrowserViewerFrame(ticket, undefined, signal)
  ).toBe(body);
  expect(read).not.toHaveBeenCalled();
  expect(body.locked).toBe(false);
  expect(fetch).toHaveBeenCalledWith(
    `${base}/browser/viewers/next`,
    expect.objectContaining({
      credentials: 'include',
      signal,
      method: 'POST',
      body: JSON.stringify({ ticket, localTicket }),
    })
  );
});
it('the sole bounded consumer refuses oversized metadata and cancels the actual response body', async () => {
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([255, 255, 255, 255]));
    },
    cancel: cancelled,
  });
  serve(
    new Response(body, {
      headers: { 'Content-Type': BROWSER_FRAME_CONTENT_TYPE },
    })
  );
  const signal = new AbortController().signal;
  const original = await (await delivery()).nextBrowserViewerFrame(ticket, undefined, signal);
  await expect(readBrowserFrameBody(original, signal)).rejects.toThrow('metadata');
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(original.locked).toBe(false);
});
it('content-type refusal retains original cancellation until it settles and preserves first error', async () => {
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  onTestFinished(() => release());
  const cancel = vi.fn(() => held);
  const body = new ReadableStream<Uint8Array>({ cancel });
  serve(new Response(body, { headers: { 'Content-Type': 'application/json' } }));
  let terminal = false;
  const result = (await delivery())
    .nextBrowserViewerFrame(ticket, undefined, new AbortController().signal)
    .catch((error: unknown) => error)
    .finally(() => {
      terminal = true;
    });
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  expect(terminal).toBe(false);
  release();
  expect(await result).toMatchObject({
    message: 'Browser viewer response did not contain a binary frame body.',
  });
});
it('abort after headers cancels the original body and retains a falsy original reason', async () => {
  const signal = new AbortController();
  const cancel = vi.fn(async () => {
    throw new Error('later cancellation');
  });
  const body = new ReadableStream<Uint8Array>({ cancel });
  const response = new Response(body, {
    headers: { 'Content-Type': BROWSER_FRAME_CONTENT_TYPE },
  });
  serve(json({}));
  const port = await delivery();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      signal.abort(false);
      return response;
    })
  );
  let caught = false;
  try {
    await port.nextBrowserViewerFrame(ticket, undefined, signal.signal);
  } catch (error) {
    caught = true;
    expect(error).toBe(false);
  }
  expect(caught).toBe(true);
  expect(cancel).toHaveBeenCalledTimes(1);
});
it('keeps actual HTTP auth failure and the shared login-required signal', async () => {
  serve(json({ error: 'Login required', code: 'AUTH_REQUIRED' }, 401));
  await expect(
    (await delivery()).nextBrowserViewerFrame(ticket, undefined, new AbortController().signal)
  ).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
  expect(getAuthRequired()).toBe(true);
});
it('refuses malformed ticket/receipt before any fetch and requires exact disconnect response', async () => {
  const fetch = serve(json({}));
  const port = await delivery();
  fetch.mockClear();
  await expect(
    port.nextBrowserViewerFrame('short', undefined, new AbortController().signal)
  ).rejects.toThrow();
  await expect(
    port.nextBrowserViewerFrame(
      ticket,
      {
        binding,
        viewerId: viewer.viewerId,
        frameId: 'frame_fixture_000000000001',
        sequence: -1,
        stage: 'drawn',
        drawnAt: '2026-10-05T12:00:00.000Z',
      },
      new AbortController().signal
    )
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  const bad = serve(json({ stopped: true }));
  await expect(port.disconnectBrowserViewer(ticket)).rejects.toThrow();
  expect(bad.mock.calls[0]?.[0]).toBe(`${base}/browser/viewers/disconnect`);
  serve(json({}));
  await port.disconnectBrowserViewer(ticket);
});

it('retains a valid late admission cleanup through settlement and preserves falsy abort', async () => {
  const abort = new AbortController();
  let entered!: () => void;
  let finish!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  onTestFinished(() => finish());
  const fetch = vi.fn(async (url: string, _opts?: RequestInit) => {
    if (url.endsWith('/issue')) {
      abort.abort(false);
      return json({ viewer, ticket });
    }
    entered();
    await held;
    throw new Error('later cleanup failure');
  });
  vi.stubGlobal('fetch', fetch);
  let terminal = false;
  const result = createBrowserViewerHttp(base, () => ({ localTicket }))
    .issueBrowserViewer(binding, abort.signal)
    .catch((error: unknown) => error)
    .finally(() => {
      terminal = true;
    });
  await enteredPromise;
  expect(terminal).toBe(false);
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ ticket, localTicket });
  finish();
  expect(await result).toBe(false);
});
it('disconnects a fully valid wrong-binding admission using original issuance context', async () => {
  let current = localTicket;
  const fetch = vi.fn(async (url: string, _opts?: RequestInit) => {
    if (url.endsWith('/issue')) {
      current = 'N'.repeat(43);
      return json({ viewer: { ...viewer, binding: { ...binding, epoch: 1 } }, ticket });
    }
    return json({});
  });
  vi.stubGlobal('fetch', fetch);
  await expect(
    createBrowserViewerHttp(base, () => ({ localTicket: current })).issueBrowserViewer(
      binding,
      new AbortController().signal
    )
  ).rejects.toThrow('requested binding');
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ ticket, localTicket });
});
it('uses original per-ticket local context for next and cleanup after provider changes', async () => {
  let current = localTicket;
  const fetch = serve(
    new Response(new Uint8Array([1]), {
      headers: { 'Content-Type': BROWSER_FRAME_CONTENT_TYPE },
    })
  );
  const port = await delivery(() => ({ localTicket: current }));
  current = 'N'.repeat(43);
  await port.nextBrowserViewerFrame(ticket, undefined, new AbortController().signal);
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ ticket, localTicket });
  const clean = serve(json({}));
  await port.disconnectBrowserViewer(ticket);
  expect(JSON.parse(String(clean.mock.calls[0]?.[1]?.body))).toEqual({ ticket, localTicket });
  await expect(
    port.nextBrowserViewerFrame(ticket, undefined, new AbortController().signal)
  ).rejects.toThrow('not issued');
});

it('bounds issuance custody without evicting originals and frees only settled disconnect', async () => {
  let serial = 0;
  const fetch = vi.fn(async (url: string, _opts?: RequestInit) =>
    url.endsWith('/issue') ? json({ viewer, ticket: String(++serial).padStart(43, 'T') }) : json({})
  );
  vi.stubGlobal('fetch', fetch);
  const port = createBrowserViewerHttp(base);
  const admissions = [];
  for (let i = 0; i < 64; i++)
    admissions.push(await port.issueBrowserViewer(binding, new AbortController().signal));
  await expect(port.issueBrowserViewer(binding, new AbortController().signal)).rejects.toThrow(
    'capacity'
  );
  expect(fetch).toHaveBeenCalledTimes(64);
  await port.disconnectBrowserViewer(admissions[0]!.ticket);
  await port.issueBrowserViewer(binding, new AbortController().signal);
  expect(fetch).toHaveBeenCalledTimes(66);
});
it('does not overwrite or disconnect an original when a response repeats its ticket', async () => {
  const fetch = vi.fn(async (_url: string, _opts?: RequestInit) => json({ viewer, ticket }));
  vi.stubGlobal('fetch', fetch);
  const port = createBrowserViewerHttp(base, () => ({ localTicket }));
  await port.issueBrowserViewer(binding, new AbortController().signal);
  await expect(port.issueBrowserViewer(binding, new AbortController().signal)).rejects.toThrow(
    'reused'
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  const cleanup = serve(json({}));
  await port.disconnectBrowserViewer(ticket);
  expect(JSON.parse(String(cleanup.mock.calls[0]?.[1]?.body))).toEqual({ ticket, localTicket });
});

it('retains the original abort while independently reporting a held late body cancellation failure', async () => {
  let response!: (value: Response) => void, rejectCancel!: (reason: unknown) => void;
  const late = new Promise<Response>((resolve) => {
    response = resolve;
  });
  const cancellation = new Promise<void>((_resolve, reject) => {
    rejectCancel = reject;
  });
  const cancel = vi.fn(() => cancellation),
    observe = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  const originalResponse = new Response(body, {
    headers: { 'Content-Type': BROWSER_FRAME_CONTENT_TYPE },
  });
  const fetch = vi.fn(async (url: string) =>
    url.endsWith('/issue') ? json({ viewer, ticket }) : late
  );
  vi.stubGlobal('fetch', fetch);
  const port = createBrowserViewerHttp(base),
    controller = new AbortController(),
    primary = new Error('original caller lost');
  const originals: { entered?: Promise<ReadableStream<Uint8Array>> } = {};
  onTestFinished(async () => {
    response(originalResponse);
    rejectCancel(undefined);
    if (originals.entered) await originals.entered.catch(() => undefined);
  });
  await port.issueBrowserViewer(binding, controller.signal);
  const entered = (originals.entered = port.nextBrowserViewerFrame(
    ticket,
    undefined,
    controller.signal,
    observe
  ));
  let settled = false;
  const result = entered
    .catch((reason: unknown) => reason)
    .finally(() => {
      settled = true;
    });
  controller.abort(primary);
  response(originalResponse);
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  expect(settled).toBe(false);
  rejectCancel(undefined);
  expect(await result).toBe(primary);
  expect(observe).toHaveBeenCalledExactlyOnceWith(undefined);
});
