/**
 * What pressing an app does, wherever it is pressed — a pinned row, a tile,
 * ⌘K — so the three can never disagree (DOR-3970, spec §3, §7b).
 *
 * - `ok` opens its page.
 * - `held` opens the Inbox on its approval card. **Never approves**: only a
 *   person approves, on the card.
 * - `error` tries again in place (the tile reads "Trying…"); if it is still
 *   not working, it opens the app's row in Settings › Extensions.
 * - `off` opens that Settings row, where its switch is.
 *
 * @module entities/extension/model/use-app-actions
 */
import { useCallback, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import { requestInbox } from '@/layers/entities/notifications';
import { extensionPageHref, resolveApiBaseUrl } from '@/layers/shared/lib';
import { useSettingsDeepLink } from '@/layers/shared/model';
import { appState, type AppEntry } from '../lib/app-catalog';
import { useRetryApps } from './use-app-catalog';
import { extensionQueryKeys } from './use-pending-extension-approvals';

/** The apps being tried again right now, by id. Shared so a row and a tile agree. */
let trying: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

/** Replace the set of apps being tried and tell every reader. */
function setTrying(next: ReadonlySet<string>): void {
  trying = next;
  listeners.forEach((listener) => listener());
}

/** Subscribe to {@link trying}. */
function subscribeTrying(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Whether this app is being tried again right now ("Trying…").
 *
 * @param id - The extension id.
 */
export function useAppTrying(id: string): boolean {
  return useSyncExternalStore(
    subscribeTrying,
    () => trying.has(id),
    () => false
  );
}

/** The app as pressing it needs it: which one, and what it is doing. */
export type AppTarget = Pick<AppEntry, 'id' | 'path' | 'state'>;

/** What {@link useAppActions} answers with. */
export interface AppActions {
  /** Press the app: the one action its state calls for. */
  open: (app: AppTarget) => void;
  /** Open its page in a new browser tab, whatever its state. */
  openInNewTab: (app: AppTarget) => void;
  /** Open its row in Settings › Extensions. */
  openSettings: (id: string) => void;
  /** Try loading it again, then open Settings if it is still not working. */
  tryAgain: (id: string) => Promise<void>;
  /** Turn it on or off, the same switch its Settings row has. */
  setOn: (id: string, on: boolean) => Promise<void>;
}

/** The pressing, opening and retrying every app surface shares. */
export function useAppActions(): AppActions {
  const router = useRouter();
  const queryClient = useQueryClient();
  const retry = useRetryApps();
  const settings = useSettingsDeepLink();
  const openSettingsAt = settings.open;

  const openSettings = useCallback(
    (id: string) => openSettingsAt('extensions', id),
    [openSettingsAt]
  );

  const tryAgain = useCallback(
    async (id: string) => {
      if (trying.has(id)) return;
      setTrying(new Set([...trying, id]));
      try {
        await retry();
      } finally {
        setTrying(new Set([...trying].filter((other) => other !== id)));
      }
      const list = queryClient.getQueryData<ExtensionRecordPublic[]>(extensionQueryKeys.list());
      const ext = list?.find((entry) => entry.id === id);
      // Still broken after a second try: the person needs the details, which
      // live on its Settings row.
      if (ext === undefined || appState(ext, false) === 'error') openSettings(id);
    },
    [openSettings, queryClient, retry]
  );

  const open = useCallback(
    (app: AppTarget) => {
      switch (app.state) {
        case 'ok':
          void router.navigate({ href: extensionPageHref(app.id, app.path) });
          return;
        case 'held':
          requestInbox(undefined, { focus: app.id });
          return;
        case 'error':
          void tryAgain(app.id);
          return;
        case 'off':
          openSettings(app.id);
          return;
      }
    },
    [openSettings, router, tryAgain]
  );

  const openInNewTab = useCallback((app: AppTarget) => {
    window.open(extensionPageHref(app.id, app.path), '_blank', 'noopener');
  }, []);

  const setOn = useCallback(
    async (id: string, on: boolean) => {
      const res = await fetch(
        `${resolveApiBaseUrl()}/extensions/${encodeURIComponent(id)}/${on ? 'enable' : 'disable'}`,
        { method: 'POST' }
      ).catch(() => null);
      if (res === null || !res.ok) {
        // The server's own sentence says who can do it when a person bar refused it.
        const body = (await res?.json().catch(() => ({}))) as { message?: string } | undefined;
        toast(
          body?.message ??
            (on ? 'Couldn’t turn it on. Try again.' : 'Couldn’t turn it off. Try again.')
        );
        return;
      }
      await queryClient.invalidateQueries({ queryKey: extensionQueryKeys.list() });
      // Turning one on or off changes what is registered, so reload the screens.
      await retry();
    },
    [queryClient, retry]
  );

  return { open, openInNewTab, openSettings, tryAgain, setOn };
}
