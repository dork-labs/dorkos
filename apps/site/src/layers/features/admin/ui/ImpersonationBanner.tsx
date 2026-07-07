'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { adminStopImpersonating, useSession } from '@/lib/auth-client';
import { Button } from '@/layers/shared/ui';

/**
 * A fixed banner shown while the current session is an **impersonation** session
 * (Better Auth stamps `session.impersonatedBy`). It makes the footgun visible
 * everywhere it is mounted and offers a one-click "Stop" that restores the
 * admin's own session. Renders nothing for ordinary sessions.
 */
export function ImpersonationBanner() {
  const router = useRouter();
  const { data } = useSession();
  const [pending, setPending] = useState(false);

  const impersonating = Boolean(
    (data?.session as { impersonatedBy?: string | null } | undefined)?.impersonatedBy
  );
  if (!impersonating) return null;

  async function stop() {
    setPending(true);
    await adminStopImpersonating();
    router.push('/admin');
    router.refresh();
  }

  return (
    <div className="sticky top-0 z-50 flex items-center justify-center gap-3 bg-amber-500 px-4 py-2 text-sm font-medium text-black">
      <span>
        You are impersonating <span className="font-semibold">{data?.user?.email}</span>.
      </span>
      <Button size="sm" variant="outline" onClick={() => void stop()} disabled={pending}>
        {pending ? 'Stopping…' : 'Stop impersonating'}
      </Button>
    </div>
  );
}
