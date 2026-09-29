/**
 * Which Claude accounts may work in the project a folder belongs to (spec
 * `flow-multiproject` §8.5, §8.6), for the pickers that show an account that
 * may not work there disabled, with its reason ("Only for client-app").
 *
 * In `shared/` beside {@link useClaudeAccounts} because the status-bar picker
 * (a feature) and Settings (another feature) both read it.
 *
 * @module shared/model/server-config/use-account-eligibility
 */
import { useQuery } from '@tanstack/react-query';
import type {
  AccountEligibilityResponse,
  AccountEligibilityRow,
} from '@dorkos/shared/project-schemas';
import { useTransport } from '../TransportContext';
import { accountKeys } from './query-keys';

/** What a picker and Settings say for an account kept to no project at all. */
export const NOT_USED_IN_ANY_PROJECT = 'Not used in any project';

/** How long an eligibility read stays fresh; the rules change only in Settings. */
const ELIGIBILITY_STALE_TIME_MS = 30_000;

/** What {@link useAccountEligibility} hands a picker. */
export interface AccountEligibilityView {
  /** The folder's project name, or null when it is in no project (or not known yet). */
  projectName: string | null;
  /**
   * Why an account may not work here, by account id: "Only for client-app" or
   * "Not used in dorkos". Absent for an account that may.
   */
  reasonFor: (accountId: string) => string | undefined;
  /**
   * What a new chat here runs on when nobody picks an account, as the server's
   * launch ladder answers it (the agent's account, else the default, skipping
   * to the next account that may work here), or the sentence it would be
   * refused with. `undefined` until the server has said, or from a server too
   * old to say.
   */
  launch: AccountEligibilityResponse['launch'];
}

/**
 * The short line a picker shows beside an account that may not work here.
 *
 * @param row - The account as the project's rules see it.
 * @param projectName - The project, or null for a folder in no project.
 */
export function notAllowedLine(row: AccountEligibilityRow, projectName: string | null): string {
  if (!row.allowedByAccount) {
    const names = row.onlyProjects?.map((p) => p.name) ?? [];
    if (names.length === 0) return NOT_USED_IN_ANY_PROJECT;
    const last = names[names.length - 1];
    return `Only for ${names.length === 1 ? last : `${names.slice(0, -1).join(', ')} and ${last}`}`;
  }
  return projectName ? `Not used in ${projectName}` : 'Not used here';
}

/**
 * Read which accounts may work in `folder`'s project. Silent while unknown: an
 * account is only ever marked when the server has said so, so a read in flight
 * or one that failed disables nothing (the server still refuses on send).
 *
 * @param folder - The folder the session runs in, or null for none.
 * @param inputs - Anything else the launch answer depends on (the folder's
 *   agent's account, the server default), so a change to one asks again
 *   rather than naming yesterday's account.
 * @param enabled - Ask at all; false where no picker is drawn (one account),
 *   so a chat that cannot choose makes no request.
 */
export function useAccountEligibility(
  folder: string | null,
  inputs: readonly unknown[] = [],
  enabled = true
): AccountEligibilityView {
  const transport = useTransport();
  const { data } = useQuery({
    queryKey: [...accountKeys.eligibility(folder), ...inputs],
    queryFn: () => transport.getAccountEligibility(folder ?? undefined),
    staleTime: ELIGIBILITY_STALE_TIME_MS,
    enabled,
  });
  const projectName = data?.project?.name ?? null;
  const rows = new Map((data?.accounts ?? []).map((row) => [row.id, row]));
  return {
    projectName,
    reasonFor: (accountId) => {
      const row = rows.get(accountId);
      return row && !row.eligible ? notAllowedLine(row, projectName) : undefined;
    },
    launch: data?.launch,
  };
}
