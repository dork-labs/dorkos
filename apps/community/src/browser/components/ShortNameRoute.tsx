import { useEffect, useState } from 'react';
import type { CommunityWireShortNameLookupSchema } from '@dorkos/shared/community-wire';
import type { z } from 'zod';
import { hostRequest, setShortNameRoute } from '../api.js';
import { CommunityApp } from '../CommunityApp.js';
import { returnToChooserWithNotice } from './CommunityChooser.js';
import { DeletionRecovery } from './DeletionRecovery.js';

type Lookup = z.infer<typeof CommunityWireShortNameLookupSchema>;

/**
 * Open a community by its short address, `/<name>[/...]`. The name is looked up once to find
 * the community's UUID; everything after that uses the UUID. A retired name moves the address
 * bar to the current one, and a name that leads nowhere opens the chooser saying only that.
 */
export function ShortNameRoute({ name, rest }: { name: string; rest: string }) {
  const [resolved, setResolved] = useState<Lookup | null>(null);
  useEffect(() => {
    let current = true;
    void hostRequest<Lookup>(`/api/v1/community-names/${encodeURIComponent(name)}`)
      .then((found) => {
        if (!current) return;
        setShortNameRoute({ communityId: found.communityId, basePath: `/${found.shortName}` });
        if (found.shortName !== name)
          window.history.replaceState(
            null,
            '',
            `/${found.shortName}${rest}${window.location.search}${window.location.hash}`
          );
        setResolved(found);
      })
      .catch(() => {
        if (current) returnToChooserWithNotice('no-address');
      });
    return () => {
      current = false;
    };
  }, [name, rest]);
  if (!resolved)
    return (
      <main className="grid min-h-dvh place-items-center p-5">
        <p role="status">Opening community…</p>
      </main>
    );
  if (rest === '/deletion') return <DeletionRecovery communityId={resolved.communityId} />;
  return <CommunityApp />;
}
