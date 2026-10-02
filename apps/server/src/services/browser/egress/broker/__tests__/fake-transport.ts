import { vi } from 'vitest';
import type {
  AcceptedRequest,
  BrokerTransport,
  OwnedListener,
  OwnedSocket,
  RequestBody,
} from '../transport.js';
import type { PinnedEndpoint } from '../../policy.js';
export class FakeBody implements RequestBody {
  data = new Set<(b: Uint8Array) => void>();
  end = new Set<() => void>();
  paused = true;
  onData(fn: (b: Uint8Array) => void) {
    this.data.add(fn);
    return () => this.data.delete(fn);
  }
  onEnd(fn: () => void) {
    this.end.add(fn);
    return () => this.end.delete(fn);
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  emit(text: string) {
    for (const fn of this.data) fn(Buffer.from(text));
  }
  finish() {
    for (const fn of this.end) fn();
  }
}
export class FakeSocket implements OwnedSocket {
  identity = {};
  observedClosed = false;
  writableBytes = 0;
  writes: string[] = [];
  paused = false;
  closeHeld = false;
  destroyThrows = false;
  backpressure = false;
  closes = new Set<() => void>();
  errors = new Set<() => void>();
  data = new Set<(b: Uint8Array) => void>();
  drains = new Set<() => void>();
  constructor(readonly peer?: PinnedEndpoint) {}
  onClose(fn: () => void) {
    this.closes.add(fn);
    if (this.observedClosed) fn();
    return () => this.closes.delete(fn);
  }
  onError(fn: () => void) {
    this.errors.add(fn);
    return () => this.errors.delete(fn);
  }
  onData(fn: (b: Uint8Array) => void) {
    this.data.add(fn);
    return () => this.data.delete(fn);
  }
  onDrain(fn: () => void) {
    this.drains.add(fn);
    return () => this.drains.delete(fn);
  }
  write(b: Uint8Array) {
    this.writes.push(Buffer.from(b).toString());
    return !this.backpressure;
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  end() {
    this.destroy();
  }
  destroy() {
    if (this.destroyThrows) throw Error('secret');
    if (!this.closeHeld) this.closed();
  }
  closed() {
    if (this.observedClosed) return;
    this.observedClosed = true;
    for (const fn of this.closes) fn();
  }
  emit(text: string) {
    for (const fn of this.data) fn(Buffer.from(text));
  }
  drain() {
    for (const fn of this.drains) fn();
  }
}
export function fakeTransport() {
  let options!: Parameters<BrokerTransport['listen']>[0];
  const closes = new Set<() => void>();
  const origins: FakeSocket[] = [];
  const responseBody = new FakeBody();
  let closeHeld = false;
  const listener: OwnedListener = {
    identity: {},
    address: '127.0.0.1',
    port: 43123,
    onClose: (fn) => {
      closes.add(fn);
      return () => closes.delete(fn);
    },
    close: () => {
      if (!closeHeld) for (const fn of closes) fn();
    },
  };
  const transport: BrokerTransport = {
    scope: 'fixture-only',
    listen: vi.fn(async (o) => {
      options = o;
      o.onListener(listener);
      return listener;
    }),
    dial: vi.fn(async (endpoint, o) => {
      const socket = new FakeSocket(endpoint);
      origins.push(socket);
      o.onSocket(socket);
      return { socket, outcome: 'connected' as const };
    }),
    exchange: vi.fn(async () => ({
      status: 200,
      headers: {},
      body: responseBody,
      head: new Uint8Array(),
    })),
  };
  return {
    transport,
    origins,
    responseBody,
    listener,
    holdListener: () => (closeHeld = true),
    closeListener: () => {
      for (const fn of closes) fn();
    },
    reserve: () => options.reserveSocket(),
    pipeline: (socket: FakeSocket) => options.onPipeline(socket),
    register: (slot: Parameters<typeof options.onSocket>[0], socket: FakeSocket) =>
      options.onSocket(slot, socket),
    accept(client: FakeSocket, request: Omit<AcceptedRequest, 'client'>) {
      const slot = options.reserveSocket();
      if (!slot) return false;
      const admitted = options.onSocket(slot, client);
      if (admitted) options.onRequest({ ...request, client });
      return admitted;
    },
  };
}
