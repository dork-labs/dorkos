/**
 * Shared setup for the interactive-handlers tests, split from one file by subject.
 */
import { vi } from 'vitest';
import { type ToolApprovalContext } from '../../interactive-handlers.js';
import type { InteractiveSession, PendingInteraction } from '../../interaction-wait.js';
import type { StreamEvent } from '@dorkos/shared/types';
import { type PermissionMode } from '@dorkos/shared/schemas';

/** Build a minimal interactive session with a configurable permission mode. */
export function makeSession(
  permissionMode: PermissionMode
): InteractiveSession & { permissionMode: PermissionMode } {
  return {
    permissionMode,
    pendingInteractions: new Map<string, PendingInteraction>(),
    eventQueue: [] as StreamEvent[],
    eventQueueNotify: vi.fn(),
  };
}

/** Minimal SDK approval context — an unaborted signal is all the gate needs. */
export function makeContext(toolUseID: string): ToolApprovalContext {
  return {
    signal: new AbortController().signal,
    toolUseID,
  };
}

export const noopLog = { debug: () => {}, info: () => {} };

/** The countdown a prompt parks at, and the ceiling it is finally refused at. */
export const COUNTDOWN_MS = 10 * 60 * 1000;

export const CEILING_MS = 4 * 60 * 60 * 1000;

/** A bare session literal — no SDK mock, just the map + queue the handlers touch. */
export function makeBareSession(overrides: Partial<InteractiveSession> = {}): InteractiveSession {
  return {
    pendingInteractions: new Map<string, PendingInteraction>(),
    eventQueue: [] as StreamEvent[],
    sdkSessionId: 'session-under-test',
    ...overrides,
  };
}

/**
 * Has this promise settled yet? Resolves on the microtask queue, so it reports
 * the state as of now rather than waiting for one.
 */
export function settlementOf(promise: Promise<unknown>): Promise<'settled' | 'pending'> {
  return Promise.race([
    promise.then(() => 'settled' as const),
    Promise.resolve('pending' as const),
  ]);
}
