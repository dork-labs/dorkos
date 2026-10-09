/** Closed original navigation producer phases; values convey diagnostics only. */
export type OriginalNavigationRefusalPhase =
  | 'owned.dispatch'
  | 'owned.admission'
  | 'owned.capture-join'
  | 'owned.claim'
  | 'owned.token'
  | 'owned.abort-listener'
  | 'owned.target'
  | 'owned.authorize-first'
  | 'owned.reset'
  | 'owned.reset-observed'
  | 'owned.action-authority'
  | 'owned.authorize-second'
  | 'owned.listeners'
  | 'owned.goto'
  | 'owned.commit'
  | 'owned.listener-release'
  | 'owned.authorize-final'
  | 'owned.result'
  | 'owned.finish';
export type OriginalNavigationRefusalDecision =
  'original' | 'custody' | 'canonical' | 'authority' | 'state';
const rows = new WeakMap<
  object,
  Readonly<{ phase: OriginalNavigationRefusalPhase; decision: OriginalNavigationRefusalDecision }>
>();
const originalGet = rows.get.bind(rows),
  originalSet = rows.set.bind(rows),
  freeze = Object.freeze;
/** Retain only fixed phase at the original failure site; never mutate or replace its exact reason. */
export function retainOriginalNavigationRefusal<T>(
  reason: T,
  phase: OriginalNavigationRefusalPhase,
  decision: OriginalNavigationRefusalDecision = 'original'
): T {
  if ((typeof reason === 'object' && reason !== null) || typeof reason === 'function') {
    try {
      if (!originalGet(reason)) originalSet(reason, freeze({ phase, decision }));
    } catch {
      /* Non-authoritative original diagnostic only. */
    }
  }
  return reason;
}
/** Read only the private original cell; no error properties, native calls or authority queries. */
export function readOriginalNavigationRefusal(reason: unknown) {
  if ((typeof reason === 'object' && reason !== null) || typeof reason === 'function') {
    try {
      return originalGet(reason);
    } catch {
      /* Non-authoritative original diagnostic only. */
    }
  }
  return undefined;
}
