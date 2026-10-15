/**
 * Why an isolated extension did not start, as its card shows it: the codes a
 * start can be refused with, and the refusal for a child that could not load
 * its bundle or whose server half failed to start (DOR-2686, DOR-2861).
 *
 * @module services/extensions/isolation/start-refusal
 */
import { extensionServerErrorCopy } from '@dorkos/shared/extension-server-status';
import type { RegisteredMessage } from './ipc-protocol.js';

/** Why a start was refused, as a record's `serverError.code`. */
export type IsolatedStartErrorCode =
  'isolation_unavailable' | 'server_start_failed' | 'server_start_timeout' | 'server_old_router';

/** The outcome of starting an isolated extension. */
export type IsolatedStartResult =
  { ok: true } | { ok: false; code: IsolatedStartErrorCode; message: string };

/**
 * The refusal for a child that could not load its bundle.
 *
 * @param name - The extension's display name.
 * @param error - What the child said, if anything.
 */
export function loadRefusal(name: string, error: string | undefined): IsolatedStartResult {
  return {
    ok: false,
    code: 'server_start_failed',
    message: `${name} couldn't start: ${error ?? 'its code failed to load'}.`,
  };
}

/**
 * The refusal for a server half that failed to start: one written for the
 * Express router DorkOS no longer runs gets its own code and sentence.
 *
 * @param name - The extension's display name.
 * @param message - The child's failed `registered` message.
 */
export function registerRefusal(name: string, message: RegisteredMessage): IsolatedStartResult {
  if (message.oldRouter === true) {
    return {
      ok: false,
      code: 'server_old_router',
      message: extensionServerErrorCopy('server_old_router', name)!,
    };
  }
  return {
    ok: false,
    code: 'server_start_failed',
    message: `${name} couldn't start: ${message.error ?? 'its server part failed to start'}.`,
  };
}
