/**
 * Hold back an extension page's "not available" states for a moment.
 *
 * @module widgets/extension-page/model/use-settled-page-state
 */
import { useEffect, useState } from 'react';
import type { ExtensionPageState } from './extension-page-state';

/**
 * How long a "not available" answer must hold before it is shown. Long enough
 * to cover an extension being torn down and brought back (a working-folder
 * change, a hot reload), short enough that a page that really is missing says
 * so without a wait anyone notices.
 */
export const EMPTY_STATE_SETTLE_MS = 400;

/**
 * The state to draw: the same as `state`, except that a "not available" answer
 * reads as `loading` until it has held for {@link EMPTY_STATE_SETTLE_MS}.
 *
 * An extension's contributions are torn down and registered again on every
 * reload, and the registry and the extension list do not change in one render:
 * for a frame or two the page is gone while its extension is still listed as
 * running. Without this, a reload drew "doesn't have this page" and then the
 * page. With it, the person sees the skeleton, then the page — and a page that
 * really is missing still says so, a moment later.
 *
 * @param state - What the registry and the extension list say right now.
 */
export function useSettledPageState(state: ExtensionPageState): ExtensionPageState {
  const unavailable = state.kind !== 'page' && state.kind !== 'loading';
  // Keyed on the kind and the name, so a change of reason restarts the wait
  // only when there is a new answer to hold back.
  const answer = unavailable ? `${state.kind}:${state.name}` : null;
  const [settled, setSettled] = useState<string | null>(null);

  useEffect(() => {
    if (answer === null) return;
    const timer = setTimeout(() => setSettled(answer), EMPTY_STATE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [answer]);

  if (answer !== null && settled !== answer) return { kind: 'loading' };
  return state;
}
