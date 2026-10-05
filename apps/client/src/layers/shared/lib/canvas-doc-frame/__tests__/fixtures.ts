import { vi } from 'vitest';
import { FrameLifetimeController } from '../frame-lifetime';
import { createBoundDocPort, type DocTransportPorts } from '../bound-doc-port';
import type { DocQueueScheduler } from '../doc-queue';
export const birth = {
  v: 1 as const,
  documentId: 'doc',
  physicalOpenedAt: '2026-10-02T00:00:00Z',
  channelCreatedAt: '2026-10-02T00:00:01Z',
  generation: 'a'.repeat(64),
};
export const id = (n = 1) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const envelope = (n = 1, payload: unknown = { x: 1 }) => ({
  v: 1,
  id: id(n),
  type: 'save',
  payload,
});
export const receipt = (n = 1) => ({
  receipt: { id: id(n), status: 'recorded' as const, docSeq: n },
  deliveries: [],
});
export function fixture(overrides: Partial<DocTransportPorts> = {}, origin = 'null') {
  const controller = new FrameLifetimeController(),
    owner = {},
    frame = { postMessage: vi.fn() } as unknown as Window;
  const context = {
    frame,
    documentId: 'doc',
    resolvedSource: '/doc',
    logicalUrl: '/doc',
    reloadKey: '1',
    sessionId: 'session',
    eligibility: origin === 'null' ? ('served-document' as const) : ('preview-listener' as const),
    exactOrigin: origin,
    transportOwner: owner,
    publisherEpoch: 1,
  };
  const initial = controller.observeHostContext(context)!;
  const loaded = controller.observeLoaded(initial)!;
  const binding = controller.bindDoc(loaded, birth, 'session');
  const ports: DocTransportPorts = {
    captureOriginal: (request) =>
      Object.freeze({
        ...request,
        submit: (signal: AbortSignal) =>
          ports.submit(request, { expectedGeneration: birth.generation }, signal),
        inspect: (signal: AbortSignal) =>
          ports.inspect(request.id, { expectedGeneration: birth.generation }, signal),
      }),
    owner,
    publisherEpoch: 1,
    isCurrentOwner: () => true,
    submit: vi.fn(async () => ({ kind: 'accepted' as const, receipt: receipt() })),
    inspect: vi.fn(async () => ({ kind: 'absent' as const })),
    ...overrides,
  };
  return {
    controller,
    owner,
    frame,
    context,
    initial,
    loaded,
    binding,
    ports,
    bound: createBoundDocPort(controller, binding, ports),
  };
}
export function clock() {
  let next = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const scheduler: DocQueueScheduler = {
    schedule(callback, delay) {
      const id = ++next;
      timers.set(id, { callback, delay });
      return id;
    },
    cancel(id) {
      timers.delete(id as number);
    },
    random: () => 0.5,
  };
  return {
    scheduler,
    timers,
    fire(delay?: number) {
      const found = [...timers].find(([, timer]) => delay === undefined || timer.delay === delay);
      if (!found) throw new Error('Timer missing');
      timers.delete(found[0]);
      found[1].callback();
    },
  };
}
export async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
export const replay = (highWatermark = 100, stateRev = 100) => ({
  events: [],
  state: { text: 'state' },
  stateRev,
  highWatermark,
  retentionFloor: 1,
  receiptRetentionFloor: 1,
  resetRequired: false,
  health: { status: 'ready', reasons: [] },
  receipts: [],
});
