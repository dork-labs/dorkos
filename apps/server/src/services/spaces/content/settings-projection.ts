import { ApiError } from '../http.js';

/** A space's settings row, as `GET /settings` and every settings change read it. */
export interface SettingsRow {
  id: string;
  name: string;
  description: string | null;
  admission_policy: 'invite_only' | 'closed' | 'open';
  icon_blob_key: string | null;
  icon_content_type: string | null;
  settings_version: number;
  lifecycle: 'pending_owner' | 'active' | 'archived' | 'suspended' | 'held' | 'deletion_pending';
  lifecycle_version: number;
}

/** The settings a member reads: no storage key, no account, no credential. */
export function projectSettings(row: SettingsRow) {
  return {
    communityId: row.id,
    name: row.name,
    description: row.description,
    admissionPolicy: row.admission_policy,
    hasIcon: row.icon_blob_key !== null,
    settingsVersion: row.settings_version,
    lifecycle: row.lifecycle,
    lifecycleVersion: row.lifecycle_version,
  };
}

/** The settings version an `If-Match` header names, or null when it names none. */
export function parseIfMatch(value: string | undefined): number | null {
  const match = value?.match(/^(?:W\/)?"?(\d+)"?$/);
  if (!match) return null;
  return Number(match[1]);
}

/** The `ETag` a settings version is sent with. */
export function settingsEtag(version: number): string {
  return `"${version}"`;
}

/** Refuse a settings read in a lifecycle that has nothing to show. */
export function assertReadableLifecycle(row: SettingsRow): void {
  if (row.lifecycle === 'suspended') {
    throw new ApiError(503, 'COMMUNITY_SUSPENDED', 'This space is suspended.');
  }
  if (row.lifecycle === 'deletion_pending') {
    throw new ApiError(423, 'COMMUNITY_DELETION_PENDING', 'This space is being deleted.');
  }
  if (row.lifecycle === 'pending_owner') {
    throw new ApiError(403, 'FORBIDDEN', 'This space has no owner.');
  }
}
