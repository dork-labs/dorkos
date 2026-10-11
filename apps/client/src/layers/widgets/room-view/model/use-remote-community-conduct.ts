import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RemoteCommunityStanding } from '@dorkos/shared/community-views';
import { useTransport } from '@/layers/shared/model';
import { formatResetTime } from '@/layers/shared/lib';
import {
  communityKeys,
  useCommunityContentAuthority,
  withinCommunityContentAuthority,
} from '@/layers/entities/community';

/** Why the person can't post in this channel right now, as far as the space's moderation goes. */
export type ConductHold =
  { kind: 'muted'; until: string } | { kind: 'rules' } | { kind: 'slow'; secondsLeft: number };

/** The refusal codes a space sends when its moderation holds a post (DOR-2768). */
const HOLD_CODES: ReadonlySet<string> = new Set([
  'COMMUNITY_MUTED',
  'COMMUNITY_SLOW_MODE',
  'COMMUNITY_RULES_NOT_ACCEPTED',
]);

/**
 * Whether a refused post was held by the space's moderation rather than lost: a mute, slow
 * mode, or rules not yet accepted.
 *
 * @param cause - What the send threw.
 */
export function isConductHold(cause: unknown): boolean {
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === 'string' && HOLD_CODES.has(code);
}

/** The words for a hold, for the composer's disabled send button. */
export function conductHoldReason(hold: ConductHold, now = new Date()): string {
  if (hold.kind === 'muted')
    return `You’re muted here until ${formatResetTime(hold.until, now) ?? 'later'}.`;
  if (hold.kind === 'rules') return 'Accept this space’s rules to post.';
  return `Slow mode. Post again in ${hold.secondsLeft}s.`;
}

/** What the person's standing in one channel holds, before slow mode's countdown. */
function standingHold(standing: RemoteCommunityStanding | undefined, now: number) {
  if (!standing) return null;
  if (standing.mutedUntil && Date.parse(standing.mutedUntil) > now)
    return { kind: 'muted', until: standing.mutedUntil } as const;
  const { rules } = standing;
  if (rules.text !== null && rules.version > 0 && rules.acceptedVersion < rules.version)
    return { kind: 'rules' } as const;
  return null;
}

/**
 * The connected person's standing in one space channel: their mute, the channel's slow mode,
 * and the rules, with the hold that keeps them from posting now and the means to accept the
 * rules. A post the space held calls {@link UseRemoteCommunityConduct.noteHold}, so the
 * countdown and the rules prompt match what the space just said.
 */
export function useRemoteCommunityConduct({
  community,
  roomId,
  enabled,
  accessFingerprint,
}: {
  community: string;
  roomId: string;
  enabled: boolean;
  accessFingerprint: string;
}) {
  const transport = useTransport();
  const queries = useQueryClient();
  const authority = useCommunityContentAuthority(enabled, accessFingerprint, community);
  const key = authority
    ? ([...communityKeys.room(authority, community, roomId), 'standing'] as const)
    : ([
        ...communityKeys.all,
        'owner',
        'unresolved',
        community,
        'room',
        roomId,
        'standing',
      ] as const);
  const standing = useQuery({
    queryKey: key,
    queryFn: () =>
      withinCommunityContentAuthority(authority!, () =>
        transport.getRemoteCommunityStanding(community, roomId)
      ),
    enabled: enabled && authority !== null,
    staleTime: 30_000,
    retry: false,
    // A mute an owner lifts early opens the composer within a minute, not at the next focus.
    refetchInterval: (query) =>
      query.state.data?.mutedUntil && Date.parse(query.state.data.mutedUntil) > Date.now()
        ? 60_000
        : false,
  });
  const [slowUntil, setSlowUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const mutedUntil = standing.data?.mutedUntil ? Date.parse(standing.data.mutedUntil) : null;
  // Tick each second while a countdown runs, and once more when a mute ends, so the composer
  // opens again without a reload.
  useEffect(() => {
    if (slowUntil !== null && slowUntil > now) {
      const timer = setTimeout(() => setNow(Date.now()), 1_000);
      return () => clearTimeout(timer);
    }
    if (mutedUntil !== null && mutedUntil > now) {
      const timer = setTimeout(() => setNow(Date.now()), Math.min(mutedUntil - now + 50, 2 ** 30));
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [mutedUntil, now, slowUntil]);

  const refetch = standing.refetch;
  const noteHold = useCallback(
    (cause: unknown) => {
      const code = (cause as { code?: unknown } | null)?.code;
      if (code === 'COMMUNITY_SLOW_MODE') {
        // Count down only the wait the space named; without one, sending stays open.
        const waitMs = (cause as { retryAfterMs?: unknown }).retryAfterMs;
        if (typeof waitMs === 'number' && waitMs > 0) {
          setNow(Date.now());
          setSlowUntil(Date.now() + waitMs);
        }
        return;
      }
      void refetch();
    },
    [refetch]
  );

  const accept = useMutation({
    // The rules dialog says what went wrong; a toast as well would say it twice.
    meta: { suppressErrorToast: true },
    mutationFn: (version: number) => transport.acceptRemoteCommunityRules(community, version),
    onSuccess: (rules) => {
      queries.setQueryData<RemoteCommunityStanding>(key, (current) =>
        current ? { ...current, rules } : current
      );
    },
    onError: () => void refetch(),
  });

  const held = standingHold(standing.data, now);
  const slowLeft = slowUntil === null ? 0 : Math.ceil((slowUntil - now) / 1_000);
  const hold: ConductHold | null =
    held ?? (slowLeft > 0 ? { kind: 'slow', secondsLeft: slowLeft } : null);
  return { standing: standing.data, hold, noteHold, accept };
}

/** What {@link useRemoteCommunityConduct} returns. */
export type UseRemoteCommunityConduct = ReturnType<typeof useRemoteCommunityConduct>;
