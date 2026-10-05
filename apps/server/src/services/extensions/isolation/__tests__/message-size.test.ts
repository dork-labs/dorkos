/**
 * The host's copy-free message size bound (DOR-2686 review finding): it
 * agrees in scale with the real serialized size below the cap, stops early
 * above it, and fails closed on what it cannot bound — without ever calling
 * v8.serialize (the cost the cap exists to avoid).
 */
import { describe, expect, it, vi } from 'vitest';
import v8 from 'node:v8';
import { boundedMessageSize, MAX_DEPTH, MAX_NODES } from '../message-size.js';

const CAP = 4 * 1024 * 1024;

describe('boundedMessageSize', () => {
  // Purpose: small messages measure at least their real serialized size (an
  // upper estimate never under-counts what the cap is about).
  it('never under-counts a normal message', () => {
    const samples = [
      { type: 'pong', n: 3 },
      { type: 'run-stdin', rid: 1, chunk: new Uint8Array(100_000) },
      { type: 'probe-result', id: 1, ok: true, value: { a: 'x'.repeat(5000), list: [1, 2, 3] } },
      new Map([['k', new Set(['v'])]]),
    ];
    for (const sample of samples) {
      expect(boundedMessageSize(sample, CAP)).toBeGreaterThanOrEqual(
        v8.serialize(sample).byteLength
      );
    }
  });

  // Purpose: anything over the cap is reported over it — one big buffer, many
  // small parts, or a long string.
  it('reports over the cap', () => {
    expect(boundedMessageSize({ chunk: new Uint8Array(CAP + 1) }, CAP)).toBeGreaterThan(CAP);
    expect(boundedMessageSize({ s: 'x'.repeat(CAP) }, CAP)).toBeGreaterThan(CAP);
    expect(
      boundedMessageSize(
        Array.from({ length: 50_000 }, () => new Uint8Array(100)),
        CAP
      )
    ).toBeGreaterThan(CAP);
  });

  // Purpose: fail closed on what it cannot bound: too many parts, too deep;
  // a cycle is measured once, not forever.
  it('fails closed on unbounded shapes and survives cycles', () => {
    expect(boundedMessageSize(new Array(MAX_NODES + 10).fill(0), CAP)).toBeGreaterThan(CAP);
    let deep: unknown = 1;
    for (let i = 0; i < MAX_DEPTH + 5; i++) deep = { deep };
    expect(boundedMessageSize(deep, CAP)).toBeGreaterThan(CAP);
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(boundedMessageSize(cyclic, CAP)).toBeLessThan(1_000);
  });

  // Purpose: it measures without copying — v8.serialize is never called.
  it('does not serialize', () => {
    const spy = vi.spyOn(v8, 'serialize');
    boundedMessageSize({ chunk: new Uint8Array(CAP * 2) }, CAP);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
