/**
 * The preload bridge's heartbeat, which nothing tested until now (DOR-2046).
 *
 * `reportAlive` is the renderer half of renderer supervision, and its payload
 * is what tells the shell WHICH document is reporting. The main process
 * deliberately accepts a report carrying no usable `timeOrigin` — the safe
 * failure is the behaviour that shipped before the identity guard existed
 * (DOR-2034) — and there is a test in `renderer-health/__tests__/index.test.ts`
 * pinning that permissiveness. So a preload regression that stopped sending
 * the payload would silently restore the very defect the guard was added for,
 * with nothing anywhere going red. This is the test that goes red instead.
 *
 * The `electron` double is local rather than the main process's shared
 * `__tests__/electron-mock.ts`: a preload runs in a different surface and sees
 * a different module — `contextBridge` and `ipcRenderer`, neither of which
 * exists in the main process.
 *
 * @module preload/__tests__/index
 */
import { describe, it, expect, vi } from 'vitest';
import { contextBridge, ipcRenderer } from 'electron';
import type { HeartbeatReport } from '../../main/renderer-health';

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn<(apiKey: string, api: unknown) => void>() },
  ipcRenderer: {
    send: vi.fn<(channel: string, ...args: unknown[]) => void>(),
    sendSync: vi.fn<(channel: string, ...args: unknown[]) => unknown>(),
    invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
    on: vi.fn<(channel: string, listener: (...args: unknown[]) => void) => void>(),
    removeListener: vi.fn<(channel: string, listener: (...args: unknown[]) => void) => void>(),
  },
}));

// Importing the preload IS running it: `exposeInMainWorld` is called at module
// scope, exactly as it is in a real renderer's privileged context.
import '../index';

/** Channel the renderer reports itself alive on (mirrors `ALIVE_CHANNEL`). */
const ALIVE_CHANNEL = 'renderer:alive';

/** The slice of the exposed bridge this file exercises. */
interface HeartbeatBridge {
  reportAlive: () => void;
}

/**
 * The API the preload handed `contextBridge`, as the renderer would see it on
 * `window.electronAPI`.
 *
 * @returns The exposed bridge.
 */
function exposedBridge(): HeartbeatBridge {
  const call = vi
    .mocked(contextBridge.exposeInMainWorld)
    .mock.calls.find(([apiKey]) => apiKey === 'electronAPI');
  if (!call) throw new Error('The preload exposed nothing as `electronAPI`.');
  return call[1] as HeartbeatBridge;
}

/**
 * The payload of the single heartbeat sent so far.
 *
 * @returns Whatever went out on the alive channel, unexamined.
 */
function sentHeartbeat(): unknown {
  const calls = vi
    .mocked(ipcRenderer.send)
    .mock.calls.filter(([channel]) => channel === ALIVE_CHANNEL);
  expect(calls).toHaveLength(1);
  return calls[0][1];
}

describe('the preload heartbeat', () => {
  it('sends a finite timeOrigin on the alive channel', () => {
    exposedBridge().reportAlive();

    const payload = sentHeartbeat() as Partial<HeartbeatReport> | undefined;
    expect(payload, 'the heartbeat went out with no payload at all').toBeDefined();
    expect(typeof payload?.timeOrigin).toBe('number');
    expect(Number.isFinite(payload?.timeOrigin)).toBe(true);
    // This page's own `performance.timeOrigin`, which is what makes the report
    // identify the document that sent it rather than merely the window.
    expect(payload?.timeOrigin).toBe(performance.timeOrigin);
  });
});
