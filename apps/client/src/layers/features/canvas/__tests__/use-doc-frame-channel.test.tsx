/** @vitest-environment jsdom */
// The hook against the real owner, controller and handshake classes; only the
// page's acknowledgement is stubbed, because jsdom frames run no page script.
import { Suspense, useRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type {
  CanvasChannelFrame,
  CanvasChannelReplayResponse,
} from '@dorkos/shared/canvas-channel-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { DocFrameHandshake, FrameLifetimeController } from '@/layers/shared/lib/canvas-doc-frame';
import { ownDocChannelConnection } from '@/layers/shared/lib/transport/doc-channel-ownership';
import { useDocFrameChannel, type DocFrameChannelParams } from '../model/use-doc-frame-channel';

const birth = {
  v: 1 as const,
  documentId: 'frame-doc',
  physicalOpenedAt: '2026-10-02T00:00:00Z',
  channelCreatedAt: '2026-10-02T00:00:01Z',
  generation: 'a'.repeat(64),
};
const frameEvent = (docSeq: number): CanvasChannelFrame => ({
  type: 'canvas_event',
  scope: 'session-a',
  documentId: 'frame-doc',
  docSeq,
  incarnation: birth,
  event: {
    id: `00000000-0000-4000-8000-00000000000${docSeq}`,
    type: 'agent.reply',
    payload: { n: docSeq },
    direction: 'downstream',
    receivedAt: '2026-10-02T00:00:02Z',
  },
});
const replay = (
  routing = true,
  events: CanvasChannelFrame[] = [],
  documentId = 'frame-doc'
): CanvasChannelReplayResponse => ({
  incarnation: { ...birth, documentId },
  events,
  state: { step: 1 },
  stateRev: 1,
  highWatermark: events.length,
  retentionFloor: 1,
  receiptRetentionFloor: 1,
  resetRequired: false,
  receipts: [],
  health: { status: 'ready', reasons: [] },
  routing: {
    enabled: routing,
    destinationLabel: routing ? 'Tasks' : 'Approval needed',
    approvedEventTypes: routing ? ['save'] : [],
  },
});

function Host({
  documentId = 'frame-doc',
  nonce = 0,
  bridgeEligibility = 'served-document',
  previewOrigin = null,
}: {
  documentId?: string;
  nonce?: number;
  bridgeEligibility?: DocFrameChannelParams['bridgeEligibility'];
  previewOrigin?: string | null;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const channel = useDocFrameChannel({
    iframeRef,
    documentId,
    logicalUrl: 'frame.html',
    reloadNonce: nonce,
    resolvedSource: '/served/frame.html',
    bridgeEligibility,
    previewOrigin,
  });
  return (
    <iframe
      key={nonce}
      ref={iframeRef}
      src="/served/frame.html"
      title={documentId === 'frame-doc' ? 'page' : documentId}
      data-requires-reload={channel.requiresReload ? 'yes' : 'no'}
      onLoad={(event) => channel.noteFrameLoaded(event.currentTarget)}
    />
  );
}

let transport: ReturnType<typeof createMockTransport>;
const tree = (node: React.ReactNode) => (
  <TransportProvider transport={transport}>{node}</TransportProvider>
);
const frame = () => screen.getByTitle('page') as HTMLIFrameElement;
const started = () =>
  vi.mocked(DocFrameHandshake.prototype.start).mock.contexts as DocFrameHandshake[];
/** The page answers the newest challenge, as the injected SDK would. */
function acknowledge() {
  vi.mocked(DocFrameHandshake.prototype.receive).mockImplementation(function (
    this: DocFrameHandshake
  ) {
    return this === started().at(-1);
  });
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: 'ack' }));
  });
}
// Identity checks only: a handshake holds a bound port whose own `inspect` the
// assertion formatter would call on a retired binding.
const closed = (handshake: DocFrameHandshake) =>
  vi.mocked(DocFrameHandshake.prototype.close).mock.contexts.includes(handshake);
const published = (kind: string) =>
  vi
    .mocked(DocFrameHandshake.prototype.publish)
    .mock.calls.filter(([payload]) => payload.kind === kind);

beforeEach(() => {
  transport = createMockTransport();
  vi.mocked(transport.getCanvasChannel).mockResolvedValue(replay());
  vi.spyOn(DocFrameHandshake.prototype, 'start');
  vi.spyOn(DocFrameHandshake.prototype, 'close');
  vi.spyOn(DocFrameHandshake.prototype, 'publish');
  vi.spyOn(DocFrameHandshake.prototype, 'receive').mockReturnValue(false);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('offers a port only after the frame itself reports a load, bound to the opaque served origin', async () => {
  const observe = vi.spyOn(FrameLifetimeController.prototype, 'observeHostContext');
  render(tree(<Host />));
  await waitFor(() => expect(transport.getCanvasChannel).toHaveBeenCalled());
  await act(async () => {});
  expect(observe).not.toHaveBeenCalled();
  fireEvent.load(frame());
  await waitFor(() => expect(started()).toHaveLength(1));
  const captured = observe.mock.calls[0][0];
  // Identity, never deep equality: a jsdom Window is an endless graph to walk.
  expect(captured.frame === frame().contentWindow).toBe(true);
  expect(captured.transportOwner === transport).toBe(true);
  expect(captured).toMatchObject({
    documentId: 'frame-doc',
    eligibility: 'served-document',
    exactOrigin: 'null',
  });
});

it('binds a preview page to the exact origin DorkOS minted for it', async () => {
  const observe = vi.spyOn(FrameLifetimeController.prototype, 'observeHostContext');
  render(
    tree(<Host bridgeEligibility="preview-listener" previewOrigin="http://localhost:61000" />)
  );
  fireEvent.load(frame());
  await waitFor(() => expect(started()).toHaveLength(1));
  expect(observe.mock.calls[0][0]).toMatchObject({
    eligibility: 'preview-listener',
    exactOrigin: 'http://localhost:61000',
  });
});

it('a page DorkOS does not serve never gets a capture or a port', async () => {
  const observe = vi.spyOn(FrameLifetimeController.prototype, 'observeHostContext');
  render(tree(<Host bridgeEligibility={null} />));
  fireEvent.load(frame());
  await waitFor(() => expect(transport.getCanvasChannel).toHaveBeenCalled());
  await act(async () => {});
  expect(observe).not.toHaveBeenCalled();
  expect(started()).toHaveLength(0);
});

it('a page that loads before any route is approved connects by itself once one is', async () => {
  vi.mocked(transport.getCanvasChannel).mockResolvedValue(replay(false));
  const connection = ownDocChannelConnection(transport, new AbortController().signal);
  try {
    render(tree(<Host />));
    const element = frame();
    fireEvent.load(element);
    await waitFor(() => expect(transport.getCanvasChannel).toHaveBeenCalled());
    await act(async () => {});
    expect(started()).toHaveLength(0);
    // No route yet is not something a reload fixes, so nothing tells the person to.
    expect(element.dataset.requiresReload).toBe('no');
    const { events: _events, ...snapshot } = replay(true);
    await act(async () => {
      connection.publish({
        type: 'canvas_channel_snapshot',
        documentId: 'frame-doc',
        scope: 'session-a',
        snapshot,
      });
    });
    await waitFor(() => expect(started()).toHaveLength(1));
    expect(frame()).toBe(element);
  } finally {
    connection.retire();
  }
});

it('sends each event and state once per page, however often the host renders', async () => {
  vi.mocked(transport.getCanvasChannel).mockResolvedValue(
    replay(true, [frameEvent(1), frameEvent(2)])
  );
  const host = render(tree(<Host />));
  fireEvent.load(frame());
  await waitFor(() => expect(started()).toHaveLength(1));
  acknowledge();
  expect(published('event').map(([payload]) => payload)).toEqual([
    { kind: 'event', frame: frameEvent(1) },
    { kind: 'event', frame: frameEvent(2) },
  ]);
  expect(published('state')).toHaveLength(1);
  host.rerender(tree(<Host />));
  host.rerender(tree(<Host />));
  acknowledge();
  expect(published('event')).toHaveLength(2);
  expect(published('state')).toHaveLength(1);
  // The host never re-announces readiness: the page already said it is ready.
  expect(published('status')).toHaveLength(0);
});

it('a page that reloads itself loses its old port first, then reconnects with a fresh one', async () => {
  vi.mocked(transport.getCanvasChannel).mockResolvedValue(replay(true, [frameEvent(1)]));
  render(tree(<Host />));
  const element = frame();
  fireEvent.load(element);
  await waitFor(() => expect(started()).toHaveLength(1));
  acknowledge();
  const first = started()[0];
  fireEvent.load(element);
  await waitFor(() => expect(started()).toHaveLength(2));
  expect(closed(first)).toBe(true);
  expect(started()[1] === first).toBe(false);
  acknowledge();
  // A new document starts empty, so it gets the history again; the old one never does.
  expect(published('event')).toHaveLength(2);
  expect(frame().dataset.requiresReload).toBe('no');
});

it('says Reload only when a page that was connected stops answering', async () => {
  render(tree(<Host />));
  const element = frame();
  fireEvent.load(element);
  await waitFor(() => expect(started()).toHaveLength(1));
  // Never connected: an uninstrumented page timing out is just a plain page.
  act(() => started()[0].close());
  expect(element.dataset.requiresReload).toBe('no');
  fireEvent.load(element);
  await waitFor(() => expect(started()).toHaveLength(2));
  acknowledge();
  fireEvent.load(element);
  await waitFor(() => expect(started()).toHaveLength(3));
  act(() => started()[2].close());
  expect(element.dataset.requiresReload).toBe('yes');
  fireEvent.load(element);
  await waitFor(() => expect(element.dataset.requiresReload).toBe('no'));
});

it('a live page closing its own port on unload is not offered a new one until it loads again', async () => {
  render(tree(<Host />));
  const element = frame();
  fireEvent.load(element);
  await waitFor(() => expect(started()).toHaveLength(1));
  acknowledge();
  act(() => started()[0].close());
  expect(element.dataset.requiresReload).toBe('no');
  await act(async () => {});
  expect(started()).toHaveLength(1);
  fireEvent.load(element);
  await waitFor(() => expect(started()).toHaveLength(2));
});

it('an explicit reload replaces the frame and closes the old port', async () => {
  const host = render(tree(<Host />));
  const old = frame();
  fireEvent.load(old);
  await waitFor(() => expect(started()).toHaveLength(1));
  acknowledge();
  host.rerender(tree(<Host nonce={1} />));
  expect(closed(started()[0])).toBe(true);
  const fresh = frame();
  expect(fresh).not.toBe(old);
  // A late load from the removed element is not this navigation's page.
  fireEvent.load(old);
  await act(async () => {});
  expect(started()).toHaveLength(1);
  fireEvent.load(fresh);
  await waitFor(() => expect(started()).toHaveLength(2));
});

it('a hidden view keeps no port, and the same page reconnects when it is shown again', async () => {
  let hidden: Promise<void> | null = null;
  function MaybeHidden() {
    if (hidden) throw hidden;
    return <Host />;
  }
  const view = () => tree(<Suspense fallback={<p>hidden</p>}>{<MaybeHidden />}</Suspense>);
  const host = render(view());
  const element = frame();
  fireEvent.load(element);
  await waitFor(() => expect(started()).toHaveLength(1));
  acknowledge();
  let reveal!: () => void;
  hidden = new Promise<void>((resolve) => {
    reveal = resolve;
  });
  host.rerender(view());
  expect(screen.getByText('hidden')).toBeTruthy();
  expect(closed(started()[0])).toBe(true);
  hidden = null;
  await act(async () => {
    reveal();
  });
  host.rerender(view());
  expect(frame()).toBe(element);
  await waitFor(() => expect(started()).toHaveLength(2));
  expect(element.dataset.requiresReload).toBe('no');
});

it('unmounting closes the port and stops listening for the page', async () => {
  const remove = vi.spyOn(window, 'removeEventListener');
  const host = render(tree(<Host />));
  fireEvent.load(frame());
  await waitFor(() => expect(started()).toHaveLength(1));
  host.unmount();
  expect(closed(started()[0])).toBe(true);
  expect(remove.mock.calls.some(([type]) => type === 'message')).toBe(true);
});

// The rest use the real handshake: what the page posts back is what decides.
/** Every message the host posted into this window, newest last. */
function postsTo(target: Window) {
  return vi.spyOn(target, 'postMessage') as unknown as {
    mock: { calls: [Record<string, unknown>, string, MessagePort[]?][] };
  };
}
const challenges = (posts: ReturnType<typeof postsTo>) =>
  posts.mock.calls.map(([data]) => data).filter((data) => data.kind === 'challenge');
const connected = (posts: ReturnType<typeof postsTo>) =>
  posts.mock.calls.filter(([data]) => data.kind === 'connect').length;
/** Post an acknowledgement as `source` would, optionally from another origin or with other fields. */
function answer(
  challenge: Record<string, unknown>,
  source: Window,
  origin = 'null',
  fields: Record<string, unknown> = {}
) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { ...challenge, kind: 'ack', ...fields },
        origin,
        source,
      })
    );
  });
}

it('an answer to a replaced page’s challenge cannot connect the page that replaced it', async () => {
  vi.mocked(DocFrameHandshake.prototype.receive).mockRestore();
  render(tree(<Host />));
  const element = frame();
  const page = element.contentWindow!;
  const posts = postsTo(page);
  fireEvent.load(element);
  await waitFor(() => expect(challenges(posts)).toHaveLength(1));
  const stale = challenges(posts)[0]!;
  fireEvent.load(element);
  await waitFor(() => expect(challenges(posts)).toHaveLength(2));
  const current = challenges(posts)[1]!;
  expect(current.nonce).not.toBe(stale.nonce);
  answer(stale, page);
  expect(connected(posts)).toBe(0);
  answer(current, page);
  expect(connected(posts)).toBe(1);
});

it('one frame’s answer never connects another frame', async () => {
  vi.mocked(DocFrameHandshake.prototype.receive).mockRestore();
  vi.mocked(transport.getCanvasChannel).mockImplementation(async (documentId: string) =>
    replay(true, [], documentId)
  );
  render(
    tree(
      <>
        <Host documentId="doc-a" />
        <Host documentId="doc-b" />
      </>
    )
  );
  const a = screen.getByTitle('doc-a') as HTMLIFrameElement;
  const b = screen.getByTitle('doc-b') as HTMLIFrameElement;
  const toA = postsTo(a.contentWindow!);
  const toB = postsTo(b.contentWindow!);
  fireEvent.load(a);
  fireEvent.load(b);
  await waitFor(() => expect(challenges(toA)).toHaveLength(1));
  await waitFor(() => expect(challenges(toB)).toHaveLength(1));
  // A's correct answer, but sent from B's window: refused by both hosts.
  answer(challenges(toA)[0]!, b.contentWindow!);
  expect(connected(toA) + connected(toB)).toBe(0);
  answer(challenges(toA)[0]!, a.contentWindow!);
  expect(connected(toA)).toBe(1);
  expect(connected(toB)).toBe(0);
});

// A route to the agent itself is granted with no person, so a port is the
// agent's own front door: only a page DorkOS serves or previews may hold one.
it('an outside page never gets a challenge, and replaying a served page’s challenge gets it nothing', async () => {
  vi.mocked(DocFrameHandshake.prototype.receive).mockRestore();
  vi.mocked(transport.getCanvasChannel).mockImplementation(async (documentId: string) =>
    replay(true, [], documentId)
  );
  render(
    tree(
      <>
        <Host documentId="served" />
        <Host documentId="outside" bridgeEligibility={null} />
      </>
    )
  );
  const served = screen.getByTitle('served') as HTMLIFrameElement;
  const outside = screen.getByTitle('outside') as HTMLIFrameElement;
  const toServed = postsTo(served.contentWindow!);
  const toOutside = postsTo(outside.contentWindow!);
  fireEvent.load(served);
  fireEvent.load(outside);
  await waitFor(() => expect(challenges(toServed)).toHaveLength(1));
  const challenge = challenges(toServed)[0]!;
  // A perfectly shaped answer, from the outside page's window, under every origin it could claim.
  for (const origin of ['https://example.com', 'null', 'http://localhost:61000'])
    answer(challenge, outside.contentWindow!, origin);
  expect(toOutside.mock.calls).toHaveLength(0);
  expect(connected(toServed)).toBe(0);
  // The served page itself still connects, so the refusal above was not a dead host.
  answer(challenge, served.contentWindow!);
  expect(connected(toServed)).toBe(1);
  expect(toOutside.mock.calls).toHaveLength(0);
});

it.each<[string, string, Record<string, unknown>]>([
  ['an outside origin', 'https://example.com', {}],
  ['the opaque origin a served page has', 'null', {}],
  ['a neighbouring loopback port', 'http://localhost:61001', {}],
  ['another nonce', 'http://localhost:61000', { nonce: 'nonce-from-somewhere-else' }],
  ['another request token', 'http://localhost:61000', { requestToken: 'token-from-elsewhere' }],
  ['another load', 'http://localhost:61000', { loadToken: 999 }],
  ['another generation', 'http://localhost:61000', { generation: 'b'.repeat(64) }],
])('a preview answer from %s is ignored', async (_case, origin, fields) => {
  vi.mocked(DocFrameHandshake.prototype.receive).mockRestore();
  render(
    tree(<Host bridgeEligibility="preview-listener" previewOrigin="http://localhost:61000" />)
  );
  const element = frame();
  const page = element.contentWindow!;
  const posts = postsTo(page);
  fireEvent.load(element);
  await waitFor(() => expect(challenges(posts)).toHaveLength(1));
  const challenge = challenges(posts)[0]!;
  // The challenge goes only to the minted origin, never to whoever is there.
  expect(posts.mock.calls[0]![1]).toBe('http://localhost:61000');
  answer(challenge, page, origin, fields);
  expect(connected(posts)).toBe(0);
  answer(challenge, page, 'http://localhost:61000');
  expect(connected(posts)).toBe(1);
});
