/**
 * The first-run server calls (spec `one-minute-onboarding` §4, §5.2): record
 * the path picked on the Welcome screen, wait for DorkOS credits to be ready,
 * and post DorkBot's welcome into #team.
 *
 * @module features/onboarding/model/use-first-run
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CloudCreditsReadiness, CloudCreditsStatus } from '@dorkos/shared/cloud-schemas';
import type { FirstRunRequest } from '@dorkos/shared/onboarding-schemas';
import { configKeys } from '@/layers/entities/config';
import { REQUIREMENTS_KEY } from '@/layers/entities/runtime';
import { MODELS_KEY } from '@/layers/shared/lib';
import { cloudCreditsKeys, useTransport } from '@/layers/shared/model';

/** How often Connecting asks whether credits are ready (the link poll's beat). */
export const READINESS_POLL_MS = 2500;

/** Said when a first-run call failed and the server sent no sentence of its own. */
const FIRST_RUN_FAILED = 'Couldn’t finish setup. Try again.';

/**
 * The sentence to show for a failed first-run call: the server's own when it
 * sent one (an invalid key, a service it could not reach), else a plain retry.
 *
 * @param error - What the call rejected with.
 */
export function firstRunErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message && !/^HTTP \d+$/.test(error.message)) {
    return error.message;
  }
  return FIRST_RUN_FAILED;
}

/**
 * Record the path picked on the Welcome screen and set it up. The server undoes
 * an earlier pick first, so changing one's mind is just another call.
 *
 * Every read the pick moves is refreshed: the config (default runtime, the
 * first-run record), the model menus, credits, and which AI apps are ready.
 */
export function useChooseFirstRunPath() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: FirstRunRequest) => transport.chooseFirstRunPath(request),
    onSettled: () => {
      for (const queryKey of [configKeys.all, MODELS_KEY, cloudCreditsKeys.status()]) {
        void queryClient.invalidateQueries({ queryKey });
      }
      void queryClient.invalidateQueries({ queryKey: REQUIREMENTS_KEY });
    },
    // Each screen says what went wrong in its own place, beside the control.
    meta: { suppressErrorToast: true },
  });
}

/**
 * Whether DorkOS credits are ready for the DorkOS runtime, asked every
 * {@link READINESS_POLL_MS} while `enabled`.
 *
 * Reads the same cache entry as every other credits read, so the moment it
 * answers `ready` the Runs on list and the status bar know too. An older server
 * that sends no `readiness` reads as `linked` once the link is made: not ready,
 * never a guess that it is.
 *
 * @param enabled - Poll only while the Connecting screen is waiting.
 * @returns The readiness, or `undefined` before the first answer.
 */
export function useCreditsReadiness(enabled: boolean): CloudCreditsReadiness | undefined {
  const transport = useTransport();
  const { data } = useQuery<CloudCreditsStatus>({
    queryKey: cloudCreditsKeys.status(),
    queryFn: () => transport.getCloudCredits(),
    enabled,
    refetchInterval: enabled ? READINESS_POLL_MS : false,
    refetchIntervalInBackground: enabled,
    staleTime: 0,
  });
  if (!data) return undefined;
  return data.readiness ?? (data.linked ? 'linked' : 'unlinked');
}

/**
 * Post DorkBot's welcome into #team. Idempotent on the server: a second call
 * answers with the same entry.
 */
export function usePostOnboardingWelcome() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => transport.postOnboardingWelcome(),
    // `welcomeEntryId` rides the config; the chips under the welcome key on it.
    onSettled: () => void queryClient.invalidateQueries({ queryKey: configKeys.all }),
    meta: { suppressErrorToast: true },
  });
}
