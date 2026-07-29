/**
 * Read and write the user profile block of `~/.dork/config.json`
 * (spec `user-profile-onboarding`).
 *
 * Rides the same `GET /api/config` query and `PATCH /api/config` deep-merge
 * write path as onboarding and tours, so every consumer (the role beat, the
 * existing-user prompt card, the ProgressCard row) sees one consistent cache.
 *
 * @module features/onboarding/model/use-profile
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { UserProfile } from '@dorkos/shared/config-schema';
import { useTransport } from '@/layers/shared/model';

const CONFIG_KEY = ['config'] as const;

/** What {@link useProfile} hands its consumers. */
export interface ProfileApi {
  /** The saved roles; empty until the user answers. */
  roles: string[];
  /** When the one-time existing-user prompt was dismissed, or null. */
  rolePromptDismissedAt: string | null;
  /** Whether the config query has not resolved yet. */
  isLoading: boolean;
  /** Persist the roles (`{ profile: { roles } }`). Rejects on failure. */
  saveRoles: (roles: string[]) => Promise<void>;
  /** Record "don't ask again" on the profile block itself (spec D3). */
  dismissRolePrompt: () => Promise<void>;
}

/**
 * Profile state + writes for the onboarding surfaces.
 */
export function useProfile(): ProfileApi {
  const transport = useTransport();
  const queryClient = useQueryClient();

  const { data: config, isLoading } = useQuery({
    queryKey: [...CONFIG_KEY],
    queryFn: () => transport.getConfig(),
    staleTime: 5 * 60 * 1000,
  });

  const patchProfile = useMutation({
    mutationFn: (patch: Partial<UserProfile>) => transport.updateConfig({ profile: patch }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...CONFIG_KEY] });
    },
  });

  return {
    roles: config?.profile?.roles ?? [],
    rolePromptDismissedAt: config?.profile?.rolePromptDismissedAt ?? null,
    isLoading,
    saveRoles: (roles: string[]) => patchProfile.mutateAsync({ roles }).then(() => {}),
    dismissRolePrompt: () =>
      patchProfile.mutateAsync({ rolePromptDismissedAt: new Date().toISOString() }).then(() => {}),
  };
}
