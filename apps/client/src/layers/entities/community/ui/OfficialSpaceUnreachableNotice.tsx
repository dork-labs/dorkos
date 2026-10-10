import { useEffect, useMemo, useState } from 'react';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import { Notice } from '@/layers/shared/ui';

/**
 * How long the official space must stay unanswered before the line shows. A list read reports a
 * connection as unverified while its re-check is still running, so a moment of it is normal.
 */
export const OFFICIAL_SPACE_UNREACHABLE_AFTER_MS = 5_000;

/**
 * The calm line the official DorkOS space shows while its server is not answering (spec
 * `official-community-space` D13). Nothing is wrong on this computer, so it is information, not
 * an error, and saved messages keep showing underneath. Draws nothing for any other space, while
 * the official one answers, or until it has stayed unanswered for
 * {@link OFFICIAL_SPACE_UNREACHABLE_AFTER_MS}.
 *
 * @param props.connection - The space on screen.
 */
export function OfficialSpaceUnreachableNotice({
  connection,
}: {
  connection: Pick<CommunityConnectionDescriptor, 'official' | 'status' | 'access'>;
}) {
  const unreachable =
    connection.official === true &&
    connection.status === 'connected' &&
    connection.access?.state === 'unverified';
  // One object per unanswered stretch, so a later stretch waits its own full delay.
  const stretch = useMemo(() => (unreachable ? {} : null), [unreachable]);
  const [waited, setWaited] = useState<object | null>(null);
  useEffect(() => {
    if (!stretch) return;
    const timer = setTimeout(() => setWaited(stretch), OFFICIAL_SPACE_UNREACHABLE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [stretch]);
  if (stretch === null || waited !== stretch) return null;
  return (
    <Notice tone="info" role="status" className="m-3" data-testid="official-space-unreachable">
      The DorkOS community isn’t reachable right now. Try again in a few minutes.
    </Notice>
  );
}
