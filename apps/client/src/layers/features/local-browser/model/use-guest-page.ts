import { useCallback, useEffect, useState } from 'react';

/** One guest page's loads, as the desktop shell reports them. */
export interface GuestPage {
  /** The page is loading: the loading bar runs and Reload becomes Stop. */
  loading: boolean;
  /** Its last main-frame load failed, until a page commits. */
  failure: DesktopBrowserPageState['failure'];
  /** Ask the shell to Stop, Reload, Go back, or Try again (the address it recorded). */
  run: (action: 'stop' | 'retry' | 'back' | 'reload') => void;
}

const IDLE = { loading: false, failure: null } as const;

/**
 * Follow the embedded page's loads and failures (DOR-4430, DOR-4431). Outside the desktop
 * shell, or on a shell without the bridge, the page always reads as idle.
 *
 * @param connectionId - The guest's connection, or `null` while none is open.
 */
export function useGuestPage(connectionId: string | null): GuestPage {
  const [state, setState] = useState<{
    connectionId: string | null;
    loading: boolean;
    failure: DesktopBrowserPageState['failure'];
  }>({ connectionId: null, ...IDLE });
  useEffect(() => {
    const bridge = window.electronAPI?.localBrowser;
    if (!connectionId || !bridge?.page || !bridge.onPageChange) return;
    let live = true;
    const take = (next: DesktopBrowserPageState | null) => {
      if (live && next?.connectionId === connectionId)
        setState({ connectionId, loading: next.loading, failure: next.failure });
    };
    const stop = bridge.onPageChange(take);
    // A page that started loading before this panel mounted still shows.
    void bridge
      .page(connectionId, 'read')
      .then(take)
      .catch(() => undefined);
    return () => {
      live = false;
      stop();
    };
  }, [connectionId]);
  const run = useCallback<GuestPage['run']>(
    (action) => {
      const bridge = window.electronAPI?.localBrowser;
      if (!connectionId || !bridge?.page) return;
      void bridge.page(connectionId, action).catch(() => undefined);
    },
    [connectionId]
  );
  // A state another page reported never belongs to this one.
  const current = state.connectionId === connectionId ? state : IDLE;
  return { loading: current.loading, failure: current.failure, run };
}
