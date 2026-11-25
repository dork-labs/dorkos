import { vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  attachRendererSupervisor,
  HEARTBEAT_DEADLINE_MS,
  pendingRecovery,
  resetRendererSupervisor,
  setupRendererRecovery,
  type RendererHealth,
} from '../index';
import { app, BrowserWindow, ipcMain, resetElectronMock } from '../../__tests__/electron-mock';
import type { MockBrowserWindow } from '../../__tests__/electron-mock';
import { resetLogMock } from '../../__tests__/electron-log-mock';

/**
 * The renderer supervisor, driven through the events Electron would raise.
 *
 * Real files on a throwaway userData dir rather than a mocked `node:fs`: the
 * counter's whole point is that it survives a relaunch, so the write and the
 * read have to be the same round trip. The GPU cache directories are real
 * directories for the same reason — "did rung 3 actually delete them" is not a
 * question a mock can answer.
 *
 * Every suite using this declares its own `vi.mock('electron', ...)` and
 * `vi.mock('electron-log', ...)`, pointing at the shared doubles.
 */

/** Ceiling on {@link settle}'s wait, in rungs: a backstop so a stuck rung fails instead of hanging. */
const SETTLE_ROUNDS = 4;

/** The per-test state {@link useSupervisor} sets up. */
export const ctx: { base: string; userData: string; win: MockBrowserWindow } = {
  base: '',
  userData: '',
  win: undefined as unknown as MockBrowserWindow,
};

/** The renderer entry the supervisor puts back on screen from the fallback page. */
export const OPTIONS = { getRendererUrl: () => 'http://localhost:4242', role: 'primary' as const };

/** What the health file holds right now. */
export function health(): RendererHealth {
  return JSON.parse(
    readFileSync(join(ctx.userData, 'renderer-health.json'), 'utf-8')
  ) as RendererHealth;
}

/** Pretend a previous launch (or a previous failure) left this behind. */
export function seedHealth(contents: string): void {
  mkdirSync(ctx.userData, { recursive: true });
  writeFileSync(join(ctx.userData, 'renderer-health.json'), contents);
}

/** Invoke the `ipcMain.on` listener registered for `channel`. */
export function send(channel: string, event: unknown, payload?: unknown): void {
  const call = ipcMain.on.mock.calls.find(([registered]) => registered === channel);
  if (!call) throw new Error(`Nothing is listening on ${channel}.`);
  (call[1] as (event: unknown, payload?: unknown) => void)(event, payload);
}

/** Invoke the `ipcMain.handle` listener registered for `channel`. */
export async function invoke(channel: string, event: unknown): Promise<void> {
  const call = ipcMain.handle.mock.calls.find(([registered]) => registered === channel);
  if (!call) throw new Error(`Nothing handles ${channel}.`);
  await (call[1] as (event: unknown) => Promise<void>)(event);
}

/** An IPC event shaped like one from the supervised window. */
export function fromWindow(): { sender: MockBrowserWindow['webContents'] } {
  return { sender: ctx.win.webContents };
}

/**
 * What the preload sends with a heartbeat: the reporting page's
 * `performance.timeOrigin`, which is when that document came into existence.
 */
export function reportedBy(documentCreatedAt: number): { timeOrigin: number } {
  return { timeOrigin: documentCreatedAt };
}

/** What Electron hands a `did-start-navigation` listener. */
export interface NavigationDetails {
  isMainFrame: boolean;
  isSameDocument: boolean;
  url: string;
}

/**
 * Raise both of the events Electron raises for a navigation that starts from rest.
 *
 * Both events, because the difference between them is the whole defect:
 * `did-start-loading` fires on the host webContents for a sub-frame load and
 * for a same-document navigation too (measured on Electron 41.10.7), and only
 * `did-start-navigation` says which of the three this was.
 */
export async function navigate(details: NavigationDetails): Promise<void> {
  await ctx.win.webContents.emit('did-start-loading');
  await ctx.win.webContents.emit('did-start-navigation', details);
}

/** The one navigation that really does replace the page being waited on. */
export async function startMainFrameLoad(): Promise<void> {
  await navigate({ isMainFrame: true, isSameDocument: false, url: 'http://localhost:4242/' });
}

/**
 * Let the recovery a failure started finish.
 *
 * A rung is not instant — two of them clear caches and remove directories —
 * and under fake timers there is no amount of clock advancing that waits for
 * real filesystem work. Nor is a fixed number of event-loop turns an answer:
 * that was tried, and it passed alone and failed under a full parallel suite
 * run. So the wait is on the rung's **own** promise, which is exactly as long
 * as the work takes and no longer.
 */
export async function settle(): Promise<void> {
  for (let round = 0; round < SETTLE_ROUNDS; round += 1) {
    const inFlight = pendingRecovery();
    if (!inFlight) break;
    // A rung yields out of the failing event's own stack on a real timer
    // before it touches the window, so the clock has to move for it to
    // start at all.
    await vi.advanceTimersByTimeAsync(1);
    await inFlight;
    await vi.advanceTimersByTimeAsync(0);
  }
}

/** Let the deadline expire, and let the rung it triggers finish its work. */
export async function expireDeadline(): Promise<void> {
  await vi.advanceTimersByTimeAsync(HEARTBEAT_DEADLINE_MS);
  await settle();
}

/** Drive `count` consecutive failures through the heartbeat deadline. */
export async function failTimes(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await expireDeadline();
    // Each rung's recovery issues a fresh load; only a fresh load re-opens
    // the ladder, exactly as a new main-frame document does in production.
    await startMainFrameLoad();
  }
}

/**
 * Register the per-test setup: fake timers, fresh doubles, a throwaway
 * `userData` and one supervised window in `ctx.win`.
 */
export function useSupervisor(): void {
  beforeEach(() => {
    vi.useFakeTimers();
    resetElectronMock();
    resetLogMock();
    resetRendererSupervisor();

    ctx.base = mkdtempSync(join(tmpdir(), 'dorkos-renderer-health-'));
    ctx.userData = join(ctx.base, 'ctx.userData');
    app.getPath = vi.fn(() => ctx.userData);

    setupRendererRecovery();
    ctx.win = new BrowserWindow();
    attachRendererSupervisor(ctx.win as unknown as Electron.BrowserWindow, OPTIONS);
  });

  afterEach(() => {
    resetRendererSupervisor();
    vi.useRealTimers();
    rmSync(ctx.base, { recursive: true, force: true });
  });
}
