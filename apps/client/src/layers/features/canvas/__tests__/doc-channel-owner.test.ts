/** @vitest-environment jsdom */
/** Proposed genuine owner controls. UNRUN; no fixture grants source authority. */
import type { SetStateAction } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils';
import { createDocChannelOwner } from '../model/doc-channel-owner';
import { emptyDocChannelView, type DocChannelView } from '../model/doc-channel-view';
const birth = {
  v: 1 as const,
  documentId: 'doc',
  physicalOpenedAt: '2026-10-02T00:00:00Z',
  channelCreatedAt: '2026-10-02T00:00:01Z',
  generation: 'a'.repeat(64),
};
const response = () => ({
  incarnation: birth,
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
});
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});
function owned() {
  const transport = createMockTransport();
  vi.mocked(transport.getCanvasChannel).mockResolvedValue(response());
  let view = emptyDocChannelView('doc', transport);
  const owner = createDocChannelOwner('doc', transport, (update) => {
    view = typeof update === 'function' ? update(view) : update;
  });
  stops.push(owner.dispose);
  return {
    transport,
    owner,
    get view() {
      return view;
    },
  };
}
async function complete(h: ReturnType<typeof owned>) {
  const run = h.owner.beginRun(),
    ticket = await run.readPage();
  expect(ticket).not.toBeNull();
  expect(run.consumePage(ticket!)).toEqual({ kind: 'frames', count: 0 });
  expect(run.finishPage(ticket!)).toBe('done');
  return { run, ticket: ticket! };
}
it('only genuine owned HTTP tickets can issue; structural or replayed tickets cannot advance', async () => {
  const h = owned(),
    run = h.owner.beginRun();
  expect(run.consumePage({})).toEqual({ kind: 'done' });
  expect(h.view.binding).toBeUndefined();
  const ticket = await run.readPage();
  expect(run.consumePage(ticket!)).toEqual({ kind: 'frames', count: 0 });
  expect(run.consumePage(ticket!)).toEqual({ kind: 'done' });
  expect(run.finishPage(ticket!)).toBe('done');
  expect(h.view.binding?.verified).toBe(true);
});
it('a held OLD HTTP ticket cannot consume or qualify the newer run', async () => {
  const h = owned();
  let release!: (value: ReturnType<typeof response>) => void;
  vi.mocked(h.transport.getCanvasChannel).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const old = h.owner.beginRun(),
    held = old.readPage();
  const newer = await complete(h),
    binding = h.view.binding;
  release({ ...response(), highWatermark: 900 });
  expect(await held).toBeNull();
  expect(old.consumePage(newer.ticket)).toEqual({ kind: 'done' });
  expect(old.finishPage(newer.ticket)).toBe('done');
  old.failed();
  old.end();
  expect(newer.run.current()).toBe(true);
  expect(h.view.binding?.owner).toBe(binding?.owner);
  expect(h.view.snapshot?.highWatermark).toBe(0);
});
it('disposed read and deferred rendering cannot install an owned record', async () => {
  const h = owned();
  let release!: (value: ReturnType<typeof response>) => void;
  vi.mocked(h.transport.getCanvasChannel).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const run = h.owner.beginRun(),
    held = run.readPage();
  h.owner.dispose();
  release(response());
  expect(await held).toBeNull();
  expect(h.view.binding).toBeUndefined();
  expect(run.takePending()).toBeNull();
});
it('old page cannot complete a target until each privately indexed frame has been dispatched', async () => {
  const h = owned();
  const frame = {
    type: 'canvas_event' as const,
    documentId: 'doc',
    scope: 'session:x',
    incarnation: birth,
    docSeq: 1,
    event: {
      id: '00000000-0000-4000-8000-000000000001',
      type: 'save',
      payload: {},
      direction: 'upstream' as const,
      receivedAt: '2026-10-02T00:00:02Z',
    },
  };
  vi.mocked(h.transport.getCanvasChannel).mockResolvedValue({
    ...response(),
    highWatermark: 1,
    events: [frame],
  });
  const run = h.owner.beginRun(),
    ticket = await run.readPage();
  expect(run.consumePage(ticket!)).toEqual({ kind: 'frames', count: 1 });
  expect(run.finishPage(ticket!)).toBe('done');
  expect(run.advancePageFrame(ticket!, 5)).toBe(false);
  expect(h.view.events).toEqual([]);
  expect(run.advancePageFrame(ticket!, 0)).toBe(true);
  expect(run.advancePageFrame(ticket!, 0)).toBe(false);
  expect(run.finishPage(ticket!)).toBe('done');
  expect(h.view.events.map((value) => value.docSeq)).toEqual([1]);
});

it.each(['normal-end', 'newer-run'] as const)(
  'deferred genuine HTTP view delivery is qualified by projection revision (%s)',
  async (kind) => {
    const transport = createMockTransport();
    vi.mocked(transport.getCanvasChannel).mockResolvedValue(response());
    let view = emptyDocChannelView('doc', transport);
    const updates: SetStateAction<DocChannelView>[] = [];
    const owner = createDocChannelOwner('doc', transport, (update) => {
      updates.push(update);
    });
    stops.push(owner.dispose);
    const run = owner.beginRun(),
      ticket = await run.readPage();
    expect(run.consumePage(ticket!)).toEqual({ kind: 'frames', count: 0 });
    expect(run.finishPage(ticket!)).toBe('done');
    run.end();
    if (kind === 'newer-run') owner.beginRun();
    for (const update of updates) view = typeof update === 'function' ? update(view) : update;
    if (kind === 'normal-end') expect(view.binding?.verified).toBe(true);
    else expect(view.binding).toBeUndefined();
    expect(run.current()).toBe(false);
  }
);
