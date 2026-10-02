import { describe, expect, it } from 'vitest';
import {
  inspectBridgeArgs,
  inspectBridgeImage,
  parseCanvasBridgeReport,
} from '../canvas-bridge-wire.js';
const batch = (args: unknown) => ({
  __dorkosDevtools: 'batch',
  bridgeGeneration: 'generation',
  seq: 1,
  console: [{ level: 'log', text: 'ok', timestamp: 1, args }],
  network: [],
});
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
describe('raw page report admission', () => {
  it('accepts bounded positive JSON args and PNG headers', () => {
    expect(parseCanvasBridgeReport(batch([{ nested: [1, true, null] }]))).not.toBeNull();
    expect(inspectBridgeImage(png)).toEqual({ width: 1, height: 1 });
  });
  it('rejects outcome-less captures and accepts explicit empty errors', () => {
    const reply = {
      __dorkosDevtools: 'capture-result',
      bridgeGeneration: 'generation',
      requestId: 'known',
    };
    expect(parseCanvasBridgeReport(reply)).toBeNull();
    expect(parseCanvasBridgeReport({ ...reply, error: '' })).not.toBeNull();
    expect(parseCanvasBridgeReport({ ...reply, dataUrl: png })).not.toBeNull();
  });
  it('rejects cloneable BigInt, cycles and exotic values before JSON refinements', () => {
    const cycle: unknown[] = [];
    cycle.push(cycle);
    for (const args of [[1n], cycle, [new Map()], [undefined], [NaN], [Infinity]]) {
      const cloned = structuredClone(args);
      expect(() => parseCanvasBridgeReport(batch(cloned))).not.toThrow();
      expect(parseCanvasBridgeReport(batch(cloned))).toBeNull();
    }
  });
  it('bounds depth, nodes, args and encoded args bytes', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 10; i++) deep = { deep };
    expect(inspectBridgeArgs(deep)).toBe(false);
    expect(inspectBridgeArgs(Array.from({ length: 2048 }, () => 1))).toBe(false);
    expect(parseCanvasBridgeReport(batch(Array.from({ length: 51 }, () => 1)))).toBeNull();
    expect(parseCanvasBridgeReport(batch(['x'.repeat(16384)]))).toBeNull();
  });
  it('rejects unsafe sequence and oversized arrays before retaining reports', () => {
    expect(parseCanvasBridgeReport({ ...batch([]), seq: Number.MAX_SAFE_INTEGER + 1 })).toBeNull();
    expect(parseCanvasBridgeReport({ ...batch([]), console: Array(501).fill({}) })).toBeNull();
    expect(parseCanvasBridgeReport({ ...batch([]), network: Array(201).fill({}) })).toBeNull();
  });
  it('does not accept page provenance as a host fact', () => {
    const parsed = parseCanvasBridgeReport({
      __dorkosDevtools: 'act-result',
      bridgeGeneration: 'g',
      requestId: 'r',
      ok: false,
      verified: true,
      hostOutcome: 'host',
      evidence: { source: 'host' },
    });
    expect(parsed).not.toHaveProperty('hostOutcome');
    expect(parsed).not.toHaveProperty('verified');
    expect(parsed).not.toHaveProperty('evidence');
  });
});
it('admits exact depth/node/args/JSON boundaries and rejects each next value', () => {
  let eight: unknown = 1;
  for (let i = 0; i < 8; i++) eight = { child: eight };
  expect(inspectBridgeArgs(eight)).toBe(true);
  expect(inspectBridgeArgs({ child: eight })).toBe(false);
  expect(inspectBridgeArgs(Array(2047).fill(1))).toBe(true);
  expect(inspectBridgeArgs(Array(2048).fill(1))).toBe(false);
  expect(parseCanvasBridgeReport(batch(Array(50).fill(1)))).not.toBeNull();
  expect(parseCanvasBridgeReport(batch(Array(51).fill(1)))).toBeNull();
  expect(parseCanvasBridgeReport(batch(['x'.repeat(16380)]))).not.toBeNull();
  expect(parseCanvasBridgeReport(batch(['x'.repeat(16381)]))).toBeNull();
  const console = Array(500).fill({
    level: 'log',
    text: 'x'.repeat(20000),
    stack: 'x'.repeat(20000),
    timestamp: 0,
  });
  const network = Array(200).fill({
    method: 'GET',
    url: 'x'.repeat(2048),
    status: 0,
    ok: false,
    durationMs: 0,
    timestamp: 0,
  });
  expect(
    parseCanvasBridgeReport({ ...batch([]), seq: Number.MAX_SAFE_INTEGER, console, network })
  ).not.toBeNull();
  expect(
    parseCanvasBridgeReport({ ...batch([]), console: [{ ...console[0], text: 'x'.repeat(20001) }] })
  ).toBeNull();
  expect(
    parseCanvasBridgeReport({ ...batch([]), network: [{ ...network[0], url: 'x'.repeat(2049) }] })
  ).toBeNull();
  expect(
    parseCanvasBridgeReport({ ...batch([]), network: [{ ...network[0], durationMs: -1 }] })
  ).toBeNull();
});
