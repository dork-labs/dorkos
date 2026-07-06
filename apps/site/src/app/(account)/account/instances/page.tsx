import type { Metadata } from 'next';

import { InstanceRegistry } from '@/layers/features/instances';
import { getAuth } from '@/lib/auth';
import { requireServerSession } from '@/lib/auth-session';
import { listInstances } from '@/lib/instance-service';

export const metadata: Metadata = {
  title: 'Linked instances',
  description: 'DorkOS instances linked to your account.',
  robots: { index: false, follow: false },
};

/**
 * Always render at request time (also inherited from the `/account` segment
 * guard): the registry reads the live session and queries the account's
 * instances, so it must never be statically prerendered.
 */
export const dynamic = 'force-dynamic';

/**
 * `/account/instances` — the signed-in account's device-linked instance
 * registry. The segment guard has already required a session; the rows are read
 * server-side and handed to the client registry for per-row revocation.
 */
export default async function InstancesPage() {
  const { user } = await requireServerSession('/account/instances');
  const instances = await listInstances(getAuth(), user.id);
  return <InstanceRegistry instances={instances} />;
}
