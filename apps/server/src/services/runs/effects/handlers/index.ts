/**
 * The outbox's handler registry (spec `turns-survive-restarts` §6.2): one
 * handler per effect kind that has one. A kind with no handler here is
 * dropped by the worker, loudly; each later step adds its kind's handler.
 *
 * @module services/runs/effects/handlers
 */
import type { EffectHandlers } from '../worker.js';
import { notifyPersonHandler, type NotifyPersonDeps } from './notify-person.js';

/** What the handlers need from the rest of the server, handed in at startup. */
export type EffectHandlerDeps = NotifyPersonDeps;

/**
 * Every handler the worker runs.
 *
 * @param deps - What the handlers need from the rest of the server.
 */
export function effectHandlers(deps: EffectHandlerDeps = {}): EffectHandlers {
  return { notify_person: notifyPersonHandler(deps) };
}
