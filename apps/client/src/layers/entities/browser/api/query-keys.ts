/** Browser server-state keys separate people and exact original generations. */
export const browserKeys = {
  all: (owner: string | null) => ['browser', owner] as const,
  profiles: (owner: string | null) => [...browserKeys.all(owner), 'profiles'] as const,
  profile: (owner: string | null, profileId: string) =>
    [...browserKeys.all(owner), 'profile', profileId] as const,
  instances: (owner: string | null) => [...browserKeys.all(owner), 'instances'] as const,
  instance: (owner: string | null, browserId: string, generation: number) =>
    [...browserKeys.all(owner), 'instance', browserId, generation] as const,
};
