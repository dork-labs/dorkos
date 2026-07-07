'use client';

import {
  adminBanUser,
  adminImpersonateUser,
  adminRemoveUser,
  adminRevokeUserSessions,
  adminSetRole,
  adminUnbanUser,
} from '@/lib/auth-client';
import { Badge } from '@/layers/shared/ui';
import type { AdminUserView } from '@/lib/admin-service';

import { AdminAction } from './AdminAction';

/** Format an ISO date as a short calendar date. */
function shortDate(iso: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * One row of the admin users table: identity + status, plus the admin actions
 * for that user. Mutating actions on the admin's **own** row are disabled (you
 * cannot ban, delete, impersonate, revoke, or change your own role from here) so
 * an operator can't lock themselves out.
 *
 * @param props.user - The user to render.
 * @param props.isSelf - Whether this row is the acting admin's own account.
 */
export function UserRow({ user, isSelf }: { user: AdminUserView; isSelf: boolean }) {
  return (
    <div className="flex flex-col gap-3 border-b py-4 last:border-b-0 md:flex-row md:items-center md:justify-between">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{user.email}</span>
          {isSelf ? <Badge variant="secondary">you</Badge> : null}
          {user.role === 'admin' ? <Badge>admin</Badge> : null}
          {user.banned ? <Badge variant="destructive">banned</Badge> : null}
          {!user.emailVerified ? <Badge variant="outline">unverified</Badge> : null}
        </div>
        <span className="text-muted-foreground text-xs">
          {user.name || 'No name'} · joined {shortDate(user.createdAt)}
          {user.banned && user.banReason ? ` · reason: ${user.banReason}` : ''}
        </span>
      </div>

      {isSelf ? (
        <span className="text-muted-foreground text-xs italic">
          actions disabled on your account
        </span>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {user.role === 'admin' ? (
            <AdminAction
              label="Make user"
              title={`Demote ${user.email} to user?`}
              description="Removes admin privileges from this account."
              confirmLabel="Demote"
              onConfirm={() => adminSetRole({ userId: user.id, role: 'user' })}
            />
          ) : (
            <AdminAction
              label="Make admin"
              title={`Promote ${user.email} to admin?`}
              description="Grants full admin privileges (ban, impersonate, delete, set roles)."
              confirmLabel="Promote"
              onConfirm={() => adminSetRole({ userId: user.id, role: 'admin' })}
            />
          )}

          {user.banned ? (
            <AdminAction
              label="Unban"
              title={`Unban ${user.email}?`}
              description="Restores this account's ability to sign in. Their instances must re-link."
              confirmLabel="Unban"
              onConfirm={() => adminUnbanUser({ userId: user.id })}
            />
          ) : (
            <AdminAction
              label="Ban"
              title={`Ban ${user.email}?`}
              description="Blocks sign-in and revokes their sessions and API keys (linked instances go offline). Reversible via Unban."
              confirmLabel="Ban"
              variant="destructive"
              field={{ label: 'Reason (optional)', placeholder: 'e.g. terms violation' }}
              onConfirm={(reason) =>
                adminBanUser({ userId: user.id, ...(reason ? { banReason: reason } : {}) })
              }
            />
          )}

          <AdminAction
            label="Impersonate"
            title={`Impersonate ${user.email}?`}
            description="Signs you into a capped session as this user in this browser. Every use is audited. Use the banner to stop."
            confirmLabel="Impersonate"
            onConfirm={() => adminImpersonateUser({ userId: user.id })}
          />

          <AdminAction
            label="Revoke sessions"
            title={`Revoke all sessions for ${user.email}?`}
            description="Signs this user out of every device. They can sign back in unless also banned."
            confirmLabel="Revoke"
            onConfirm={() => adminRevokeUserSessions({ userId: user.id })}
          />

          <AdminAction
            label="Delete"
            title={`Permanently delete ${user.email}?`}
            description="Irreversibly erases this account and cascades to their sessions, sign-in methods, API keys, and linked instances. This cannot be undone."
            confirmLabel="Delete account"
            variant="destructive"
            typedConfirm={user.email}
            onConfirm={() => adminRemoveUser({ userId: user.id })}
          />
        </div>
      )}
    </div>
  );
}
