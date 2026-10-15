import { requireOriginalWorkerEntry } from '../server.js';
import { createHook } from 'node:async_hooks';
import { writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as timeoutScheduler, setInterval as intervalScheduler } from 'node:timers';
/** Bounded DATA observer; only the original child-entry key can install it. */
export function createOriginalWorkerResourceData(entryKey: object) {
  requireOriginalWorkerEntry(entryKey);
  type TimeoutCapture = {
    mode: 'timeout-caller' | 'interval-caller' | 'hook-fallback';
    rawFrameCount: number;
    unparsed: number;
    outsideScope: number;
    unsafe: number;
    scaffolding: number;
    truncated: boolean;
  };
  const timeoutOrigins = new Map<
    number,
    { resource: WeakRef<object>; frames: string[]; capture: TimeoutCapture }
  >();
  let timeoutOriginOverflow = false;
  const scrubTimeoutFrames = (stack: string | undefined, mode: TimeoutCapture['mode']) => {
    const lines = (stack ?? '').split('\n').slice(1);
    const capture: TimeoutCapture = {
      mode,
      rawFrameCount: Math.min(lines.length, 64),
      unparsed: 0,
      outsideScope: 0,
      unsafe: 0,
      scaffolding: 0,
      truncated: lines.length > 64,
    };
    const frames: string[] = [];
    const root = fileURLToPath(new URL('../../../../..', import.meta.url)).replace(/\/+$/, '');
    for (const line of lines.slice(0, 64)) {
      const match = line.match(/(?:\(|\s)((?:file:\/\/)?[^()\s]+):(\d+):(\d+)\)?$/);
      if (!match) {
        capture.unparsed++;
        continue;
      }
      const location = match[1].replace(/^file:\/\//, '');
      let tag: string;
      if (location.startsWith('node:')) tag = location;
      else if (location.startsWith(root + '/') && !location.includes('/node_modules/'))
        tag = location.slice(root.length + 1);
      else if (location.includes('/node_modules/'))
        tag = 'dependency/' + location.slice(location.lastIndexOf('/node_modules/') + 14);
      else {
        capture.outsideScope++;
        continue;
      }
      const frame = `${tag}:${match[2]}:${match[3]}`;
      if (!/^[A-Za-z0-9_./:@+-]{1,160}$/.test(frame) || frame.includes('..')) {
        capture.unsafe++;
        continue;
      }
      if (
        frame.startsWith('node:internal/async_hooks:') ||
        frame.startsWith('node:internal/timers:') ||
        frame.startsWith('node:timers:') ||
        (mode === 'hook-fallback' &&
          frame.startsWith('apps/e2e/fixtures/doc-channel-consumer/server.ts:'))
      ) {
        capture.scaffolding++;
        continue;
      }
      if (frames.length < 6) frames.push(frame);
    }
    return { frames, capture };
  };
  function captureTimeoutOrigin() {
    for (const [mode, scheduler] of [
      ['timeout-caller', timeoutScheduler],
      ['interval-caller', intervalScheduler],
    ] as const) {
      const target: { stack?: string } = {};
      Error.captureStackTrace(target, scheduler);
      const origin = scrubTimeoutFrames(target.stack, mode);
      if (origin.frames.length > 0) return origin;
    }
    const target: { stack?: string } = {};
    Error.captureStackTrace(target, captureTimeoutOrigin);
    return scrubTimeoutFrames(target.stack, 'hook-fallback');
  }
  const timeoutOriginHook = createHook({
    init(id, type, _trigger, resource: object) {
      if (type !== 'Timeout') return;
      try {
        if (timeoutOrigins.size >= 64) {
          timeoutOriginOverflow = true;
          return;
        }
        timeoutOrigins.set(id, { resource: new WeakRef(resource), ...captureTimeoutOrigin() });
      } catch {
        timeoutOriginOverflow = true;
      }
    },
    destroy(id) {
      timeoutOrigins.delete(id);
    },
  });
  timeoutOriginHook.enable();
  const currentTimeoutOrigins = () => {
    const entries: string[][] = [];
    const captures: TimeoutCapture[] = [];
    for (const item of timeoutOrigins.values()) {
      try {
        const resource = item.resource.deref();
        if (!resource || typeof (resource as { hasRef?: unknown }).hasRef !== 'function') continue;
        if (!(resource as { hasRef(): boolean }).hasRef()) continue;
        if (entries.length < 4) {
          entries.push(item.frames);
          captures.push(item.capture);
        }
      } catch {
        timeoutOriginOverflow = true;
      }
    }
    return {
      trackedCount: timeoutOrigins.size,
      overflow: timeoutOriginOverflow,
      moduleLevelImportBlindspot: true,
      entries,
      captures,
    };
  };
  let postCloseResourceSequence = 0;
  const postCloseResources = (
    phase: 'closed-before-disconnect' | 'closed-after-disconnect' | 'before-exit'
  ) => {
    if (postCloseResourceSequence >= 3) return;
    try {
      const resources = process.getActiveResourcesInfo();
      const counts: Record<string, number> = {};
      for (const kind of resources.slice(0, 64)) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(kind)) continue;
        counts[kind] = (counts[kind] ?? 0) + 1;
      }
      const data = JSON.stringify({
        kind: 'ORIGINAL_MCP_POST_CLOSE_RESOURCES',
        sequence: ++postCloseResourceSequence,
        phase,
        at: Date.now(),
        resourceCount: Math.min(resources.length, 65),
        truncated: resources.length > 64,
        counts,
        timeoutOrigins: currentTimeoutOrigins(),
      });
      if (Buffer.byteLength(data + '\n', 'utf8') <= 4096) writeSync(2, data + '\n');
    } catch {
      // Resource DATA cannot change natural exit, retirement or the first cause.
    }
  };
  return { postCloseResources };
}
