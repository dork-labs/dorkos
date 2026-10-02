/** Page-reported DevTools wire data. Generations correlate lifetimes; they authenticate no script. */
import { z } from 'zod';
import {
  DevtoolsConsoleEntrySchema,
  DevtoolsNetworkEntrySchema,
  DevtoolsActionResultSchema,
} from './schemas.js';

/** Host admission and retention bounds, independent of the page's own limits. */
export const CANVAS_BRIDGE_LIMITS = {
  pending: 64,
  queueBytes: 1_048_576,
  batchMs: 300,
  frames: 62,
  imageChars: 900_000,
  imageEdge: 1568,
  resourceErrors: 10_000,
} as const;
/** Attribution attached by the host, never accepted from a page report. */
export const PAGE_REPORTED_EVIDENCE = { source: 'page-reported', verified: false } as const;
const id = z.string().min(1).max(128);
const base = { bridgeGeneration: id };
const screenshot = z.object({
  ...base,
  __dorkosDevtools: z.literal('capture-result'),
  requestId: id,
  dataUrl: z.string().max(900_000).optional(),
  error: z.string().max(2048).optional(),
});
const action = DevtoolsActionResultSchema.omit({ hostOutcome: true }).extend({
  ...base,
  __dorkosDevtools: z.literal('act-result'),
  dataUrl: z.string().max(900_000).optional(),
});
const network = DevtoolsNetworkEntrySchema.extend({
  status: z.number().int().min(0).max(599),
  durationMs: z.number().min(0),
  responseSize: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  timestamp: z.number().min(0),
});
const consoleEntry = DevtoolsConsoleEntrySchema.refine((entry) => entry.timestamp >= 0);
const report = z.discriminatedUnion('__dorkosDevtools', [
  z.object({
    __dorkosDevtools: z.literal('hello'),
    pageInstanceId: id,
    bridgeVersion: z.literal(2),
  }),
  z.object({ ...base, __dorkosDevtools: z.literal('ready'), pageInstanceId: id }),
  z.object({ ...base, __dorkosDevtools: z.literal('navigated') }),
  z.object({ ...base, __dorkosDevtools: z.literal('resource-error') }),
  z.object({
    ...base,
    __dorkosDevtools: z.literal('batch'),
    seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    console: z.array(consoleEntry).max(500),
    network: z.array(network).max(200),
  }),
  screenshot,
  action,
]);
/** Validated report; its contents remain untrusted page evidence. */
export type CanvasBridgeReport = z.infer<typeof report>;

/** Bound raw args before JSON/Zod recursion. Never evaluates accessors or normalizes exotic objects. */
export function inspectBridgeArgs(value: unknown): boolean {
  const ancestors = new Set<object>();
  let nodes = 0,
    chars = 0;
  const add = (count: number): boolean => (chars += count) <= 16384;
  function stringSize(text: string): boolean {
    if (!add(2)) return false;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (
        code >= 0xd800 &&
        code <= 0xdbff &&
        i + 1 < text.length &&
        text.charCodeAt(i + 1) >= 0xdc00 &&
        text.charCodeAt(i + 1) <= 0xdfff
      ) {
        if (!add(2)) return false;
        i++;
        continue;
      }
      const count =
        code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)
          ? 2
          : code < 32 || (code >= 0xd800 && code <= 0xdfff)
            ? 6
            : 1;
      if (!add(count)) return false;
    }
    return true;
  }
  function visit(current: unknown, depth: number): boolean {
    if (++nodes > 2048 || depth > 8) return false;
    if (current === null) return add(4);
    if (typeof current === 'boolean') return add(current ? 4 : 5);
    if (typeof current === 'string') return stringSize(current);
    if (typeof current === 'number') return Number.isFinite(current) && add(String(current).length);
    if (typeof current !== 'object' || ancestors.has(current)) return false;
    const proto = Object.getPrototypeOf(current);
    if (proto !== Object.prototype && proto !== null && proto !== Array.prototype) return false;
    const array = Array.isArray(current);
    if (array && current.length > 2048) return false;
    // Symbol properties cannot arrive through structured clone; reject direct callers too.
    if (Object.getOwnPropertySymbols(current).length || !add(2)) return false;
    ancestors.add(current);
    let keys = 0;
    for (const key in current) {
      if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
      if (++keys > 2048 || (array && (!/^\d+$/.test(key) || Number(key) >= current.length)))
        return false;
      const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
      if (
        ['__proto__', 'constructor', 'prototype'].includes(key) ||
        !('value' in descriptor) ||
        !descriptor.enumerable
      )
        return false;
      if (keys > 1 && !add(1)) return false;
      if (!array && (!stringSize(key) || !add(1))) return false;
      if (!visit(descriptor.value, depth + 1)) return false;
    }
    ancestors.delete(current);
    return !array || keys === current.length;
  }
  try {
    return visit(value, 0);
  } catch {
    return false;
  }
}

/** Validate structured-clone input before spreading arrays, stringifying args or retaining images. */
export function parseCanvasBridgeReport(value: unknown): CanvasBridgeReport | null {
  try {
    if (!value || typeof value !== 'object') return null;
    const d = value as Record<string, unknown>;
    // Malformed replies must leave the pending request available for a valid outcome.
    if (d.__dorkosDevtools === 'capture-result' && d.dataUrl === undefined && d.error === undefined)
      return null;
    if (d.__dorkosDevtools === 'batch') {
      if (
        !Array.isArray(d.console) ||
        d.console.length > 500 ||
        !Array.isArray(d.network) ||
        d.network.length > 200
      )
        return null;
      for (const entry of d.console) {
        if (!entry || typeof entry !== 'object') return null;
        const args = (entry as Record<string, unknown>).args;
        if (
          args !== undefined &&
          (!Array.isArray(args) || args.length > 50 || !inspectBridgeArgs(args))
        )
          return null;
      }
    }
    const parsed = report.safeParse(value);
    if (!parsed.success) return null;
    const result = parsed.data;
    if ('dataUrl' in result && result.dataUrl !== undefined && !inspectBridgeImage(result.dataUrl))
      return null;
    return result;
  } catch {
    return null;
  }
}

/** Inspect PNG headers before browser decoding. Compressed size is not a decoded-memory limit. */
export function inspectBridgeImage(dataUrl: string): { width: number; height: number } | null {
  if (dataUrl.length > 900_000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl))
    return null;
  try {
    const bytes = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
    if (
      bytes.length < 24 ||
      bytes.slice(0, 8) !== '\x89PNG\r\n\x1a\n' ||
      bytes.slice(12, 16) !== 'IHDR'
    )
      return null;
    const u32 = (at: number) =>
      bytes.charCodeAt(at) * 2 ** 24 +
      (bytes.charCodeAt(at + 1) << 16) +
      (bytes.charCodeAt(at + 2) << 8) +
      bytes.charCodeAt(at + 3);
    const width = u32(16),
      height = u32(20);
    return width > 0 && height > 0 && width <= 1568 && height <= 1568 ? { width, height } : null;
  } catch {
    return null;
  }
}
