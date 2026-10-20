import { Button } from '@dork-labs/ui';
import type { RefObject } from 'react';
import { communityBasePath } from '../api.js';
import { ConnectDorkOS } from '../connect/ConnectDorkOS.js';
import { communityLink } from '../connect/community-link.js';
import type { Community } from '../types.js';

/**
 * The confirmation a person sees once they join a space: open it now, or connect a DorkOS
 * installation as a separate next step. The caller focuses `headingRef` when it appears.
 */
export function MembershipAdded({
  community,
  shortName,
  headingRef,
  onOpen,
}: {
  community: Community;
  /** The space's short name, when it has been read. */
  shortName: string | null;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onOpen: () => void;
}) {
  return (
    <main className="grid min-h-dvh place-items-center p-5">
      <section className="panel max-w-md p-6" aria-labelledby="community-joined-title">
        <p className="eyebrow">Membership added</p>
        <h1 id="community-joined-title" ref={headingRef} tabIndex={-1}>
          You’re in {community.name}.
        </h1>
        <p className="muted">
          Open the space now, or connect a DorkOS installation as a separate next step.
        </p>
        <Button variant="default" onClick={onOpen}>
          Open space
        </Button>
        <ConnectDorkOS
          link={
            shortName
              ? communityLink(window.location.origin, community.id, shortName)
              : // Not read yet for someone who just joined: the name they arrived by, when it
                // leads to this community, otherwise its /c/ address.
                `${window.location.origin}${communityBasePath(community.id)}`
          }
        />
      </section>
    </main>
  );
}
