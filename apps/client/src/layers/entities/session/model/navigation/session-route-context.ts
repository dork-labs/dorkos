import { create } from 'zustand';

/** The directory resolved for one route, independent of other open tabs. */
export interface SessionRouteContext {
  cwd: string;
  draft: boolean;
  /** Runtime selected for this identity; retained by a fresh continuation. */
  runtime?: string;
}

const useRouteContexts = create<{ contexts: Record<string, SessionRouteContext> }>(() => ({
  contexts: {},
}));

/** Install a server-resolved location for one session identity. */
export function setSessionRouteContext(sessionId: string, context: SessionRouteContext) {
  useRouteContexts.setState((state) => ({ contexts: { ...state.contexts, [sessionId]: context } }));
}

/** Read a resolved location when preparing a continuation. */
export function getSessionRouteContext(sessionId: string) {
  return useRouteContexts.getState().contexts[sessionId];
}

/** Subscribe to the active route's resolved location, never another tab's selection. */
export function useSessionRouteContext(identity: string | null | undefined) {
  return useRouteContexts((state) => (identity ? state.contexts[identity] : undefined));
}
