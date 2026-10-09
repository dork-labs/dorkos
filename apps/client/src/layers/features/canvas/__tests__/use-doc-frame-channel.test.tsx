/** @vitest-environment jsdom */
/** Mechanical mount ordering; original recovery/facade authority has separate controls. */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { createMockTransport } from '@dorkos/test-utils';
import { createDocChannelOwner } from '../model/doc-channel-owner';
import { emptyDocChannelView, projectDocChannelPort } from '../model/doc-channel-view';
import type {
  FrameLifetimeController,
  FrameObservation,
} from '@/layers/shared/lib/canvas-doc-frame';
import { useDocFrameChannel } from '../model/use-doc-frame-channel';
const fixture = vi.hoisted(() => ({
  doc: {} as any,
  transport: {},
  listeners: new Set<() => void>(),
}));
vi.mock('@/layers/shared/model', () => ({ useTransport: () => fixture.transport }));
vi.mock('../model/use-doc-channel', () => ({ useDocChannel: () => fixture.doc }));
afterEach(() => {
  fixture.listeners.clear();
  vi.restoreAllMocks();
});
function subject(read = true) {
  let current = read;
  const attach = vi.fn(() => null);
  const complete = vi.fn();
  fixture.doc = {
    replayObserved: true,
    channel: { current: () => current },
    events: [],
    frameAdmission: {
      prepareFrameLoad: vi.fn(
        (controller: FrameLifetimeController, observation: FrameObservation) => {
          for (const listener of fixture.listeners) listener();
          return {
            completeLoad: () => {
              complete();
              return controller.observeLoaded(observation);
            },
          };
        }
      ),
      attachFrame: attach,
      retainsLoadedFrame: (controller: FrameLifetimeController, observation: FrameObservation) =>
        controller.getCurrent() === observation && observation.loaded,
      subscribeInvalidation: (listener: () => void) => {
        fixture.listeners.add(listener);
        return () => fixture.listeners.delete(listener);
      },
    },
  };
  return {
    attach,
    complete,
    prepare: fixture.doc.frameAdmission.prepareFrameLoad,
    revoke: () => {
      current = false;
      for (const listener of fixture.listeners) listener();
    },
  };
}
function Mount({ documentId = 'doc' }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const frame = useDocFrameChannel({
    iframeRef,
    documentId,
    logicalUrl: '/preview',
    reloadNonce: 0,
    resolvedSource: '/preview',
    previewOrigin: 'http://localhost:4242',
    bridgeEligibility: 'preview-listener',
  });
  return (
    <iframe
      ref={iframeRef}
      title="native subject"
      src={frame.navigationSource ?? undefined}
      onLoad={(event) => frame.noteFrameLoaded(event.currentTarget)}
    />
  );
}
it('captures before real navigation only after the blank load, then consumes once on actual load', () => {
  const own = subject();
  render(<Mount />);
  const iframe = screen.getByTitle('native subject') as HTMLIFrameElement;
  // Browsers preserve the iframe WindowProxy across navigation; jsdom replaces
  // its Window object when src changes. This mechanical fixture models only
  // that stable physical proxy, leaving real facade authority to native tests.
  const windowProxy = iframe.contentWindow;
  vi.spyOn(iframe, 'contentWindow', 'get').mockReturnValue(windowProxy);
  expect(iframe.getAttribute('src')).toBe('about:blank');
  expect(own.prepare).not.toHaveBeenCalled();
  fireEvent.load(iframe);
  expect(own.prepare).toHaveBeenCalledTimes(1);
  expect(iframe.getAttribute('src')).toBe('/preview');
  expect(own.complete).not.toHaveBeenCalled();
  fireEvent.load(iframe);
  expect(own.complete).toHaveBeenCalledTimes(1);
  expect(own.attach).toHaveBeenCalledTimes(1);
  fireEvent.load(iframe);
  expect(own.complete).toHaveBeenCalledTimes(1);
  expect(own.attach).toHaveBeenCalledTimes(1);
});
it('keeps the original physical load when the same facade qualifies after its loading projection', () => {
  const own = subject(false);
  fixture.doc.replayObserved = false;
  const admission = fixture.doc.frameAdmission;
  const mounted = render(<Mount />);
  const iframe = screen.getByTitle('native subject') as HTMLIFrameElement;
  const windowProxy = iframe.contentWindow;
  vi.spyOn(iframe, 'contentWindow', 'get').mockReturnValue(windowProxy);
  fireEvent.load(iframe);
  expect(own.prepare).not.toHaveBeenCalled();
  // The original owner publishes the same nonissuing facade before HTTP
  // qualification, then a new genuine-current channel projection afterwards.
  fixture.doc = { ...fixture.doc, replayObserved: true, channel: { current: () => true } };
  mounted.rerender(<Mount />);
  expect(fixture.doc.frameAdmission).toBe(admission);
  expect(own.prepare).toHaveBeenCalledTimes(1);
  expect(iframe.getAttribute('src')).toBe('/preview');
  fireEvent.load(iframe);
  expect(own.complete).toHaveBeenCalledTimes(1);
  expect(own.attach).toHaveBeenCalledTimes(1);
});
it('does not preserve an old facade load using a replacement facade currentness projection', () => {
  const own = subject();
  const mounted = render(<Mount />);
  const iframe = screen.getByTitle('native subject') as HTMLIFrameElement;
  const windowProxy = iframe.contentWindow;
  vi.spyOn(iframe, 'contentWindow', 'get').mockReturnValue(windowProxy);
  fireEvent.load(iframe);
  const oldInvalidation = [...fixture.listeners][0];
  const originalController = own.prepare.mock.calls[0][0] as FrameLifetimeController;
  expect(originalController.getCurrent()).not.toBeNull();
  subject();
  const replacement = fixture.doc.frameAdmission;
  mounted.rerender(<Mount />);
  act(() => oldInvalidation());
  expect(originalController.getCurrent()).toBeNull();
  fireEvent.load(iframe);
  expect(own.complete).not.toHaveBeenCalled();
  expect(own.attach).not.toHaveBeenCalled();
  expect(replacement.prepareFrameLoad).not.toHaveBeenCalled();
  expect(replacement.attachFrame).not.toHaveBeenCalled();
});
it('displays a refused/legacy page after replay without acquiring a Doc port', () => {
  const own = subject(false);
  render(<Mount />);
  const iframe = screen.getByTitle('native subject');
  fireEvent.load(iframe);
  expect(iframe.getAttribute('src')).toBe('/preview');
  fireEvent.load(iframe);
  expect(own.prepare).not.toHaveBeenCalled();
  expect(own.attach).not.toHaveBeenCalled();
});
it('revocation preserves the mounted page and cannot relabel its old load after replay', () => {
  const own = subject();
  const mounted = render(<Mount />);
  const iframe = screen.getByTitle('native subject');
  fireEvent.load(iframe);
  act(() => own.revoke());
  subject();
  const replacement = fixture.doc.frameAdmission;
  mounted.rerender(<Mount />);
  expect(screen.getByTitle('native subject')).toBe(iframe);
  expect(iframe.getAttribute('src')).toBe('/preview');
  fireEvent.load(iframe);
  expect(replacement.prepareFrameLoad).not.toHaveBeenCalled();
  expect(replacement.attachFrame).not.toHaveBeenCalled();
});

it('refuses a changed iframe Window instead of consuming the previous physical load', () => {
  const own = subject();
  render(<Mount />);
  const iframe = screen.getByTitle('native subject') as HTMLIFrameElement;
  const blankWindow = iframe.contentWindow;
  fireEvent.load(iframe);
  expect(own.prepare).toHaveBeenCalledTimes(1);
  expect(iframe.contentWindow === blankWindow).toBe(false); // Actual jsdom navigation replacement.
  fireEvent.load(iframe);
  expect(own.complete).not.toHaveBeenCalled();
  expect(own.attach).not.toHaveBeenCalled();
});

it('observes an already completed initial blank document without manufacturing the real load', () => {
  const own = subject();
  const mounted = render(<Mount />);
  const iframe = screen.getByTitle('native subject') as HTMLIFrameElement;
  const blankDocument = iframe.contentDocument;
  const windowProxy = iframe.contentWindow;
  expect(blankDocument?.URL).toBe('about:blank');
  expect(own.prepare).not.toHaveBeenCalled();
  // The frame owns a different Document realm from the parent. Observe that
  // actual document, then render its completed state without firing a load.
  vi.spyOn(blankDocument!, 'readyState', 'get').mockReturnValue('complete');
  vi.spyOn(iframe, 'contentWindow', 'get').mockReturnValue(windowProxy);
  mounted.rerender(<Mount />);
  expect(own.prepare).toHaveBeenCalledTimes(1);
  expect(iframe.getAttribute('src')).toBe('/preview');
  expect(own.complete).not.toHaveBeenCalled();
  expect(own.attach).not.toHaveBeenCalled();
});

it('does not consume a queued blank load after assigning the real source', () => {
  const own = subject();
  render(<Mount />);
  const iframe = screen.getByTitle('native subject') as HTMLIFrameElement;
  const blankDocument = iframe.contentDocument;
  const windowProxy = iframe.contentWindow;
  vi.spyOn(iframe, 'contentWindow', 'get').mockReturnValue(windowProxy);
  fireEvent.load(iframe);
  expect(iframe.getAttribute('src')).toBe('/preview');
  const oldDocument = vi.spyOn(iframe, 'contentDocument', 'get').mockReturnValue(blankDocument);
  fireEvent.load(iframe);
  expect(own.complete).not.toHaveBeenCalled();
  expect(own.attach).not.toHaveBeenCalled();
  oldDocument.mockRestore();
  fireEvent.load(iframe);
  expect(own.complete).toHaveBeenCalledTimes(1);
  expect(own.attach).toHaveBeenCalledTimes(1);
});

it('prepares the original log-only frame from read currentness without enabling widget submit', () => {
  const own = subject();
  fixture.doc.channel = { current: (purpose: string) => purpose === 'read' };
  render(<Mount />);
  const iframe = screen.getByTitle('native subject') as HTMLIFrameElement;
  const windowProxy = iframe.contentWindow;
  vi.spyOn(iframe, 'contentWindow', 'get').mockReturnValue(windowProxy);
  fireEvent.load(iframe);
  expect(own.prepare).toHaveBeenCalledTimes(1);
  expect(iframe.getAttribute('src')).toBe('/preview');
  fireEvent.load(iframe);
  expect(own.complete).toHaveBeenCalledTimes(1);
  expect(own.attach).toHaveBeenCalledTimes(1);
});

it('renews a quarantined original loaded frame only after same-birth private HTTP qualification', async () => {
  const transport = createMockTransport();
  const incarnation = {
    v: 1 as const,
    documentId: 'doc',
    physicalOpenedAt: '2026-10-02T00:00:00Z',
    channelCreatedAt: '2026-10-02T00:00:01Z',
    generation: 'a'.repeat(64),
  };
  const response = {
    incarnation,
    events: [],
    state: {},
    stateRev: 0,
    highWatermark: 0,
    retentionFloor: 1,
    receiptRetentionFloor: 1,
    resetRequired: false,
    receipts: [],
    health: { status: 'ready' as const, reasons: [] },
    routing: { enabled: true, destinationLabel: 'Tasks', approvedEventTypes: ['save'] },
  };
  vi.mocked(transport.getCanvasChannel).mockResolvedValue(response);
  fixture.transport = transport;
  let view = emptyDocChannelView('doc', transport);
  const owner = createDocChannelOwner('doc', transport, (update) => {
    view = typeof update === 'function' ? update(view) : update;
    fixture.doc = { ...view, channel: projectDocChannelPort(view), frameAdmission: admission };
  });
  const original = owner.frameAdmission;
  const admission = {
    ...original,
    prepareFrameLoad: vi.fn(original.prepareFrameLoad),
    attachFrame: vi.fn(original.attachFrame),
  };
  let mounted: ReturnType<typeof render> | undefined;
  let failure: { cause: unknown } | undefined;
  const remember = (cause: unknown) => {
    failure ??= { cause };
  };
  const qualify = async () => {
    const run = owner.beginRun(),
      page = await run.readPage();
    const result = run.consumePage(page!);
    if (result.kind === 'frames') expect(run.finishPage(page!)).toBe('done');
    return result;
  };
  try {
    expect(await qualify()).toEqual({ kind: 'frames', count: 0 });
    mounted = render(<Mount />);
    const iframe = screen.getByTitle('native subject') as HTMLIFrameElement;
    const originalWindow = iframe.contentWindow;
    if (!originalWindow) throw new Error('Original unit frame window unavailable');
    vi.spyOn(iframe, 'contentWindow', 'get').mockReturnValue(originalWindow);
    const challenge = vi.spyOn(originalWindow, 'postMessage').mockImplementation(() => {});
    fireEvent.load(iframe); // Original blank navigation gate.
    fireEvent.load(iframe); // Consume the original source's actual load once.
    expect(admission.prepareFrameLoad).toHaveBeenCalledTimes(1);
    expect(admission.attachFrame).toHaveBeenCalledTimes(1);
    expect(challenge).toHaveBeenCalledTimes(1);
    const controller = admission.attachFrame.mock.calls[0][0];
    const observation = admission.attachFrame.mock.calls[0][1];
    const oldPort = admission.attachFrame.mock.results[0].value!;
    act(() => owner.beginRun().failed());
    expect(oldPort.current()).toBe(false);
    expect(controller.getCurrent()).toBe(observation);
    expect(original.retainsLoadedFrame(controller, observation)).toBe(true);
    expect(challenge).toHaveBeenCalledTimes(1);
    await act(async () => {
      expect(await qualify()).toEqual({ kind: 'frames', count: 0 });
    });
    mounted.rerender(<Mount />);
    expect(screen.getByTitle('native subject')).toBe(iframe);
    expect(admission.prepareFrameLoad).toHaveBeenCalledTimes(1);
    expect(admission.attachFrame).toHaveBeenCalledTimes(2);
    expect(admission.attachFrame.mock.calls[1]).toEqual([controller, observation]);
    expect(challenge).toHaveBeenCalledTimes(2);
    expect(oldPort.current()).toBe(false);
    expect(admission.attachFrame.mock.results[1].value!.current()).toBe(true);
    // A changed private birth retires that witness rather than relabeling this mounted page.
    act(() => owner.beginRun().failed());
    vi.mocked(transport.getCanvasChannel).mockResolvedValue({
      ...response,
      incarnation: {
        ...incarnation,
        generation: 'b'.repeat(64),
        physicalOpenedAt: '2026-10-03T00:00:00Z',
      },
    });
    await act(async () => {
      expect(await qualify()).toEqual({ kind: 'done' });
      expect(await qualify()).toEqual({ kind: 'frames', count: 0 });
    });
    mounted.rerender(<Mount />);
    expect(screen.getByTitle('native subject')).toBe(iframe);
    expect(controller.getCurrent()).toBeNull();
    expect(original.retainsLoadedFrame(controller, observation)).toBe(false);
    expect(admission.prepareFrameLoad).toHaveBeenCalledTimes(1);
    expect(admission.attachFrame).toHaveBeenCalledTimes(2);
    expect(challenge).toHaveBeenCalledTimes(2);
  } catch (cause) {
    remember(cause);
  }
  try {
    mounted?.unmount();
  } catch (cause) {
    remember(cause);
  }
  try {
    owner.dispose();
  } catch (cause) {
    remember(cause);
  }
  if (failure) throw failure.cause;
});
