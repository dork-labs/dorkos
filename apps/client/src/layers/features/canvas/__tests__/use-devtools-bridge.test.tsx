/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';
import { type RefObject } from 'react';
import type { DevtoolsRecordingPayload } from '@dorkos/shared/transport';
import type { DevtoolsActionResult, DevtoolsIngest } from '@dorkos/shared/schemas';
import { parseCanvasBridgeReport } from '@dorkos/shared/canvas-bridge-wire';
vi.mock('@dorkos/shared/canvas-bridge-wire', async (importOriginal) => {
  const original = await importOriginal<typeof import('@dorkos/shared/canvas-bridge-wire')>();
  return { ...original, parseCanvasBridgeReport: vi.fn(original.parseCanvasBridgeReport) };
});

const ingestDevtoolsCapture = vi.fn(async (_sessionId: string, _batch: DevtoolsIngest) => {});

/**
 * ONE transport object for the life of the suite, deliberately.
 *
 * The real `useTransport` is a context read: it returns the same object across
 * renders, so the bridge's listener effect (using current controller refs)
 * mounts once and its pending flush timer survives every re-render. A mock
 * returning a fresh object per render re-ran that effect on each render, which
 * tore the listener down and cleared the timer with it — so no test could ever
 * observe what happens to a batch that is still coalescing when something
 * changes. The flush-window session bleed lived in that blind spot.
 */
const postDevtoolsAction = vi.fn(async () => {});
const uploadDevtoolsRecording = vi.fn(
  async (_sessionId: string, _upload: DevtoolsRecordingPayload) => {}
);
const transport = {
  ingestDevtoolsCapture,
  postDevtoolsAction,
  uploadDevtoolsRecording,
  clientId: 'web-this-window',
};

/**
 * The CAPTURE relays only — the seat claims filtered out.
 *
 * The bridge posts two different things down one route: console/network
 * captures, and the claim that says which page this window is showing (spec
 * `canvas-agent-seat` §2.2). A claim carries `active` and never carries an
 * entry, so the two are trivially separable — and every assertion in this file
 * is about one or the other, never about the raw call count, which would now
 * mean "captures plus however many times the window claimed".
 */
function relayedBatches(): [string, DevtoolsIngest][] {
  return (ingestDevtoolsCapture as Mock).mock.calls as unknown as [string, DevtoolsIngest][];
}

/** The capture relays only. */
function captureCalls(): [string, DevtoolsIngest][] {
  return relayedBatches().filter(
    ([, batch]) => batch.active === undefined && batch.hostOutcome !== 'host'
  );
}

/** The seat claims only — the mirror image of {@link captureCalls}. */
function claimCalls(): [string, DevtoolsIngest][] {
  return relayedBatches().filter(([, batch]) => batch.active !== undefined);
}

/**
 * The routed app's `?session=`.
 */
let searchSession: string | undefined;

vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useTransport: () => transport,
  useSafeSearch: () => (searchSession === undefined ? {} : { session: searchSession }),
}));

// Controllable stream-manager tap: tests emit session events by invoking the
// registered listeners directly (the real manager gates to the attached session).
const sessionEventListeners = new Set<(sessionId: string, event: unknown) => void>();
vi.mock('@/layers/shared/lib/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/lib/transport')>()),
  streamManager: {
    subscribeSessionEvent: (handler: (sessionId: string, event: unknown) => void) => {
      sessionEventListeners.add(handler);
      return () => sessionEventListeners.delete(handler);
    },
  },
}));

// Rasterizer-source loader stub — also proves lazy-import-only (never called
// until a capture request actually arrives).
const loadRasterizerSource = vi.fn(async () => 'RASTERIZER_SRC');
vi.mock('../lib/load-rasterizer', () => ({
  loadRasterizerSource: () => loadRasterizerSource(),
}));

// The encoder is stubbed because jsdom has no canvas and never decodes an
// image, so the real `drawFrames` cannot run here at all. What these tests are
// about is the ROUTING — which frames reach the buffer, which never reach the
// server, and what is uploaded — and the encoder itself is proved against its
// own output in `lib/__tests__/encode-recording.test.ts`.
type EncodeOutcome = { ok: true; bytes: Uint8Array } | { ok: false; error: string };
const OK_GIF: EncodeOutcome = { ok: true, bytes: new Uint8Array([0x47, 0x49, 0x46]) };
const drawFrames = vi.fn(async (dataUrls: readonly string[], _longEdgePx: number) =>
  dataUrls.map(() => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }))
);
/**
 * What the next `encodeGif` calls answer, in order.
 *
 * A QUEUE rather than one value, because the retry at half the long edge (spec
 * §3.3) is a second call whose answer has to differ from the first's — a single
 * value cannot tell "it fitted on the retry" from "it never fitted".
 */
let encodeResults: EncodeOutcome[] = [OK_GIF];
const encodeGif = vi.fn(async () => encodeResults.shift() ?? OK_GIF);
vi.mock('../lib/encode-recording', () => ({
  drawFrames: (dataUrls: readonly string[], longEdgePx: number) => drawFrames(dataUrls, longEdgePx),
  encodeGif: () => encodeGif(),
  halveFrames: (...args: unknown[]) => halveFrames(...args),
}));

const halveFrames = vi.fn();
import { useAppStore } from '@/layers/shared/model';
import { useDevtoolsBridge } from '../model/use-devtools-bridge';

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let iframe: HTMLIFrameElement;
let foreignFrame: HTMLIFrameElement;
const entry = { level: 'error', text: 'boom', timestamp: 1 };
const defaults = {
  documentId: 'doc',
  logicalUrl: 'preview.html',
  reloadNonce: 0,
  previewOrigin: null,
  bridgeEligibility: 'served-document' as const,
  resolvedSource: '/signed/preview',
};
function generation(): string {
  return vi
    .mocked(iframe.contentWindow!.postMessage)
    .mock.calls.filter(([m]) => m.__dorkosDevtools === 'init')
    .at(-1)![0].bridgeGeneration;
}
function raw(data: unknown, source: Window | null = iframe.contentWindow, origin = 'null'): void {
  act(() => window.dispatchEvent(new MessageEvent('message', { data, source, origin })));
}
function report(data: object, gen = generation(), origin = 'null'): void {
  raw({ bridgeGeneration: gen, ...data }, iframe.contentWindow, origin);
}
function ready(origin = 'null'): void {
  report({ __dorkosDevtools: 'ready', pageInstanceId: 'page' }, generation(), origin);
}
function emit(event: object): void {
  act(() => {
    for (const listener of sessionEventListeners) listener('session-1', event);
  });
}
function request(requestId: string, extra: object = {}): void {
  emit({
    type: 'devtools_capture_request',
    requestId,
    targetClientId: transport.clientId,
    documentId: 'doc',
    bridgeGeneration: generation(),
    ...extra,
  });
}
function mount(overrides: Partial<Parameters<typeof useDevtoolsBridge>[0]> = {}, handshake = true) {
  const ref = { current: iframe } as RefObject<HTMLIFrameElement | null>;
  const hook = renderHook((p) => useDevtoolsBridge({ ...defaults, iframeRef: ref, ...p }), {
    initialProps: overrides,
  });
  act(() => hook.result.current.noteFrameLoaded());
  if (handshake) ready(overrides.previewOrigin ?? 'null');
  return { ...hook, ref };
}
function capture(requestId: string, data: object = {}, gen = generation()): void {
  report({ __dorkosDevtools: 'capture-result', requestId, dataUrl: PNG, ...data }, gen);
}
async function settle(): Promise<void> {
  await act(() => vi.advanceTimersByTimeAsync(0));
}
function frameRequest(): string {
  return vi
    .mocked(iframe.contentWindow!.postMessage)
    .mock.calls.filter(([m]) => m.__dorkosDevtools === 'capture-request')
    .at(-1)![0].requestId;
}
function record(action: 'start' | 'stop', requestId: string, recordingId = 'film'): void {
  emit({
    type: 'devtools_recording_request',
    action,
    ...(action === 'start' ? { reservationTimeoutMs: 8_000 } : {}),
    requestId,
    recordingId,
    targetClientId: transport.clientId,
    documentId: 'doc',
    bridgeGeneration: generation(),
    bounds: { longEdgePx: 800, frameMs: 500, maxBytes: 8388608 },
  });
  if (action === 'start')
    emit({
      type: 'devtools_recording_request',
      action: 'confirm-start',
      requestId,
      recordingId,
      targetClientId: transport.clientId,
      documentId: 'doc',
      bridgeGeneration: generation(),
    });
}
beforeEach(() => {
  vi.useFakeTimers();
  searchSession = 'session-1';
  useAppStore.getState().setSessionId(null);
  ingestDevtoolsCapture.mockReset();
  ingestDevtoolsCapture.mockResolvedValue(undefined);
  postDevtoolsAction.mockClear();
  uploadDevtoolsRecording.mockReset();
  uploadDevtoolsRecording.mockResolvedValue(undefined);
  loadRasterizerSource.mockReset();
  loadRasterizerSource.mockResolvedValue('RASTERIZER_SRC');
  drawFrames.mockClear();
  encodeGif.mockClear();
  halveFrames.mockClear();
  encodeResults = [OK_GIF];
  sessionEventListeners.clear();
  iframe = document.createElement('iframe');
  foreignFrame = document.createElement('iframe');
  document.body.append(iframe, foreignFrame);
  vi.spyOn(iframe.contentWindow!, 'postMessage');
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

it('drops an unsolicited current-frame screenshot before Transport', async () => {
  mount();
  capture('unknown');
  expect(captureCalls()).toHaveLength(0);
  request('known');
  await settle();
  capture('known');
  expect(captureCalls()).toHaveLength(1);
  expect(captureCalls()[0][1].screenshot?.requestId).toBe('known');
});
it('rejects missing generation and never downgrades on a legacy hello', async () => {
  mount();
  request('known');
  await settle();
  raw({ __dorkosDevtools: 'capture-result', requestId: 'known', dataUrl: PNG });
  raw({ __dorkosDevtools: 'hello' });
  expect(captureCalls()).toHaveLength(0);
  capture('known');
  expect(captureCalls()).toHaveLength(1);
});
it('rejects a wrong-generation response to a known pending request without consuming it', async () => {
  mount();
  request('known');
  await settle();
  capture('known', {}, `${generation()}-other`);
  expect(captureCalls()).toHaveLength(0);
  capture('known');
  expect(captureCalls()).toHaveLength(1);
  expect(captureCalls()[0][1].screenshot?.requestId).toBe('known');
});
it('rejects an outcome-less known capture without consuming its pending request', async () => {
  mount();
  request('known');
  await settle();
  report({ __dorkosDevtools: 'capture-result', requestId: 'known' });
  expect(captureCalls()).toHaveLength(0);
  capture('known');
  expect(captureCalls()).toHaveLength(1);
  capture('known');
  expect(captureCalls()).toHaveLength(1);
});
it('requires ready and hello cannot create a new generation or instrumented claim', async () => {
  mount({}, false);
  const gen = generation();
  report({ __dorkosDevtools: 'batch', seq: 1, console: [entry], network: [] });
  raw({ __dorkosDevtools: 'hello', bridgeVersion: 2, pageInstanceId: 'page' });
  expect(generation()).toBe(gen);
  await settle();
  expect(claimCalls().every(([, b]) => !b.instrumented)).toBe(true);
  ready();
  request('known');
  await settle();
  capture('known');
  expect(captureCalls()).toHaveLength(1);
});
it('denies opaque external frames even when their origin is null', () => {
  mount({ bridgeEligibility: null, resolvedSource: 'https://external.example' }, false);
  raw({ __dorkosDevtools: 'hello', bridgeVersion: 2, pageInstanceId: 'p' });
  expect(iframe.contentWindow!.postMessage).not.toHaveBeenCalled();
  expect(relayedBatches()).toHaveLength(0);
});
it('requires exact preview origin and exact source, including nested opaque frames', async () => {
  mount({ bridgeEligibility: 'preview-listener', previewOrigin: 'http://preview.local:4444' });
  request('known');
  await settle();
  const data = {
    __dorkosDevtools: 'capture-result',
    bridgeGeneration: generation(),
    requestId: 'known',
    dataUrl: PNG,
  };
  raw(data, foreignFrame.contentWindow, 'http://preview.local:4444');
  raw(data);
  raw(data, iframe.contentWindow, 'http://preview.local:4445');
  expect(captureCalls()).toHaveLength(0);
  raw(data, iframe.contentWindow, 'http://preview.local:4444');
  expect(captureCalls()).toHaveLength(1);
});
it.each(['documentId', 'logicalUrl', 'resolvedSource', 'reloadNonce'] as const)(
  'retires requests and queued batches on %s replacement',
  async (key) => {
    const hook = mount();
    request('known');
    await settle();
    const old = generation();
    report({ __dorkosDevtools: 'batch', seq: 1, console: [entry], network: [] });
    hook.rerender({ [key]: key === 'reloadNonce' ? 1 : 'replacement' });
    act(() => hook.result.current.noteFrameLoaded());
    expect(generation()).not.toBe(old);
    capture('known', {}, old);
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(captureCalls()).toHaveLength(0);
  }
);
it('retires on actual frame load and ignores repeated ready from the previous page', async () => {
  const hook = mount();
  const old = generation();
  request('known');
  await settle();
  act(() => hook.result.current.noteFrameLoaded());
  expect(generation()).not.toBe(old);
  report({ __dorkosDevtools: 'ready', pageInstanceId: 'p' }, old);
  capture('known', {}, old);
  expect(captureCalls()).toHaveLength(0);
});
it('retires on session attachment, including a preview that loaded before any conversation', async () => {
  searchSession = undefined;
  const hook = mount();
  const old = generation();
  report({ __dorkosDevtools: 'resource-error' });
  await act(() => vi.advanceTimersByTimeAsync(20));
  expect(hook.result.current.resourceErrorCount).toBe(1);
  expect(relayedBatches()).toHaveLength(0);
  searchSession = 'session-1';
  hook.rerender({});
  expect(hook.result.current.resourceErrorCount).toBe(0);
  expect(generation()).not.toBe(old);
  report({ __dorkosDevtools: 'batch', seq: 1, console: [entry], network: [] }, old);
  ready();
  request('new');
  await settle();
  capture('new');
  expect(captureCalls()[0][0]).toBe('session-1');
});
it('does not forward a lazy import into a replacement generation', async () => {
  let resolve!: (value: string) => void;
  loadRasterizerSource.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      })
  );
  const hook = mount();
  request('old');
  hook.rerender({ reloadNonce: 1 });
  act(() => hook.result.current.noteFrameLoaded());
  ready();
  resolve('LATE');
  await settle();
  expect(
    vi.mocked(iframe.contentWindow!.postMessage).mock.calls.some(([m]) => m.requestId === 'old')
  ).toBe(false);
  request('new');
  await settle();
  capture('new');
  expect(captureCalls()).toHaveLength(1);
});
it('admits at most 64 requests and expires them before accepting a later reply', async () => {
  mount();
  for (let i = 0; i < 65; i++) request(`r${i}`);
  await settle();
  const calls = vi
    .mocked(iframe.contentWindow!.postMessage)
    .mock.calls.filter(([m]) => m.__dorkosDevtools === 'capture-request');
  expect(calls).toHaveLength(64);
  await act(() => vi.advanceTimersByTimeAsync(8000));
  capture('r0');
  expect(captureCalls()).toHaveLength(0);
  request('fresh');
  await settle();
  capture('fresh');
  expect(captureCalls()).toHaveLength(1);
});
it('consumes only the first valid response and does not consume malformed or wrong-kind responses', async () => {
  mount();
  request('known');
  await settle();
  report({ __dorkosDevtools: 'act-result', requestId: 'known', ok: true });
  capture('known', { dataUrl: 'not-a-png' });
  expect(captureCalls()).toHaveLength(0);
  capture('known');
  capture('known');
  expect(captureCalls()).toHaveLength(1);
  expect(postDevtoolsAction).not.toHaveBeenCalled();
});
it('pins metadata on an accepted result before a canonical session switch', async () => {
  const hook = mount();
  request('known');
  await settle();
  capture('known');
  const accepted = captureCalls()[0];
  searchSession = 'canonical';
  hook.rerender({});
  await settle();
  expect(accepted[0]).toBe('session-1');
  expect(accepted[1]).toMatchObject({ documentId: 'doc', logicalUrl: 'preview.html' });
  capture('known', {}, accepted[1].bridgeGeneration);
  expect(captureCalls()).toHaveLength(1);
});
it('rate bounds batches, preserves monotonic seq and reports observable loss', async () => {
  mount();
  report({ __dorkosDevtools: 'batch', seq: 1, console: [entry], network: [] });
  report({
    __dorkosDevtools: 'batch',
    seq: 2,
    console: [{ ...entry, text: 'dropped' }],
    network: [],
  });
  report({
    __dorkosDevtools: 'batch',
    seq: 1,
    console: [{ ...entry, text: 'duplicate' }],
    network: [],
  });
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(captureCalls()[0][1]).toMatchObject({ seq: 1, dropped: true, console: [entry] });
});
it('never throws on raw BigInt/cycle reports and keeps the next valid report usable', async () => {
  mount();
  const cycle: unknown[] = [];
  cycle.push(cycle);
  for (const args of [[1n], cycle])
    report({ __dorkosDevtools: 'batch', seq: 1, console: [{ ...entry, args }], network: [] });
  await act(() => vi.advanceTimersByTimeAsync(300));
  report({ __dorkosDevtools: 'batch', seq: 1, console: [entry], network: [] });
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(captureCalls()[0][1].console).toEqual([entry]);
});
it('coalesces resource renders to one RAF and caps the reported counter', async () => {
  const hook = mount();
  for (let i = 0; i < 10001; i++) report({ __dorkosDevtools: 'resource-error' });
  expect(hook.result.current.resourceErrorCount).toBe(0);
  await act(() => vi.advanceTimersByTimeAsync(20));
  expect(hook.result.current.resourceErrorCount).toBe(10000);
  act(() => hook.result.current.noteFrameLoaded());
  expect(hook.result.current.resourceErrorCount).toBe(0);
});
it('keeps seat heartbeats nonactivating, and explicit person navigation activates it', async () => {
  const hook = mount();
  await settle();
  await act(() => vi.advanceTimersByTimeAsync(15000));
  expect(claimCalls().at(-1)![1].activation).toBe(false);
  act(() => hook.result.current.notePersonNavigated());
  await settle();
  expect(claimCalls().at(-1)![1].activation).toBe(true);
  hook.unmount();
  await settle();
  expect(claimCalls().at(-1)![1].active).toBe(false);
});
it('forwards action only to the addressed generation and relays a page failure as data', async () => {
  mount();
  const command = { action: 'click', target: { text: 'Pay' } };
  emit({
    type: 'devtools_action_request',
    requestId: 'wrong',
    targetClientId: 'other',
    documentId: 'doc',
    bridgeGeneration: generation(),
    command,
  });
  report({ __dorkosDevtools: 'act-result', requestId: 'wrong', ok: false, error: 'page says no' });
  expect(postDevtoolsAction).not.toHaveBeenCalled();
  emit({
    type: 'devtools_action_request',
    requestId: 'known',
    targetClientId: transport.clientId,
    documentId: 'doc',
    bridgeGeneration: generation(),
    command,
  });
  report({
    __dorkosDevtools: 'act-result',
    requestId: 'known',
    ok: false,
    error: 'page says no',
    evidence: { source: 'host', verified: true },
  });
  expect(postDevtoolsAction).toHaveBeenCalledWith(
    'session-1',
    expect.objectContaining({ requestId: 'known', ok: false, error: 'page says no' })
  );
  expect(
    (postDevtoolsAction.mock.calls as unknown as [string, unknown][])[0][1]
  ).not.toHaveProperty('evidence');
});
it('keeps recording frames local and uploads only on stop', async () => {
  mount();
  record('start', 'start');
  await settle();
  capture(frameRequest());
  await settle();
  expect(captureCalls()).toHaveLength(0);
  expect(uploadDevtoolsRecording).not.toHaveBeenCalled();
  record('stop', 'stop');
  await settle();
  capture(frameRequest());
  await settle();
  expect(uploadDevtoolsRecording).toHaveBeenCalledWith(
    'session-1',
    expect.objectContaining({
      requestId: 'stop',
      documentId: 'doc',
      bridgeGeneration: generation(),
      frames: 2,
    }),
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  );
});
it('retries from normalized pixels without a second decode after compressed inputs are released', async () => {
  encodeResults = [{ ok: false, error: 'too large' }, OK_GIF];
  mount();
  record('start', 'start');
  await settle();
  capture(frameRequest());
  await settle();
  record('stop', 'stop');
  await settle();
  capture(frameRequest());
  await settle();
  expect(drawFrames).toHaveBeenCalledTimes(1);
  expect(halveFrames).toHaveBeenCalledTimes(1);
  expect(encodeGif).toHaveBeenCalledTimes(2);
});
it('retains a finishing job across generations and cancels after deferred drawing before encode/upload', async () => {
  let release!: (
    frames: { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number }[]
  ) => void;
  drawFrames.mockImplementationOnce(
    () =>
      new Promise((r) => {
        release = r;
      })
  );
  const hook = mount();
  record('start', 'start');
  await settle();
  capture(frameRequest());
  await settle();
  record('stop', 'stop');
  await settle();
  capture(frameRequest());
  await settle();
  hook.rerender({ reloadNonce: 1 });
  act(() => hook.result.current.noteFrameLoaded());
  ready();
  const calls = vi.mocked(iframe.contentWindow!.postMessage).mock.calls.length;
  record('start', 'second', 'second-film');
  await settle();
  expect(vi.mocked(iframe.contentWindow!.postMessage).mock.calls.length).toBe(calls);
  const pixels = [{ data: new Uint8ClampedArray(4), width: 1, height: 1 }];
  release(pixels);
  await settle();
  expect(pixels).toHaveLength(0);
  expect(encodeGif).not.toHaveBeenCalled();
  expect(uploadDevtoolsRecording).not.toHaveBeenCalled();
  record('start', 'third', 'third-film');
  await settle();
  expect(vi.mocked(iframe.contentWindow!.postMessage).mock.calls.length).toBeGreaterThan(calls);
});
it('keeps canonical rekey and ready upgrades from reactivating a background seat', async () => {
  useAppStore.setState({ openDocuments: [{ id: 'doc', openedHere: true }] as never });
  const hook = mount();
  await settle();
  expect(
    claimCalls()
      .filter(([, c]) => c.instrumented)
      .at(-1)![1].activation
  ).toBe(false);
  searchSession = 'canonical';
  hook.rerender({});
  ready();
  await settle();
  expect(
    claimCalls()
      .filter(([sid, c]) => sid === 'canonical' && c.active)
      .every(([, c]) => c.activation === false)
  ).toBe(true);
});
it('retains the finishing slot until a cancelled encoder await unwinds, then releases every normalized frame', async () => {
  let release!: (result: EncodeOutcome) => void;
  encodeGif.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const hook = mount();
  record('start', 'start');
  await settle();
  capture(frameRequest());
  await settle();
  record('stop', 'stop');
  await settle();
  capture(frameRequest());
  await settle();
  hook.rerender({ reloadNonce: 1 });
  act(() => hook.result.current.noteFrameLoaded());
  ready();
  record('start', 'second', 'second-film');
  await settle();
  expect(drawFrames).toHaveBeenCalledTimes(1);
  release(OK_GIF);
  await settle();
  expect(uploadDevtoolsRecording).not.toHaveBeenCalled();
  record('start', 'third', 'third-film');
  await settle();
  capture(frameRequest());
  await settle();
  record('stop', 'third-stop', 'third-film');
  await settle();
  capture(frameRequest());
  await settle();
  expect(uploadDevtoolsRecording).toHaveBeenCalledTimes(1);
});
it('reports a host-only stop failure for a recording the current frame does not hold', async () => {
  mount();
  record('stop', 'stop', 'missing');
  await settle();
  expect(uploadDevtoolsRecording).toHaveBeenCalledWith(
    'session-1',
    expect.objectContaining({
      requestId: 'stop',
      error: expect.stringContaining('stopped recording'),
      bridgeGeneration: generation(),
      documentId: 'doc',
    })
  );
});

it('preserves person address submission while frame resolution has no eligible lifetime', async () => {
  const hook = mount({ bridgeEligibility: null, resolvedSource: null }, false);
  act(() => hook.result.current.notePersonNavigated());
  hook.rerender({ ...defaults });
  act(() => hook.result.current.noteFrameLoaded());
  await settle();
  expect(claimCalls().some(([, claim]) => claim.active === true && claim.activation === true)).toBe(
    true
  );
  ready();
  await settle();
  expect(claimCalls().at(-1)![1].activation).toBe(false);
});

it('keeps pagehide release ordered behind a deferred claim and restores through pageshow', async () => {
  let release!: () => void;
  ingestDevtoolsCapture.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );
  const hook = mount();
  await settle();
  act(() => window.dispatchEvent(new Event('pagehide')));
  await settle();
  expect(claimCalls()).toHaveLength(1);
  release();
  await settle();
  expect(claimCalls().at(-1)![1].active).toBe(false);
  act(() => window.dispatchEvent(new Event('pageshow')));
  await settle();
  expect(claimCalls().at(-1)![1]).toMatchObject({
    active: true,
    activation: true,
    instrumented: false,
  });
  act(() => hook.result.current.noteFrameLoaded());
  ready();
  await settle();
  expect(claimCalls().at(-1)![1]).toMatchObject({
    active: true,
    activation: false,
    instrumented: true,
  });
});
it('forwards a known capture after rasterizer loading fails and relays its page error immediately', async () => {
  loadRasterizerSource.mockRejectedValueOnce(new Error('chunk unavailable'));
  mount();
  request('capture-error');
  await settle();
  expect(frameRequest()).toBe('capture-error');
  report({
    __dorkosDevtools: 'capture-result',
    requestId: 'capture-error',
    error: 'page rasterizer failed',
  });
  expect(captureCalls().at(-1)![1].screenshot).toEqual({
    requestId: 'capture-error',
    error: 'page rasterizer failed',
  });
  expect(captureCalls().at(-1)![1].hostOutcome).toBe('page-reported');
});
it('caps retained recording frames and only claims captures requested by the host', async () => {
  mount();
  record('start', 'start');
  await settle();
  capture(frameRequest());
  await settle();
  for (let i = 0; i < 65; i++) {
    emit({
      type: 'devtools_action_request',
      requestId: `action-${i}`,
      targetClientId: transport.clientId,
      documentId: 'doc',
      bridgeGeneration: generation(),
      command: { action: 'read_page', maxChars: 4000 },
      capture: true,
    });
    await settle();
    report({ __dorkosDevtools: 'act-result', requestId: `action-${i}`, ok: true, dataUrl: PNG });
  }
  expect(
    (postDevtoolsAction.mock.calls as unknown as [string, { captured?: boolean }][]).filter(
      ([, r]) => r.captured
    )
  ).toHaveLength(60);
  emit({
    type: 'devtools_action_request',
    requestId: 'not-requested',
    targetClientId: transport.clientId,
    documentId: 'doc',
    bridgeGeneration: generation(),
    command: { action: 'read_page', maxChars: 4000 },
  });
  report({
    __dorkosDevtools: 'act-result',
    requestId: 'not-requested',
    ok: true,
    dataUrl: PNG,
    captured: true,
  });
  expect(
    (postDevtoolsAction.mock.calls.at(-1) as unknown as [string, { captured?: boolean }])[1]
      .captured
  ).toBeUndefined();
  record('stop', 'stop');
  await settle();
  capture(frameRequest());
  await settle();
  expect(uploadDevtoolsRecording).toHaveBeenCalledWith(
    'session-1',
    expect.objectContaining({ frames: 62 }),
    expect.anything()
  );
});
it('reports an encoder refusal after one normalized-pixel retry and releases the job for a new recording', async () => {
  encodeResults = [
    { ok: false, error: 'too large' },
    { ok: false, error: 'still too large' },
  ];
  mount();
  record('start', 'start');
  await settle();
  capture(frameRequest());
  await settle();
  record('stop', 'stop');
  await settle();
  capture(frameRequest());
  await settle();
  expect(uploadDevtoolsRecording).toHaveBeenCalledWith(
    'session-1',
    expect.objectContaining({ requestId: 'stop', hostOutcome: 'host', error: 'still too large' }),
    expect.anything()
  );
  expect(encodeGif).toHaveBeenCalledTimes(2);
  const before = vi.mocked(iframe.contentWindow!.postMessage).mock.calls.length;
  record('start', 'new', 'new-film');
  await settle();
  expect(vi.mocked(iframe.contentWindow!.postMessage).mock.calls.length).toBeGreaterThan(before);
});

it('resets buffered attribution at real page boundaries but preserves canonical-session rekey data', async () => {
  const hook = mount();
  await settle();
  expect(claimCalls().some(([, claim]) => claim.reset)).toBe(true);
  ingestDevtoolsCapture.mockClear();
  searchSession = 'canonical';
  hook.rerender({});
  await settle();
  expect(claimCalls().every(([, claim]) => !claim.reset)).toBe(true);
  ingestDevtoolsCapture.mockClear();
  hook.rerender({ logicalUrl: 'next-page' });
  await settle();
  expect(
    claimCalls()
      .filter(([, claim]) => claim.active)
      .at(-1)![1]
  ).toMatchObject({ reset: true, logicalUrl: 'next-page', instrumented: false });
  ingestDevtoolsCapture.mockClear();
  act(() => hook.result.current.noteFrameLoaded());
  await settle();
  expect(
    claimCalls()
      .filter(([, claim]) => claim.active)
      .at(-1)![1].reset
  ).toBe(true);
});

it('rate-admits batch processing before deep parsing while capture responses and later telemetry remain usable', async () => {
  mount();
  request('known');
  await settle();
  vi.mocked(parseCanvasBridgeReport).mockClear();
  report({ __dorkosDevtools: 'batch', seq: 1, console: [entry], network: [] });
  for (let seq = 2; seq <= 100; seq++)
    report({ __dorkosDevtools: 'batch', seq, console: [{ ...entry, args: [1n] }], network: [] });
  report(
    { __dorkosDevtools: 'batch', seq: 200, console: [entry], network: [] },
    'wrong-generation'
  );
  expect(parseCanvasBridgeReport).toHaveBeenCalledTimes(1);
  capture('known');
  expect(parseCanvasBridgeReport).toHaveBeenCalledTimes(2);
  expect(captureCalls()).toHaveLength(1);
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(captureCalls().find(([, batch]) => batch.console.length)![1].dropped).toBe(true);
  report({
    __dorkosDevtools: 'batch',
    seq: 2,
    console: [{ ...entry, text: 'later' }],
    network: [],
  });
  expect(parseCanvasBridgeReport).toHaveBeenCalledTimes(3);
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(captureCalls().at(-1)![1].console[0].text).toBe('later');
});

it('bounds queue work and UTF-8 bytes while discarding older network before newer console evidence', async () => {
  mount();
  const stringify = vi.spyOn(JSON, 'stringify');
  const console = Array.from({ length: 60 }, (_, i) => ({
    level: 'log',
    text: `${i}:` + '😀'.repeat(5000),
    timestamp: 100 + i,
  }));
  const network = [
    { method: 'GET', url: 'x'.repeat(2048), status: 200, ok: true, durationMs: 1, timestamp: 1 },
  ];
  report({ __dorkosDevtools: 'batch', seq: 1, console, network });
  const fullBatchWalks = stringify.mock.calls.filter(
    ([value]) =>
      typeof value === 'object' &&
      value !== null &&
      'console' in value &&
      Array.isArray(value.console) &&
      value.console.length > 1
  ).length;
  expect(fullBatchWalks).toBeLessThanOrEqual(1);
  await act(() => vi.advanceTimersByTimeAsync(300));
  const sent = captureCalls()[0][1];
  expect(sent.network).toHaveLength(0);
  expect(sent.console.length).toBeGreaterThan(0);
  expect(sent.console.length).toBeLessThan(60);
  expect(sent.console.at(-1)!.text.startsWith('59:')).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(sent)).length).toBeLessThanOrEqual(1048576);
  expect(sent.dropped).toBe(true);
  stringify.mockRestore();
});

it('page-reported navigation retires a visible resource lifetime without minting from its rerender or focus', async () => {
  const hook = mount();
  report({ __dorkosDevtools: 'resource-error' });
  await act(() => vi.advanceTimersByTimeAsync(20));
  expect(hook.result.current.resourceErrorCount).toBe(1);
  const old = generation();
  const initCount = () =>
    vi
      .mocked(iframe.contentWindow!.postMessage)
      .mock.calls.filter(([m]) => m.__dorkosDevtools === 'init').length;
  const before = initCount();
  ingestDevtoolsCapture.mockClear();
  report({ __dorkosDevtools: 'navigated' });
  hook.rerender({});
  act(() => window.dispatchEvent(new Event('focus')));
  act(() => window.dispatchEvent(new Event('pageshow')));
  await settle();
  expect(hook.result.current.resourceErrorCount).toBe(0);
  expect(initCount()).toBe(before);
  expect(claimCalls().filter(([, claim]) => claim.active)).toHaveLength(0);
  act(() => hook.result.current.noteFrameLoaded());
  ready();
  await settle();
  expect(generation()).not.toBe(old);
  expect(claimCalls().at(-1)![1]).toMatchObject({ active: true, instrumented: true });
});

it('does not reactivate on visibility loss and reactivates only when the current tab becomes visible', async () => {
  mount();
  await settle();
  ingestDevtoolsCapture.mockClear();
  const visibility = vi.spyOn(document, 'visibilityState', 'get');
  try {
    visibility.mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await settle();
    expect(claimCalls()).toHaveLength(0);
    visibility.mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await settle();
    expect(claimCalls()).toHaveLength(1);
    expect(claimCalls()[0][1]).toMatchObject({ active: true, activation: true });
  } finally {
    visibility.mockRestore();
  }
});

describe('complete host request bindings', () => {
  for (const type of [
    'devtools_capture_request',
    'devtools_action_request',
    'devtools_recording_request',
  ]) {
    it.each(['targetClientId', 'documentId', 'bridgeGeneration'])(
      'rejects ' + type + ' without %s and still admits a fully bound request',
      async (field) => {
        mount();
        const event: Record<string, unknown> = {
          type,
          requestId: 'bound',
          targetClientId: transport.clientId,
          documentId: 'doc',
          bridgeGeneration: generation(),
          ...(type === 'devtools_action_request'
            ? { command: { action: 'read_page', maxChars: 4000 } }
            : {}),
          ...(type === 'devtools_recording_request'
            ? {
                action: 'start',
                reservationTimeoutMs: 8_000,
                recordingId: 'film',
                bounds: { longEdgePx: 800, frameMs: 500, maxBytes: 8388608 },
              }
            : {}),
        };
        const incomplete = { ...event };
        delete incomplete[field];
        emit(incomplete);
        await settle();
        const forwarded = () =>
          vi
            .mocked(iframe.contentWindow!.postMessage)
            .mock.calls.filter(([message]) =>
              ['capture-request', 'act-request'].includes(message.__dorkosDevtools)
            );
        expect(forwarded()).toHaveLength(0);
        emit(event);
        if (type === 'devtools_recording_request') emit({ ...event, action: 'confirm-start' });
        await settle();
        expect(forwarded()).toHaveLength(1);
      }
    );
  }
});
it.each(['capture', 'action'])(
  'refuses a new %s immediately at the pending cap without cancelling an existing request',
  async (kind) => {
    mount();
    const send = (id: string) => {
      if (kind === 'capture') request(id);
      else
        emit({
          type: 'devtools_action_request',
          requestId: id,
          targetClientId: transport.clientId,
          documentId: 'doc',
          bridgeGeneration: generation(),
          command: { action: 'read_page', maxChars: 4000 },
        });
    };
    for (let i = 0; i < 65; i++) send('overflow-' + i);
    await settle();
    const forwarded = () =>
      vi
        .mocked(iframe.contentWindow!.postMessage)
        .mock.calls.filter(([message]) =>
          ['capture-request', 'act-request'].includes(message.__dorkosDevtools)
        );
    expect(forwarded()).toHaveLength(64);
    const failures = () =>
      kind === 'capture'
        ? relayedBatches().filter(([, body]) => body.hostOutcome === 'host')
        : (postDevtoolsAction.mock.calls as unknown as [string, DevtoolsActionResult][]).filter(
            ([, body]) => body.hostOutcome === 'host'
          );
    expect(failures()).toHaveLength(1);
    expect(failures()[0][1]).toMatchObject({
      documentId: 'doc',
      bridgeGeneration: generation(),
      hostOutcome: 'host',
    });
    send('overflow-0');
    await settle();
    expect(failures()).toHaveLength(1);
    expect(forwarded()).toHaveLength(64);
    if (kind === 'capture') capture('overflow-0');
    else report({ __dorkosDevtools: 'act-result', requestId: 'overflow-0', ok: true });
    send('after-release');
    await settle();
    expect(forwarded()).toHaveLength(65);
  }
);

function recordingAdmissionReplies() {
  return ingestDevtoolsCapture.mock.calls
    .filter(([, batch]) => batch.recordingStart)
    .map(([, batch]) => batch.recordingStart!);
}
function startAdmission(requestId = 'start', recordingId = 'film', extra: object = {}) {
  emit({
    type: 'devtools_recording_request',
    action: 'start',
    requestId,
    recordingId,
    targetClientId: transport.clientId,
    documentId: 'doc',
    bridgeGeneration: generation(),
    reservationTimeoutMs: 8000,
    ...extra,
  });
}
function admissionControl(
  action: 'confirm-start' | 'cancel-start',
  requestId = 'start',
  recordingId = 'film'
) {
  emit({
    type: 'devtools_recording_request',
    action,
    requestId,
    recordingId,
    targetClientId: transport.clientId,
    documentId: 'doc',
    bridgeGeneration: generation(),
  });
}
function admissionFrames() {
  return vi
    .mocked(iframe.contentWindow!.postMessage)
    .mock.calls.filter(([message]) => message.__dorkosDevtools === 'capture-request');
}
it('reserves without capture and acknowledges actual activation only after exact confirmation', async () => {
  mount();
  startAdmission();
  expect(admissionFrames()).toHaveLength(0);
  expect(recordingAdmissionReplies().at(-1)).toMatchObject({ phase: 'reserved', ok: true });
  admissionControl('confirm-start', 'wrong-request');
  expect(admissionFrames()).toHaveLength(0);
  admissionControl('confirm-start');
  await settle();
  expect(admissionFrames()).toHaveLength(1);
  expect(recordingAdmissionReplies().at(-1)).toMatchObject({ phase: 'started', ok: true });
  admissionControl('confirm-start');
  await settle();
  expect(admissionFrames()).toHaveLength(1);
});
it('expires a relative reservation and cannot revive it with a late confirmation', async () => {
  mount();
  startAdmission();
  await act(() => vi.advanceTimersByTimeAsync(8001));
  admissionControl('confirm-start');
  await settle();
  expect(admissionFrames()).toHaveLength(0);
  startAdmission('later', 'later-film');
  admissionControl('confirm-start', 'later', 'later-film');
  await settle();
  expect(admissionFrames()).toHaveLength(1);
});
it('refuses elapsed confirmation even before its reservation timer dispatches and permits a later start', async () => {
  let monotonicNow = 100;
  const monotonicClock = vi.spyOn(performance, 'now').mockImplementation(() => monotonicNow);
  try {
    mount();
    startAdmission();
    const undispatchedTimers = vi.getTimerCount();
    monotonicNow += 8000;
    expect(vi.getTimerCount()).toBe(undispatchedTimers);
    admissionControl('confirm-start');
    await settle();
    expect(admissionFrames()).toHaveLength(0);
    expect(recordingAdmissionReplies().at(-1)).toMatchObject({ phase: 'started', ok: false });
    startAdmission('later', 'later-film');
    admissionControl('confirm-start', 'later', 'later-film');
    await settle();
    expect(admissionFrames()).toHaveLength(1);
    expect(recordingAdmissionReplies().at(-1)).toMatchObject({
      requestId: 'later',
      phase: 'started',
      ok: true,
    });
  } finally {
    monotonicClock.mockRestore();
  }
});
it('acknowledges an active duplicate confirmation beyond its old reservation deadline', async () => {
  let monotonicNow = 100;
  const monotonicClock = vi.spyOn(performance, 'now').mockImplementation(() => monotonicNow);
  try {
    mount();
    startAdmission();
    admissionControl('confirm-start');
    await settle();
    expect(admissionFrames()).toHaveLength(1);
    monotonicNow += 8001;
    admissionControl('confirm-start');
    await settle();
    expect(admissionFrames()).toHaveLength(1);
    expect(recordingAdmissionReplies().at(-1)).toMatchObject({ phase: 'started', ok: true });
  } finally {
    monotonicClock.mockRestore();
  }
});
it('refuses a current bound START without a relative timeout', async () => {
  mount();
  startAdmission('invalid', 'invalid-film', { reservationTimeoutMs: undefined });
  expect(recordingAdmissionReplies().at(-1)).toMatchObject({ phase: 'reserved', ok: false });
  expect(admissionFrames()).toHaveLength(0);
  startAdmission();
  admissionControl('confirm-start');
  await settle();
  expect(admissionFrames()).toHaveLength(1);
});
it('a late or wrong-ID cancel cannot dispose a newer active recording', async () => {
  mount();
  startAdmission();
  admissionControl('confirm-start');
  await settle();
  admissionControl('cancel-start', 'start', 'different-film');
  const before = recordingAdmissionReplies().length;
  admissionControl('confirm-start');
  expect(recordingAdmissionReplies()).toHaveLength(before + 1);
  expect(recordingAdmissionReplies().at(-1)).toMatchObject({ phase: 'started', ok: true });
  admissionControl('cancel-start');
  startAdmission('later', 'later-film');
  admissionControl('confirm-start', 'later', 'later-film');
  admissionControl('cancel-start');
  const newerBefore = recordingAdmissionReplies().length;
  admissionControl('confirm-start', 'later', 'later-film');
  expect(recordingAdmissionReplies()).toHaveLength(newerBefore + 1);
});
it.each(['same-binding', 'new-generation'])(
  'occupied finishing job refuses START across %s until actual disposal',
  async (boundary) => {
    const hook = mount();
    let release!: (outcome: EncodeOutcome) => void;
    encodeGif.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    record('start', 'a-start', 'a-film');
    await settle();
    capture(frameRequest());
    record('stop', 'a-stop', 'a-film');
    await settle();
    capture(frameRequest());
    await settle();
    expect(release).toBeDefined();
    if (boundary === 'new-generation') {
      hook.rerender({ reloadNonce: 1 });
      act(() => hook.result.current.noteFrameLoaded());
      ready();
    }
    startAdmission('b-start', 'b-film');
    expect(recordingAdmissionReplies().at(-1)).toMatchObject({
      requestId: 'b-start',
      phase: 'reserved',
      ok: false,
    });
    admissionControl('cancel-start', 'b-start', 'b-film');
    release(OK_GIF);
    await settle();
    startAdmission('c-start', 'c-film');
    expect(recordingAdmissionReplies().at(-1)).toMatchObject({
      requestId: 'c-start',
      phase: 'reserved',
      ok: true,
    });
  }
);

function deferredRasterizer() {
  let resolve!: (source: string) => void;
  let reject!: (error: Error) => void;
  loadRasterizerSource.mockImplementationOnce(
    () =>
      new Promise<string>((accept, refuse) => {
        resolve = accept;
        reject = refuse;
      })
  );
  return {
    resolve: (source = 'RASTERIZER_SRC') => resolve(source),
    reject: () => reject(new Error('late import failure')),
  };
}
function captureBackedAction(requestId: string) {
  emit({
    type: 'devtools_action_request',
    requestId,
    targetClientId: transport.clientId,
    documentId: 'doc',
    bridgeGeneration: generation(),
    command: { action: 'click', target: { selector: '#pay' } },
    capture: true,
  });
}
function forwardedRequests() {
  return vi
    .mocked(iframe.contentWindow!.postMessage)
    .mock.calls.filter(([message]) =>
      ['capture-request', 'act-request'].includes(message.__dorkosDevtools)
    );
}
for (const kind of ['capture', 'action', 'frame'] as const) {
  for (const completion of ['success', 'failure'] as const) {
    it.each([8000, 8001])(
      `expires lazy ${kind} ${completion} at %sms without timer dispatch and admits a later request`,
      async (elapsed) => {
        mount();
        const lazy = deferredRasterizer();
        if (kind === 'capture') request('expired');
        else if (kind === 'action') captureBackedAction('expired');
        else record('start', 'start');
        const timers = vi.getTimerCount();
        vi.setSystemTime(Date.now() + elapsed);
        expect(vi.getTimerCount()).toBe(timers);
        if (completion === 'success') lazy.resolve();
        else lazy.reject();
        await settle();
        expect(forwardedRequests()).toHaveLength(0);
        if (kind === 'frame') {
          record('stop', 'stop');
          await settle();
          capture(frameRequest());
          await settle();
          expect(uploadDevtoolsRecording).toHaveBeenCalledTimes(1);
          expect(uploadDevtoolsRecording.mock.calls.at(-1)![1]).toMatchObject({ frames: 1 });
        }
        request('later');
        await settle();
        capture('later');
        expect(captureCalls().at(-1)![1].screenshot).toMatchObject({
          requestId: 'later',
          dataUrl: PNG,
        });
      }
    );
  }
}
it.each(['success', 'failure'] as const)(
  'an old lazy %s cannot forward under a replacement same-ID capture',
  async (completion) => {
    mount();
    const old = deferredRasterizer();
    request('reused');
    capture('reused');
    const newer = deferredRasterizer();
    request('reused');
    if (completion === 'success') old.resolve('OLD');
    else old.reject();
    await settle();
    expect(forwardedRequests()).toHaveLength(0);
    newer.resolve('NEW');
    await settle();
    expect(forwardedRequests()).toHaveLength(1);
    expect(forwardedRequests()[0][0].lib).toBe('NEW');
    capture('reused');
    expect(captureCalls()).toHaveLength(2);
  }
);
it('an old dispatched timer callback cannot delete a replacement same-ID pending entry', async () => {
  mount();
  const timers = vi.spyOn(globalThis, 'setTimeout');
  try {
    request('reused');
    const oldCallback = timers.mock.calls.find(([, delay]) => delay === 8000)![0] as () => void;
    await settle();
    capture('reused');
    request('reused');
    oldCallback();
    await settle();
    capture('reused');
    expect(captureCalls()).toHaveLength(2);
  } finally {
    timers.mockRestore();
  }
});
it.each(['success', 'failure'] as const)(
  'an old frame import %s cannot touch a replacement same-ID frame',
  async (completion) => {
    mount();
    const uuid = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-000000000001');
    try {
      const old = deferredRasterizer();
      record('start', 'start');
      await act(() => vi.advanceTimersByTimeAsync(8000));
      const newer = deferredRasterizer();
      record('stop', 'stop');
      if (completion === 'success') old.resolve('OLD');
      else old.reject();
      await settle();
      expect(forwardedRequests()).toHaveLength(0);
      expect(encodeGif).not.toHaveBeenCalled();
      newer.resolve('NEW');
      await settle();
      expect(forwardedRequests()).toHaveLength(1);
      expect(forwardedRequests()[0][0].lib).toBe('NEW');
      capture(frameRequest());
      await settle();
      expect(uploadDevtoolsRecording).toHaveBeenCalledTimes(1);
    } finally {
      uuid.mockRestore();
    }
  }
);
it('refuses a response at the exact pending deadline and permits a later ordinary response', async () => {
  mount();
  request('expired');
  await settle();
  vi.setSystemTime(Date.now() + 8000);
  capture('expired');
  expect(captureCalls()).toHaveLength(0);
  request('later');
  await settle();
  capture('later');
  expect(captureCalls()).toHaveLength(1);
});
