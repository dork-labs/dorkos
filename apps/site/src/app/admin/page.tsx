import { headers } from 'next/headers';

import { AdminSearch, RecentAudit, UserRow } from '@/layers/features/admin';
import { listUsersForAdmin } from '@/lib/admin-service';
import { getAuth } from '@/lib/auth';
import { requireAdminSession } from '@/lib/auth-session';
import { listAudit } from '@/lib/audit-service';
import { Card, CardContent, CardHeader, CardTitle } from '@/layers/shared/ui';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/admin` — the operator console. Admin-gated at the server (a non-admin is
 * redirected to `/account`, a signed-out visitor to `/signin`), then renders the
 * searchable user table and a recent-activity view of the audit log. All
 * mutations run client-side through the Better Auth `admin` plugin.
 */
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string }>;
}) {
  const session = await requireAdminSession('/admin');
  const { search = '' } = await searchParams;

  const reqHeaders = await headers();
  const [{ users, total }, audit] = await Promise.all([
    listUsersForAdmin(reqHeaders, { search: search || undefined }),
    listAudit(getAuth(), { limit: 25 }),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
        <p className="text-muted-foreground text-sm">
          {total} account{total === 1 ? '' : 's'}
          {search ? ` matching “${search}”` : ''}. Manage roles, access, and lifecycle.
        </p>
      </div>

      <AdminSearch initial={search} />

      <Card>
        <CardContent className="pt-6">
          {users.length === 0 ? (
            <p className="text-muted-foreground text-sm">No users found.</p>
          ) : (
            <div className="flex flex-col">
              {users.map((user) => (
                <UserRow key={user.id} user={user} isSelf={user.id === session.user.id} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Recent activity</CardTitle>
        </CardHeader>
        <CardContent>
          <RecentAudit entries={audit} />
        </CardContent>
      </Card>
    </div>
  );
}
