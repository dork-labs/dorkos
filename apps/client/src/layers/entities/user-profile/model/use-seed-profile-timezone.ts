/**
 * Tell the server the person's time zone, once, from the browser (spec
 * `heartbeats` §3.5).
 *
 * The browser is the one place that knows where the person is: the server may
 * run in a container, on a remote host, or in another country. So the first
 * time the app opens with `profile.timezone` still empty, it writes the
 * browser's zone through the same `PATCH /api/config` every profile write uses.
 * A zone already set is never touched — the person, or DorkBot on their word,
 * may have chosen a different one on purpose.
 *
 * @module entities/user-profile/model/use-seed-profile-timezone
 */
import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CONFIG_WRITE_MUTATION_KEY, useTransport } from '@/layers/shared/model';
import { configKeys, CONFIG_STALE_TIME_MS } from '@/layers/entities/config';

/** The browser's IANA zone, or `null` when it cannot say. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * Seed `profile.timezone` from the browser when it is empty. Mounted once, in
 * the app shell.
 *
 * Runs at most once per page load, and only after the config has been read: an
 * unread config is not an empty one. A failed write stays quiet — no toast for
 * something the person never asked for — and the next load tries again.
 */
export function useSeedProfileTimezone(): void {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const attempted = useRef(false);

  const { data: config, isSuccess } = useQuery({
    queryKey: configKeys.current(),
    queryFn: () => transport.getConfig(),
    staleTime: CONFIG_STALE_TIME_MS,
  });

  const seed = useMutation({
    mutationKey: CONFIG_WRITE_MUTATION_KEY,
    mutationFn: (timezone: string) => transport.updateConfig({ profile: { timezone } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: configKeys.all });
    },
    meta: { suppressErrorToast: true },
  });
  const { mutate } = seed;

  const profile = config?.profile;
  useEffect(() => {
    if (attempted.current || !isSuccess || !profile) return;
    // Present and set: the person's choice, or an earlier seed. Never overwritten.
    if (profile.timezone) {
      attempted.current = true;
      return;
    }
    // An older server's config has no such field; there is nothing to seed.
    if (!('timezone' in profile)) return;
    const zone = browserTimeZone();
    if (!zone) return;
    attempted.current = true;
    mutate(zone);
  }, [isSuccess, profile, mutate]);
}
