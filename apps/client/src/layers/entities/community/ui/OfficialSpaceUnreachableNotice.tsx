import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import { Notice } from '@/layers/shared/ui';

/**
 * The calm line the official DorkOS space shows while its server is not answering (spec
 * `official-community-space` D13). Nothing is wrong on this computer, so it is information, not
 * an error, and saved messages keep showing underneath. Draws nothing for any other space, or
 * while the official one answers.
 *
 * @param props.connection - The space on screen.
 */
export function OfficialSpaceUnreachableNotice({
  connection,
}: {
  connection: Pick<CommunityConnectionDescriptor, 'official' | 'status' | 'access'>;
}) {
  if (connection.official !== true || connection.status !== 'connected') return null;
  if (connection.access?.state !== 'unverified') return null;
  return (
    <Notice tone="info" role="status" className="m-3" data-testid="official-space-unreachable">
      The DorkOS community isn’t reachable right now. Try again in a few minutes.
    </Notice>
  );
}
