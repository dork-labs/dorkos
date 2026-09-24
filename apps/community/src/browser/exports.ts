import type {
  CommunityWireExport,
  CommunityWireExportFailureCode,
} from '@dorkos/shared/community-wire';

/** How often the page asks how an export in progress is doing. */
export const EXPORT_POLL_MS = 5_000;
/** How often the page checks that a ready export is still there. */
export const READY_POLL_MS = 60_000;

/**
 * Why a ready export can no longer be downloaded: it expired, or (still within its lifetime)
 * it was deleted because someone in the community erased their data.
 */
export function goneMessage(value: CommunityWireExport, now = new Date()): string {
  if (value.state === 'expired' || (value.expiresAt && new Date(value.expiresAt) <= now))
    return 'This export has expired. Start a new one to download your data.';
  return 'This export is no longer available: it was deleted because someone in this community erased their data. Start a new one.';
}

/** One sentence per reason an export stopped, in the words a person reads. */
export const EXPORT_FAILURE_TEXT: Record<CommunityWireExportFailureCode, string> = {
  EXPORT_TIMED_OUT: 'This export took too long and stopped. Try again.',
  EXPORT_ACCESS_ENDED: 'Your access changed while we were preparing it.',
  EXPORT_CONTENT_CHANGING:
    'The community kept changing while we were preparing it. Try again later.',
  EXPORT_STORAGE_UNAVAILABLE: "We couldn't store the export. Try again later.",
};

/** Whether the page should keep asking about this export. */
export function exportInProgress(value: CommunityWireExport | null): boolean {
  return value?.state === 'queued' || value?.state === 'building';
}

/**
 * The export a panel shows: the newest of its scope that is open, ready, or failed. A cancelled
 * or expired one is history, so the panel offers a fresh export instead.
 */
export function currentExport(
  exports: readonly CommunityWireExport[],
  scope: CommunityWireExport['scope']
): CommunityWireExport | null {
  const latest = exports.find((item) => item.scope === scope);
  return latest && latest.state !== 'cancelled' && latest.state !== 'expired' ? latest : null;
}

/** A file size as people read it: "812 KB", "12.4 GB". Decimal units, as file managers show. */
export function formatSize(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  if (unit === 0) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  return `${value >= 100 ? Math.round(value) : Number(value.toFixed(1))} ${units[unit]}`;
}

/** "Available until 25 Sept, 14:05." in the reader's own locale and time zone. */
export function availableUntil(expiresAt: string, locale?: string): string {
  const when = new Date(expiresAt).toLocaleString(locale, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `Available until ${when}.`;
}
