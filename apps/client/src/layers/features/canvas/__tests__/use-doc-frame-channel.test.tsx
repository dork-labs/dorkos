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
import { DocChannelFrameResources } from '../model/doc-channel-frame-resources';
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
  documentId = 'frame-doc',
  generation = birth.generation
): CanvasChannelReplayResponse => ({
  incarnation: { ...birth, documentId, generation },
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
/** A dev-server preview: its own exact origin, so it may reconnect on every load. */
const PREVIEW = {
  bridgeEligibility: 'preview-listener',
  previewOrigin: 'http://localhost:61000',
} as const;

function Host({
  documentId = 'frame-doc',
  nonce = 0,
  frameKey = 0,
  bridgeEligibility = 'served-document',
  previewOrigin = null,
}: {
  documentId?: string;
  nonce?: number;
  /** Replaces the iframe element without a new navigation. */
  frameKey?: number;
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
      key={`${nonce}:${frameKey}`}
      ref={iframeRef}
      src={channel.frameSource ?? undefined}
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
/** The boot nonce the host put on this frame's `src`. */
const bootOf = (element: HTMLIFrameElement) =>
  /#dorkos-boot=([0-9a-f-]{36})$/.exec(element.getAttribute('src') ?? '')?.[1];
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
/** Publish a snapshot of the document to the hook, as the server's stream would. */
async function snapshot(
  connection: ReturnType<typeof ownDocChannelConnection>,
  value: CanvasChannelReplayResponse
) {
  const { events: _events, ...rest } = value;
  await act(async () => {
    connection.publish({
      type: 'canvas_channel_snapshot',
      documentId: value.incarnation?.documentId ?? 'frame-doc',
      scope: 'session-a',
      snapshot: rest,
    });
  });
}

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
  // The navigation itself carries the nonce the page must answer with.
  expect(frame().getAttribute('src')).toMatch(/^\/served\/frame\.html#dorkos-boot=[0-9a-f-]{36}$/);
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

it('binds a preview page to the exact origin DorkOS minted for it, with no nonce on its source', async () => {
  const observe = vi.spyOn(FrameLifetimeController.prototype, 'observeHostContext');
  render(tree(<Host {...PREVIEW} />));
  expect(frame().getAttribute('src')).toBe('/served/frame.html');
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
  expect(frame().getAttribute('src')).toBe('/served/frame.html');
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
    await snapshot(connection, replay(true));
    await waitFor(() => expect(started()).toHaveLength(1));
    expect(frame()).toBe(element);
  } finally {
    connection.retire();
  }
});

it('sends each event and state once per page, never the session, room or incarnation', async () => {
  vi.mocked(transport.getCanvasChannel).mockResolvedValue(
    replay(true, [frameEvent(1), frameEvent(2)])
  );
  const host = render(tree(<Host />));
  fireEvent.load(frame());
  await waitFor(() => expect(started()).toHaveLength(1));
  acknowledge();
  const page = (docSeq: number) => ({
    kind: 'event',
    frame: { type: 'canvas_event', docSeq, event: frameEvent(docSeq).event },
  });
  expect(published('event').map(([payload]) => payload)).toEqual([page(1), page(2)]);
  expect(published('state')).toHaveLength(1);
  host.rerender(tree(<Host />));
  host.rerender(tree(<Host />));
  acknowledge();
  expect(published('event')).toHaveLength(2);
  expect(published('state')).toHaveLength(1);
  // The host never re-announces readiness: the page already said it is ready.
  expect(published('status')).toHaveLength(0);
});

it('a served page that leaves its document loses its port and is never challenged again; Reload brings it back', async () => {
  render(tree(<Host />)).rerender(tree(<Host />));
  const element = frame();
  fireEvent.load(element);
  await waitFor(() => expect(started()).toHaveLength(1));
  acknowledge();
  const first = started()[0];
  // A reload, a link, a redirect or `location`: the frame's next document is
  // not one DorkOS navigated to, and it never holds the nonce.
  fireEvent.load(element);
  await act(async () => {});
  expect(closed(first)).toBe(true);
  expect(started()).toHaveLength(1);
  expect(element.dataset.requiresReload).toBe('yes');
});

it('a served page that was never connected leaving its document is just a plain page', async () => {
  render(tree(<Host />));
  const element = frame();
  fireEvent.load(element);
  await waitFor(() => expect(started()).toHaveLength(1));
  fireEvent.load(element);
  await act(async () => {});
  expect(started()).toHaveLength(1);
  expect(element.dataset.requiresReload).toBe('no');
});

it('a preview that reloads itself loses its old port first, then reconnects with a fresh one', async () => {
  vi.mocked(transport.getCanvasChannel).mockResolvedValue(replay(true, [frameEvent(1)]));
  render(tree(<Host {...PREVIEW} />));
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

it('says Reload only when a preview that was connected stops answering', async () => {
  render(tree(<Host {...PREVIEW} />));
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

it('a live preview closing its own port on unload is not offered a new one until it loads again', async () => {
  render(tree(<Host {...PREVIEW} />));
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

it('an explicit reload replaces the frame, closes the old port and mints a new nonce', async () => {
  const host = render(tree(<Host />));
  const old = frame();
  const oldBoot = bootOf(old);
  fireEvent.load(old);
  await waitFor(() => expect(started()).toHaveLength(1));
  acknowledge();
  host.rerender(tree(<Host nonce={1} />));
  expect(closed(started()[0])).toBe(true);
  const fresh = frame();
  expect(fresh).not.toBe(old);
  expect(bootOf(fresh)).toBeDefined();
  expect(bootOf(fresh)).not.toBe(oldBoot);
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

it('a replaced frame element is not challenged with the old one’s load', async () => {
  vi.mocked(transport.getCanvasChannel).mockResolvedValue(replay(false));
  const connection = ownDocChannelConnection(transport, new AbortController().signal);
  try {
    const host = render(tree(<Host />));
    fireEvent.load(frame());
    await waitFor(() => expect(transport.getCanvasChannel).toHaveBeenCalled());
    await act(async () => {});
    // The same navigation, a new element whose own document has not loaded yet.
    host.rerender(tree(<Host frameKey={1} />));
    await snapshot(connection, replay(true));
    expect(started()).toHaveLength(0);
    fireEvent.load(frame());
    await waitFor(() => expect(started()).toHaveLength(1));
  } finally {
    connection.retire();
  }
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

it('an invalidation with nothing else changed still gets the page a fresh handshake', async () => {
  const subscribe = vi.spyOn(DocChannelFrameResources.prototype, 'subscribe');
  render(tree(<Host />));
  fireEvent.load(frame());
  await waitFor(() => expect(started()).toHaveLength(1));
  acknowledge();
  const first = started()[0];
  act(() => {
    for (const [callback] of subscribe.mock.calls) callback();
  });
  await waitFor(() => expect(started()).toHaveLength(2));
  expect(closed(first)).toBe(true);
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
/** The page side of every port the host handed over, oldest first. */
const pagePorts = (posts: ReturnType<typeof postsTo>) =>
  posts.mock.calls.flatMap(([data, , ports]) => (data.kind === 'connect' ? (ports ?? []) : []));
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
/** The served page's own answer: the challenge, with the nonce from its frame's `src`. */
const answerServed = (challenge: Record<string, unknown>, element: HTMLIFrameElement) =>
  answer(challenge, element.contentWindow!, 'null', { boot: bootOf(element) });

it('only the nonce on the frame’s own source connects a served document', async () => {
  vi.mocked(DocFrameHandshake.prototype.receive).mockRestore();
  render(tree(<Host />));
  const element = frame();
  const posts = postsTo(element.contentWindow!);
  fireEvent.load(element);
  await waitFor(() => expect(challenges(posts)).toHaveLength(1));
  const challenge = challenges(posts)[0]!;
  // What a page a redirect put there could send: right window, right origin,
  // the challenge it was given, and no nonce or a guessed one.
  answer(challenge, element.contentWindow!);
  answer(challenge, element.contentWindow!, 'null', { boot: crypto.randomUUID() });
  expect(connected(posts)).toBe(0);
  answerServed(challenge, element);
  expect(connected(posts)).toBe(1);
});

it('a document the served frame reached by itself is never challenged, even holding the old nonce', async () => {
  vi.mocked(DocFrameHandshake.prototype.receive).mockRestore();
  render(tree(<Host />));
  const element = frame();
  const posts = postsTo(element.contentWindow!);
  fireEvent.load(element);
  await waitFor(() => expect(challenges(posts)).toHaveLength(1));
  const challenge = challenges(posts)[0]!;
  answerServed(challenge, element);
  expect(connected(posts)).toBe(1);
  // A link click: same window, same `null` origin, a new document.
  fireEvent.load(element);
  await act(async () => {});
  expect(challenges(posts)).toHaveLength(1);
  // Even with the first page's challenge and nonce leaked to it, nothing connects.
  answerServed(challenge, element);
  expect(connected(posts)).toBe(1);
});

it('an answer to a replaced preview’s challenge cannot connect the page that replaced it', async () => {
  vi.mocked(DocFrameHandshake.prototype.receive).mockRestore();
  render(tree(<Host {...PREVIEW} />));
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
  answer(stale, page, PREVIEW.previewOrigin);
  expect(connected(posts)).toBe(0);
  answer(current, page, PREVIEW.previewOrigin);
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
  // A's correct answer and nonce, but sent from B's window: refused by both hosts.
  answer(challenges(toA)[0]!, b.contentWindow!, 'null', { boot: bootOf(a) });
  expect(connected(toA) + connected(toB)).toBe(0);
  answerServed(challenges(toA)[0]!, a);
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
    answer(challenge, outside.contentWindow!, origin, { boot: bootOf(served) });
  expect(toOutside.mock.calls).toHaveLength(0);
  expect(connected(toServed)).toBe(0);
  // The served page itself still connects, so the refusal above was not a dead host.
  answerServed(challenge, served);
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
  render(tree(<Host {...PREVIEW} />));
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

it('a new generation of the document closes the old port and connects the same page to the new one', async () => {
  vi.mocked(DocFrameHandshake.prototype.receive).mockRestore();
  const connection = ownDocChannelConnection(transport, new AbortController().signal);
  try {
    render(tree(<Host />));
    const element = frame();
    const posts = postsTo(element.contentWindow!);
    fireEvent.load(element);
    await waitFor(() => expect(challenges(posts)).toHaveLength(1));
    answerServed(challenges(posts)[0]!, element);
    expect(connected(posts)).toBe(1);
    const next = replay(true, [], 'frame-doc', 'b'.repeat(64));
    vi.mocked(transport.getCanvasChannel).mockResolvedValue(next);
    await snapshot(connection, next);
    await waitFor(() =>
      expect(challenges(posts).some((c) => c.generation === 'b'.repeat(64))).toBe(true)
    );
    expect(closed(started()[0])).toBe(true);
    // The same document, the same nonce: it was DorkOS's navigation all along.
    answerServed(
      challenges(posts).find((c) => c.generation === 'b'.repeat(64))!,
      element
    );
    expect(connected(posts)).toBe(2);
    expect(element.dataset.requiresReload).toBe('no');
  } finally {
    connection.retire();
  }
});

it('a revoked route tells the page so and closes its port; approving it again reconnects the page', async () => {
  vi.mocked(DocFrameHandshake.prototype.receive).mockRestore();
  const connection = ownDocChannelConnection(transport, new AbortController().signal);
  try {
    render(tree(<Host />));
    const element = frame();
    const posts = postsTo(element.contentWindow!);
    fireEvent.load(element);
    await waitFor(() => expect(challenges(posts)).toHaveLength(1));
    answerServed(challenges(posts)[0]!, element);
    const port = pagePorts(posts)[0]!;
    const told: Record<string, unknown>[] = [];
    port.onmessage = (event) => told.push(event.data);
    await snapshot(connection, replay(false));
    await waitFor(() => expect(told.some((m) => m.status === 'revoked')).toBe(true));
    expect(told.find((m) => m.kind === 'status')).toMatchObject({ status: 'revoked' });
    expect(closed(started()[0])).toBe(true);
    // Not a fault a reload fixes.
    expect(element.dataset.requiresReload).toBe('no');
    expect(challenges(posts)).toHaveLength(1);
    await snapshot(connection, replay(true));
    await waitFor(() => expect(challenges(posts)).toHaveLength(2));
    answerServed(challenges(posts)[1]!, element);
    expect(connected(posts)).toBe(2);
    port.close();
  } finally {
    connection.retire();
  }
});
