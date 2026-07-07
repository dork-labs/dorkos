/**
 * Server-side reads for the `/admin` console (cloud-account-management, DOR-193).
 *
 * Thin wrappers over the Better Auth `admin` plugin's server API for
 * server-component rendering. Every call passes the request `headers` so Better
 * Auth's `adminMiddleware` re-checks the caller is an admin — the `/admin` route
 * guard (`requireAdminSession`) and this per-call check are defense in depth.
 * Mutations are done from the client via the `authClient.admin.*` wrappers.
 *
 * @module lib/admin-service
 */
import { getAuth } from '@/lib/auth';

/** One row in the admin users table (secrets never included). */
export interface AdminUserView {
  id: string;
  email: string;
  name: string;
  role: string;
  banned: boolean;
  banReason: string | null;
  banExpires: string | null;
  emailVerified: boolean;
  createdAt: string;
}

/** The paginated result of {@link listUsersForAdmin}. */
export interface AdminUserPage {
  users: AdminUserView[];
  total: number;
}

/** A raw user row as the admin plugin returns it. */
interface RawAdminUser {
  id: string;
  email: string;
  name: string;
  role?: string | null;
  banned?: boolean | null;
  banReason?: string | null;
  banExpires?: Date | string | null;
  emailVerified?: boolean | null;
  createdAt?: Date | string | null;
}

/** Coerce a stored timestamp (Date or ISO string) to an ISO string, or null. */
function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * List DorkOS accounts for the console, optionally filtered by an email/name
 * search. `search` is matched with a `contains` operator against email.
 *
 * @param reqHeaders - The incoming request headers (carry the admin session).
 * @param args.search - Optional email/name substring filter.
 * @param args.limit - Page size (default 50).
 * @param args.offset - Rows to skip (default 0).
 */
export async function listUsersForAdmin(
  reqHeaders: Headers,
  args: { search?: string; limit?: number; offset?: number } = {}
): Promise<AdminUserPage> {
  const query: Record<string, unknown> = {
    limit: args.limit ?? 50,
    offset: args.offset ?? 0,
    sortBy: 'createdAt',
    sortDirection: 'desc',
  };
  if (args.search) {
    query.searchValue = args.search;
    query.searchField = 'email';
    query.searchOperator = 'contains';
  }

  const result = (await getAuth().api.listUsers({
    query: query as never,
    headers: reqHeaders,
  })) as { users: RawAdminUser[]; total?: number };

  return {
    total: result.total ?? result.users.length,
    users: result.users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role ?? 'user',
      banned: u.banned === true,
      banReason: u.banReason ?? null,
      banExpires: toIso(u.banExpires),
      emailVerified: u.emailVerified === true,
      createdAt: toIso(u.createdAt) ?? '',
    })),
  };
}
