/** @vitest-environment jsdom */
/** Proposed private replay membership controls. UNRUN. */
import { afterEach, expect, it, vi } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils';
import { ownDocChannelConnection } from '@/layers/shared/lib/transport/doc-channel-ownership';
import { createDocChannelOwner } from '../model/doc-channel-owner';
import { emptyDocChannelView } from '../model/doc-channel-view';
import { readOwnedCursor, readOwnedRunCapture } from '../model/doc-channel-owner-replay';
const birth = {
  v: 1 as const,
  documentId: 'doc',
  physicalOpenedAt: '2026-10-02T00:00:00Z',
  channelCreatedAt: '2026-10-02T00:00:01Z',
  generation: 'a'.repeat(64),
};
const replacement = {
  ...birth,
  physicalOpenedAt: '2026-10-02T00:01:00Z',
  generation: 'b'.repeat(64),
};
const frame = (docSeq: number, incarnation = birth) => ({
  type: 'canvas_event' as const,
  documentId: 'doc',
  scope: 'session:x',
  incarnation,
  docSeq,
  event: {
    id: `00000000-0000-4000-8000-${String(docSeq).padStart(12, '0')}`,
    type: 'save',
    payload: {},
    direction: 'upstream' as const,
    receivedAt: '2026-10-02T00:00:02Z',
  },
});
const replay = (
  highWatermark = 0,
  events: ReturnType<typeof frame>[] = [],
  incarnation = birth
) => ({
  incarnation,
  events,
  state: {},
  stateRev: 0,
  highWatermark,
  retentionFloor: 1,
  receiptRetentionFloor: 1,
  resetRequired: false,
  receipts: [],
  health: { status: 'ready' as const, reasons: [] },
  routing: { enabled: true, destinationLabel: 'Tasks', approvedEventTypes: ['save'] },
});
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
});
function owned() {
  const transport = createMockTransport();
  vi.mocked(transport.getCanvasChannel).mockResolvedValue(replay());
  let view = emptyDocChannelView('doc', transport);
  const owner = createDocChannelOwner('doc', transport, (update) => {
    view = typeof update === 'function' ? update(view) : update;
  });
  cleanups.push(owner.dispose);
  const producer = ownDocChannelConnection(transport, new AbortController().signal);
  cleanups.push(producer.retire);
  const recover = vi.fn();
  owner.start(recover);
  return {
    transport,
    owner,
    producer,
    recover,
    get view() {
      return view;
    },
  };
}
async function page(h: ReturnType<typeof owned>) {
  const run = h.owner.beginRun(),
    ticket = await run.readPage();
  expect(ticket).not.toBeNull();
  const result = run.consumePage(ticket!);
  if (result.kind === 'frames')
    for (let i = 0; i < result.count; i++) expect(run.advancePageFrame(ticket!, i)).toBe(true);
  expect(run.finishPage(ticket!)).toBe('done');
  return { run, ticket: ticket! };
}
it('hands the same unissued run its own subject before the first observable projection', async () => {
  const h = owned();
  const { run, ticket } = await page(h);
  expect(run.current()).toBe(true);
  expect(h.view.binding?.verified).toBe(true);
  expect(run.consumePage(ticket)).toEqual({ kind: 'done' });
  expect(readOwnedRunCapture({}, {})).toBeUndefined();
  expect(() => readOwnedCursor({})).toThrow();
});
it.each([200, 201])(
  'keeps a scalar target across %i genuine gap frames and payload eviction',
  async (count) => {
    const h = owned();
    await page(h);
    const old = h.owner.beginRun();
    for (let n = 3; n < count + 3; n++) h.producer.publish(frame(n));
    const ticket = await old.readPage();
    const result = old.consumePage(ticket!);
    expect(result).toEqual({ kind: 'frames', count: 0 });
    old.finishPage(ticket!);
    expect(old.beginFinalization()).toBe('drain');
    expect(old.finishFinalization()).toBe('restart');
    old.end();
    expect(h.recover).toHaveBeenCalled();
    vi.mocked(h.transport.getCanvasChannel).mockImplementation(async (_doc, options) =>
      replay(
        count + 2,
        Array.from({ length: Math.min(200, count + 2 - (options?.since ?? 0)) }, (_, i) =>
          frame((options?.since ?? 0) + i + 1)
        )
      )
    );
    const run = h.owner.beginRun();
    for (;;) {
      const next = await run.readPage();
      const consumed = run.consumePage(next!);
      expect(consumed.kind).toBe('frames');
      if (consumed.kind !== 'frames') break;
      for (let i = 0; i < consumed.count; i++) expect(run.advancePageFrame(next!, i)).toBe(true);
      if (run.finishPage(next!) === 'done') break;
    }
    expect(run.beginFinalization()).toBe('drain');
    for (;;) {
      const pending = run.takePending();
      if (!pending) break;
      expect(run.advancePending(pending)).toBe(true);
    }
    expect(run.finishFinalization()).toBe('stop');
    expect(h.view.events.at(-1)?.docSeq).toBe(count + 2);
    expect(h.view.binding?.verified).toBe(true);
  }
);
it('quarantines a genuine replacement noticed before the first owned HTTP record', async () => {
  const h = owned();
  let release!: (value: ReturnType<typeof replay>) => void;
  vi.mocked(h.transport.getCanvasChannel).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const old = h.owner.beginRun(),
    held = old.readPage();
  h.producer.publish(frame(1, replacement));
  expect(h.view.events).toEqual([]);
  expect(h.view.binding).toBeUndefined();
  release(replay(2, [frame(1), frame(2)]));
  const rejectedPage = await held;
  expect(rejectedPage).not.toBeNull();
  expect(old.consumePage(rejectedPage!)).toEqual({ kind: 'done' });
  expect(old.current()).toBe(false);
  expect(h.view.binding).toBeUndefined();
  expect(h.view.events).toEqual([]);
  vi.mocked(h.transport.getCanvasChannel).mockResolvedValue(
    replay(1, [frame(1, replacement)], replacement)
  );
  const next = await page(h);
  old.end();
  old.failed();
  expect(next.run.current()).toBe(true);
  expect(h.view.snapshot?.incarnation).toEqual(replacement);
  expect(h.view.events).toEqual([frame(1, replacement)]);
  expect(h.transport.getCanvasChannel).toHaveBeenLastCalledWith('doc', { since: 0, limit: 200 });
});
it('drops duplicate owned stream frames without dispatching a duplicate event', async () => {
  const h = owned();
  await page(h);
  h.producer.publish(frame(1));
  h.producer.publish(frame(1));
  expect(h.view.events.map((event) => event.docSeq)).toEqual([1]);
});
