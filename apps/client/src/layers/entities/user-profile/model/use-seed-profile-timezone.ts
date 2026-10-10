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
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { configKeys, CONFIG_STALE_TIME_MS } from '@/layers/entities/config';

/**
 * Whether this page load has already tried, successfully or not. Module-level
 * so a second window component, a remount or a failed write never tries again
 * before the next load: a server that refuses the field (an older build) gets
 * one request, not one per render.
 */
let attempted = false;

/** Forget that this page load tried. For tests. */
export function resetTimezoneSeedForTests(): void {
  attempted = false;
}

/** The browser's IANA zone, or `null` when it cannot say. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * Seed `profile.timezone` from the browser when it is empty — missing or
 * `null`. Mounted once, in the app shell.
 *
 * Runs at most once per page load, and only after the config has been read: an
 * unread config is not an empty one. A failed write stays quiet — no toast and
 * no console line for something the person never asked for — and the next load
 * tries again.
 */
export function useSeedProfileTimezone(): void {
  const transport = useTransport();
  const queryClient = useQueryClient();

  const { data: config, isSuccess } = useQuery({
    queryKey: configKeys.current(),
    queryFn: () => transport.getConfig(),
    staleTime: CONFIG_STALE_TIME_MS,
  });

  const profile = config?.profile;
  useEffect(() => {
    if (attempted || !isSuccess || !profile) return;
    // Set: the person's choice, or an earlier seed. Never overwritten.
    if (profile.timezone != null) {
      attempted = true;
      return;
    }
    const zone = browserTimeZone();
    if (!zone) return;
    attempted = true;
    // Called directly rather than through a mutation, so a refusal reaches no
    // app-wide failure handler: nobody asked for this write.
    transport
      .updateConfig({ profile: { timezone: zone } })
      .then(() => queryClient.invalidateQueries({ queryKey: configKeys.all }))
      .catch(() => {});
  }, [isSuccess, profile, transport, queryClient]);
}
