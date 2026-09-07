/**
 * Presentation lookups for the Connections surface: which icon a service tile
 * wears, and the human name of a provider on its setup card. Pure data — no
 * copy in here is a custody disclosure (that copy is always the server's).
 *
 * @module features/connections/lib/presentation
 */
import type { LucideIcon } from 'lucide-react';
import type { ConnectorConnectionSummary } from '@dorkos/shared/connector-resource-schemas';
import {
  Cable,
  Calendar,
  FileText,
  GitPullRequest,
  ListChecks,
  Mail,
  MessageSquare,
  Table,
} from 'lucide-react';

/**
 * Icons for the services people connect most. Anything unknown falls back to
 * {@link FALLBACK_SERVICE_ICON} — a new toolkit never renders blank. Consumed
 * via property access (`SERVICE_ICONS[slug] ?? FALLBACK_SERVICE_ICON`) so the
 * static-components lint can see the references are stable.
 */
export const SERVICE_ICONS: Record<string, LucideIcon> = {
  gmail: Mail,
  slack: MessageSquare,
  github: GitPullRequest,
  notion: FileText,
  linear: ListChecks,
  googlecalendar: Calendar,
  googlesheets: Table,
};

/** The generic icon for a service {@link SERVICE_ICONS} has no glyph for. */
export const FALLBACK_SERVICE_ICON: LucideIcon = Cable;

/** Human names for the known provider types on their setup cards. */
const PROVIDER_NAMES: Record<string, string> = {
  composio: 'Composio',
  nango: 'Nango',
  'test-connector': 'Test connector',
};

/**
 * The human name of a provider type; an unknown type is title-cased rather
 * than shown as a raw slug.
 *
 * @param type - Provider type, e.g. `'composio'`.
 */
export function providerName(type: string): string {
  const known = PROVIDER_NAMES[type];
  if (known) return known;
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/**
 * The one way an account is named everywhere on this surface: the service's
 * display name with the label in parentheses — "Gmail (work)".
 *
 * @param serviceName - The service's display name (or slug when unknown).
 * @param label - The account's user-facing label.
 */
export function accountDisplayName(serviceName: string, label: string): string {
  return label ? `${serviceName} (${label})` : serviceName;
}

/**
 * User-facing state for one canonical stable connection.
 *
 * @param connection - Current lifecycle, authentication, reconciliation, and sync truth.
 * @returns The most actionable account state without treating pending work as ready.
 */
export function connectionStatusLabel(connection: ConnectorConnectionSummary): string {
  if (connection.lifecycle === 'disconnected') return 'Disconnected';
  if (connection.lifecycle === 'paused') return 'Paused';
  if (connection.authenticationStatus === 'pending') return 'Sign-in pending';
  if (connection.authenticationStatus !== 'active') return 'Sign-in needed';
  if (connection.reconciliationStatus !== 'ready') return 'Review needed';
  if (connection.authoritySync.status === 'pending') return 'Syncing';
  if (connection.authoritySync.status === 'failed') return 'Sync failed';
  return 'Ready';
}
