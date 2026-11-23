import { beginSessionNavigation } from '../../lib/session-navigation-intent';
import { useCallback, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';

import { useAppStore, useAppTabsStore, useTransport } from '@/layers/shared/model';
import { useSessionSearch } from './use-session-search';
import { useLiveLocation } from './use-live-location';
import { getSessionRouteContext, setSessionRouteContext } from './session-route-context';
import {
  isDesktopShell,
  toSession,
  newSessionTarget,
  reportClientError,
} from '@/layers/shared/lib';
import { toast } from 'sonner';

/** Open a fresh conversation in the chosen directory, preserving an optional seed. */
export function useStartNewSession(): (dir?: string, options?: StartNewSessionOptions) => void {
  const navigate = useNavigate();
  const readLocation = useLiveLocation();
  const transport = useTransport();
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const setPendingRuntime = useAppStore((s) => s.setPendingRuntime);
  const pending = useRef<{ key: string; isStillWanted: () => boolean } | null>(null);

  return useCallback(
    (dir?: string, options?: StartNewSessionOptions) => {
      const { agentId, prompt, seed, runtime } = options ?? {};
      const targetDir = agentId ? undefined : (dir ?? selectedCwd ?? undefined);
      const key = JSON.stringify([targetDir, agentId, prompt, seed, runtime]);
      const current = pending.current;
      if (current?.key === key && current.isStillWanted()) return;

      const request = { key, isStillWanted: beginSessionNavigation(readLocation) };
      pending.current = request;
      void newSessionTarget(
        transport,
        { dir: targetDir, agentId, prompt, seed, runtime },
        { isStillWanted: request.isStillWanted }
      )
        .then((target) => {
          if (!request.isStillWanted()) return;
          if (runtime) setPendingRuntime({ sessionId: target.search.session, type: runtime });
          return navigate(target);
        })
        .catch((error) => {
          reportClientError(transport, error);
          // An abandoned start does not explain itself (the use-directory-state
          // ordering); the report above still goes out.
          if (request.isStillWanted()) toast.error('Couldn’t open a new chat.');
        })
        .finally(() => {
          if (pending.current === request) pending.current = null;
        });
    },
    [navigate, readLocation, selectedCwd, setPendingRuntime, transport]
  );
}

/** Extras a caller can put on the fresh conversation's address. */
export interface StartNewSessionOptions {
  /** Exact registered agent to open a new chat with. */
  agentId?: string;
  /** Text placed in the composer after navigation. */
  prompt?: string;
  /**
   * The `?seed=` launch param (BC-48). Background the first turn carries — never
   * text, and never anything the caller has not enumerated in the route schema.
   */
  seed?: 'dorkbot-help';
  /**
   * The runtime the fresh conversation starts on, picked for it exactly as the
   * runtime chip's pre-launch pick is. Omitted, it starts on the default.
   */
  runtime?: string;
}

/**
 * Options for the session-id setter.
 *
 * A `replace` is always a rename of one chat, so it must say which chat: the
 * type requires `from` with it, and there is no anonymous in-place rewrite.
 */
export type SetSessionIdOptions = SetSessionIdBaseOptions &
  (SetSessionIdPushOptions | SetSessionIdRenameOptions);

/** A navigation that pushes a history entry (the default). */
interface SetSessionIdPushOptions {
  /** Push a new history entry. */
  replace?: false;
  /** Only a rename names the chat it renames. */
  from?: never;
}

/**
 * A rename of the chat on screen: REPLACES the current history entry instead of
 * pushing one. Used for the first-message acknowledged-draft → canonical-id
 * rekey so the canonical URL silently supersedes the optimistic one (no extra
 * Back step).
 */
interface SetSessionIdRenameOptions {
  /** Replace the current history entry. */
  replace: true;
  /**
   * The chat this rename renames from. The rename lands only while the live
   * location still shows it: renames arrive late (after a POST resolves, or a
   * rekey announce), and one that landed after a tab switch or a sidebar click
   * would rewrite another chat's address into this one (DOR-4622). Otherwise
   * only desktop tabs still saved on `from` are renamed.
   */
  from: string;
}

/** Options shared by every session-id navigation. */
interface SetSessionIdBaseOptions {
  /** The ID is an explicit fresh conversation, never an existing-session lookup. */
  draft?: boolean;
  /**
   * The session this new one continues from (the `/clear` intent's "linked back"
   * reference, DOR-109). Recorded as client navigation state in the URL — a
   * lightweight link, no DB column. Omit for an unrelated navigation; passing it
   * as `undefined` drops any prior `continuedFrom` so the link never leaks
   * forward onto later navigations.
   */
  continuedFrom?: string;
}

/**
 * Carry a rename the URL could not take to the tabs that still hold the chat.
 *
 * The chat left the screen before its new id arrived, but a desktop tab in the
 * background may still be saved on the old one, and the in-memory rekey that
 * redirects it is gone after a restart. So the saved tab is renamed, and the
 * new id inherits the old one's route context so the tab reopens in the same
 * folder. Desktop shell only, the gate `useAppTabsSync` uses: outside it the
 * tab store is never written, not even its `sessionStorage` mirror (DOR-568).
 */
function renameInBackgroundTabs(from: string, to: string): void {
  const context = getSessionRouteContext(from);
  if (context && !getSessionRouteContext(to)) setSessionRouteContext(to, context);
  if (isDesktopShell()) useAppTabsStore.getState().renameSessionInTabs(from, to);
}

/** Read the session from the URL and navigate when its id changes. */
export function useSessionId(): [
  string | null,
  (id: string | null, options?: SetSessionIdOptions) => void,
] {
  // Standalone: TanStack Router search params
  const search = useSessionSearch();
  const navigate = useNavigate();
  const readLocation = useLiveLocation();
  const transport = useTransport();
  const pendingDraft = useRef<{ from: string | undefined; isStillWanted: () => boolean } | null>(
    null
  );

  // Stable reference — navigate from TanStack Router is already stable.
  const setSessionId = useCallback(
    (id: string | null, options?: SetSessionIdOptions) => {
      // A rename of a chat the person has since left never touches the URL,
      // which now shows another chat; only the tabs still saved on it are
      // renamed. Read from the router itself, not this render's `search`: the
      // caller may hold a setter from before the switch, or a fresh one from
      // after it.
      if (options?.replace && readLocation().search.session !== options.from) {
        if (id) renameInBackgroundTabs(options.from, id);
        return;
      }
      if (options?.draft) {
        const current = pendingDraft.current;
        if (current && current.from === options.continuedFrom && current.isStillWanted()) return;
        // Taken at the call, checked after the server answers (DOR-4622).
        const isStillWanted = beginSessionNavigation(readLocation);
        const request = { from: options.continuedFrom, isStillWanted };
        pendingDraft.current = request;
        const cwd =
          getSessionRouteContext(search.session ?? '')?.cwd ??
          useAppStore.getState().selectedCwd ??
          undefined;
        void newSessionTarget(
          transport,
          {
            dir: cwd,
            runtime: getSessionRouteContext(search.session ?? '')?.runtime ?? search.runtime,
            continuedFrom: options.continuedFrom,
          },
          { isStillWanted }
        )
          .then((target) => (isStillWanted() ? navigate(target) : undefined))
          .catch((error) => {
            reportClientError(transport, error);
            if (isStillWanted()) toast.error('Couldn’t open a new chat.');
          })
          .finally(() => {
            if (pendingDraft.current === request) pendingDraft.current = null;
          });
        return;
      }
      // A rename carries the context of the chat it renames, which the guard
      // above proved is the one on screen; this render's `search` may be older.
      const context = getSessionRouteContext(
        options?.replace ? options.from : (search.session ?? '')
      );
      if (id && options?.replace && context) setSessionRouteContext(id, context);
      navigate({
        ...toSession((prev) => ({
          ...prev,
          session: id ?? undefined,
          draft: options?.replace && prev.draft ? prev.draft : undefined,
          launchRef: options?.replace && prev.draft ? prev.launchRef : undefined,
          agentId: options?.replace && prev.draft ? prev.agentId : undefined,
          dir: undefined,
          // Set explicitly so a fresh navigation without a link drops any prior
          // `continuedFrom` rather than carrying it forward via `...prev`.
          continuedFrom: options?.continuedFrom,
          // Launch params belong to the session they were aimed at, and this is
          // the setter that changes which session that is — so they are dropped
          // here for the same reason `continuedFrom` is, and one worse
          // consequence. A `?prompt=` and
          // `?send=1` that rode `...prev` forward landed on a session that was
          // empty by construction, where they typed and SENT themselves. The
          // hook that consumes them spends them on every outcome now, so this is
          // the second of two independent guards rather than the only one.
          // `seed` (Ask DorkBot) is dropped here for the identical reason: it is
          // background aimed at ONE conversation, and this is the setter that
          // changes which conversation that is.
          prompt: undefined,
          send: undefined,
          seed: undefined,
          // The session view belongs to the chat it was opened on: a rename
          // keeps it, a different chat opens as itself (DOR-3074).
          view: options?.replace ? prev.view : undefined,
        })),
        replace: options?.replace,
      });
    },
    [navigate, readLocation, transport, search.session, search.runtime]
  );

  return [search.session ?? null, setSessionId];
}
