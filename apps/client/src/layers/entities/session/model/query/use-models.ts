import { useQuery } from '@tanstack/react-query';
import { MODELS_KEY } from '@/layers/shared/lib';
import { useAppStore, useTransport } from '@/layers/shared/model';
import type { Transport } from '@dorkos/shared/transport';
import type { ModelOption } from '@dorkos/shared/types';

/** What decides a model catalog: the runtime, the session, and who pays. */
export interface ModelsQueryScope {
  /** Active session id (server resolves its runtime and account). */
  sessionId?: string;
  /** Runtime type; also keys the cache per runtime. */
  runtime?: string;
  /**
   * The account the menu is for: the person's pick for a session that has
   * not started, or `dorkos-credits` with no session (an agent on credits).
   * A session on DorkOS credits is offered only what credits serve.
   */
  account?: string;
  /**
   * The folder a session that has not started runs in, for the server's
   * ladder. Changing the machine default for credits invalidates every model
   * menu (`useSetCreditsDefault`), so a session left on the default asks again.
   */
  cwd?: string;
}

/**
 * Build the TanStack Query options for a runtime's model catalog — the ONE
 * query definition {@link useModels} and any batch consumer (`useQueries`,
 * e.g. the fleet rollup fetching several runtimes' catalogs at once) share, so
 * the query key and fetcher can never drift into two subtly different caches.
 *
 * @param transport - The active transport (from `useTransport`).
 * @param opts - What decides the catalog; see {@link ModelsQueryScope}.
 */
export function modelsQueryOptions(transport: Transport, opts?: ModelsQueryScope) {
  const sessionId = opts?.sessionId;
  const runtime = opts?.runtime;
  const account = opts?.account;
  const cwd = opts?.cwd;
  return {
    queryKey: [
      ...MODELS_KEY,
      runtime ?? null,
      sessionId ?? null,
      account ?? null,
      cwd ?? null,
    ] as const,
    queryFn: () => transport.getModels({ sessionId, runtime, account, cwd }),
    staleTime: 30 * 60 * 1000,
  };
}

/**
 * Fetch available models from the server. Long staleTime since models rarely change.
 *
 * For a session, the menu also depends on who pays for it (DOR-2636): a
 * session on DorkOS credits is offered only the models credits serve on its
 * runtime's protocol. So a session-scoped read carries what the server cannot
 * know on its own before the first message: the account the person picked for
 * this session (the same launch hint the first send carries) and the folder it
 * runs in. Every session-scoped reader goes through here, so the status line,
 * the picker and the session status all read one cache.
 *
 * @param opts.sessionId - Optional active session id. When provided, the server
 *   resolves the runtime that owns the session, and the account it runs on.
 * @param opts.runtime - Optional runtime type (e.g. `'codex'`). Threads the
 *   client-known runtime so a not-yet-started session — which has no
 *   server-side metadata row to resolve `sessionId` against — still gets the
 *   correct runtime's catalog instead of the default runtime's. Also keys the
 *   cache, so switching the pre-launch runtime selection refetches rather than
 *   serving a stale list. When both are absent, the server falls back to the
 *   default runtime (cold-discovery path — onboarding, first-run).
 * @param opts.account - For a read with no session only: the account the menu
 *   is for (`dorkos-credits` for an agent on credits). Without one, a read with
 *   no session is the runtime's own menu, the one every sign-in shares.
 */
export function useModels(opts?: { sessionId?: string; runtime?: string; account?: string }) {
  const transport = useTransport();
  const sessionId = opts?.sessionId;
  const pendingAccount = useAppStore((s) => s.pendingAccount);
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const scope: ModelsQueryScope = sessionId
    ? {
        sessionId,
        runtime: opts?.runtime,
        account: pendingAccount?.sessionId === sessionId ? pendingAccount.id : undefined,
        cwd: selectedCwd ?? undefined,
      }
    : { runtime: opts?.runtime, account: opts?.account };
  return useQuery<ModelOption[]>(modelsQueryOptions(transport, scope));
}
