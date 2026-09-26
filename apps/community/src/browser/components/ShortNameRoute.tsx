import { useEffect, useState } from 'react';
import type { CommunityWireShortNameLookupSchema } from '@dorkos/shared/community-wire';
import type { z } from 'zod';
import { describeError, hostRequest, RequestError, setShortNameRoute } from '../api.js';
import { CommunityApp } from '../CommunityApp.js';
import { returnToChooserWithNotice } from './CommunityChooser.js';

type Lookup = z.infer<typeof CommunityWireShortNameLookupSchema>;

/**
 * Open a community by its short address, `/<name>[/...]`. The name is looked up once to find
 * the community's UUID; everything after that uses the UUID. The address bar moves to the
 * current name when a retired one (or another spelling) was used. Only a name the server says
 * leads nowhere opens the chooser with "No community at this address."; being offline, rate
 * limited, or a server that is briefly down offers a retry instead, because the address may be
 * fine.
 */
export function ShortNameRoute({ name, rest }: { name: string; rest: string }) {
  const [resolved, setResolved] = useState<Lookup | null>(null);
  const [failure, setFailure] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setFailure('');
    void hostRequest<Lookup>(`/api/v1/community-names/${encodeURIComponent(name)}`)
      .then((found) => {
        if (!current) return;
        setShortNameRoute({ communityId: found.communityId, basePath: `/${found.shortName}` });
        const path = `/${found.shortName}${rest}`;
        if (window.location.pathname !== path)
          window.history.replaceState(
            null,
            '',
            `${path}${window.location.search}${window.location.hash}`
          );
        setResolved(found);
      })
      .catch((cause: unknown) => {
        if (!current) return;
        if (cause instanceof RequestError && cause.status === 404)
          returnToChooserWithNotice('no-address');
        else setFailure(describeError(cause));
      });
    return () => {
      current = false;
    };
  }, [name, rest, attempt]);
  if (resolved) return <CommunityApp />;
  return (
    <main className="grid min-h-dvh place-items-center p-5">
      {failure ? (
        <div role="alert" className="notice error stack max-w-md">
          <p>Couldn’t open this community. {failure}</p>
          <button type="button" className="button" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      ) : (
        <p role="status">Opening community…</p>
      )}
    </main>
  );
}
