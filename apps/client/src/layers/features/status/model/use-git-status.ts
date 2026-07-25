import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { QUERY_TIMING } from '@/layers/shared/lib';
import type { GitStatusResponse, GitStatusError } from '@dorkos/shared/types';
import type { GitDiagnostics } from './session-diagnostics';

/** Shared "nothing known yet" value, so an unresolved query keeps a stable snapshot. */
const GIT_UNKNOWN: GitDiagnostics = Object.freeze({ state: 'unknown' });
/** Shared resolved "this is not a repository" value. */
const GIT_NO_REPO: GitDiagnostics = Object.freeze({ state: 'no-repo' });

/** Poll the git status (branch, ahead/behind) for a working directory. */
export function useGitStatus(cwd: string | null) {
  const transport = useTransport();

  return useQuery({
    queryKey: ['git-status', cwd],
    queryFn: () => transport.getGitStatus(cwd ?? undefined),
    enabled: !!cwd,
    refetchInterval: QUERY_TIMING.GIT_STATUS_REFETCH_MS,
    refetchIntervalInBackground: false,
    staleTime: QUERY_TIMING.GIT_STATUS_STALE_TIME_MS,
  });
}

/** Type guard that narrows a git status response to a successful result. */
export function isGitStatusOk(
  data: GitStatusResponse | GitStatusError | undefined
): data is GitStatusResponse {
  return !!data && !('error' in data);
}

/**
 * Narrow a git-status query result to the three states a readout has to tell
 * apart.
 *
 * `undefined` is "the request has not answered" (in flight, or it failed) and
 * resolves to `unknown` — never to `no-repo`, which is a positive answer the
 * server only gives as `error: 'not_git_repo'`. Folding the two together is what
 * made the Session tab read "Git — no repo" on a real checkout for the length of
 * the first request.
 *
 * @param data - The `useGitStatus` query data, or `undefined` before it resolves.
 */
export function gitDiagnosticsFrom(
  data: GitStatusResponse | GitStatusError | undefined
): GitDiagnostics {
  if (data === undefined) return GIT_UNKNOWN;
  if ('error' in data) return GIT_NO_REPO;
  return { state: 'repo', branch: data.branch, dirty: !data.clean };
}
