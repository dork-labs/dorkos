import type {
  LocalBrowserHandoff,
  LocalBrowserPersonState,
  LocalBrowserState,
} from '@dorkos/shared/local-browser';
import { siteOnly } from './urls.js';
import type { SignInWindow } from '../sign-in-window.js';
import type { HandoverBrowser } from './contracts.js';
import type { FallenChatTabs } from './fallen-tabs.js';

/** Project only the requesting chat's handoff, rechecking the live record after browser reads. */
export async function readPersonBrowserState(
  browser: HandoverBrowser,
  signIns: SignInWindow,
  record: () => LocalBrowserHandoff | null,
  fallen: FallenChatTabs,
  trim: (state: LocalBrowserState) => LocalBrowserState,
  sessionId?: string
): Promise<LocalBrowserPersonState> {
  const previous = record();
  const before = previous?.outcome === null ? previous : null;
  // The global handoff card must follow the held tab, not the last chat that opened one.
  const scope =
    sessionId ??
    (before && browser.usesPageLeases?.(before.sessionId) ? before.sessionId : undefined);
  const tabs = await browser.personTabs?.(scope);
  const state = trim(await browser.state(scope));
  const current = record();
  const open = current?.outcome === null ? current : null;
  // A handoff can start while state is being read. Never pair its card with another tab.
  if (
    sessionId === undefined &&
    open &&
    state.sessionId !== open.sessionId &&
    browser.usesPageLeases?.(open.sessionId)
  )
    return readPersonBrowserState(browser, signIns, record, fallen, trim, open.sessionId);
  const elsewhere =
    state.status === 'connected' &&
    state.mode === 'new-window' &&
    sessionId !== undefined &&
    open &&
    open.sessionId !== sessionId &&
    browser.usesPageLeases?.(open.sessionId);
  return {
    ...state,
    ...tabs,
    handoff:
      fallen.forChat(sessionId ?? state.sessionId) ??
      (sessionId === undefined || current?.sessionId === sessionId ? current : null),
    signIn: signIns.current,
    signInElsewhere: elsewhere ? { handoffId: open.id } : null,
    handoffAttached:
      !!fallen.forChat(sessionId ?? state.sessionId) ||
      (!!open &&
        (sessionId === undefined || sessionId === open.sessionId) &&
        !!browser.usesPageLeases?.(open.sessionId)),
  };
}

/** Held pages expose an origin only, including after their chat has stopped. */
export function trimPersonBrowserState(
  state: LocalBrowserState,
  record: LocalBrowserHandoff | null,
  fallen: FallenChatTabs,
  pageLeases: boolean
): LocalBrowserState {
  if (record?.outcome !== null && !fallen.forChat(state.sessionId)) return state;
  if (!fallen.forChat(state.sessionId) && record?.sessionId !== state.sessionId && pageLeases)
    return state;
  const tabs = state.tabs.map((tab) => ({ ...tab, url: siteOnly(tab.url), title: '' }));
  return { ...state, tabs };
}
