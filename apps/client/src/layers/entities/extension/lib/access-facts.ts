/**
 * What an approval states, in Security's words (Nov 8): for a first run,
 * access, runs as, and network, one line each; for a copy whose files changed
 * since it was allowed, what changed and when.
 *
 * @module entities/extension/lib/access-facts
 */
import type { PendingExtensionApproval } from '@dorkos/shared/extension-approval-schemas';
import { formatRelativeTime } from '@/layers/shared/lib';
import type { ExtensionPermissionView } from './permission-lines';

/** How many changed files a change line names before it counts the rest. */
const NAMED_CHANGED_FILES = 3;

/** One named fact: a label, its sentence, and any hosts it names. */
export interface ExtensionAccessFact {
  /** "Access", "Runs as" or "Network". */
  label: string;
  /** The sentence, without the hosts. */
  value: string;
  /** Hosts it can reach, drawn after `value` and isolated, never cut short. */
  hosts?: readonly string[];
}

/**
 * The permission-line keys these facts already say, so a list drawn beside
 * them leaves those lines out rather than saying them twice.
 */
export const ACCESS_FACT_LINE_KEYS: ReadonlySet<string> = new Set([
  'in-process',
  'separate',
  'net',
  'page',
]);

/**
 * The three facts for what an extension declares.
 *
 * @param permissions - What the extension declares.
 */
export function extensionAccessFacts(permissions: ExtensionPermissionView): ExtensionAccessFact[] {
  const facts: ExtensionAccessFact[] = [];
  if (permissions.runtime === 'in-process') {
    facts.push({
      label: 'Access',
      value:
        permissions.hasServer === false
          ? 'Screens run inside DorkOS, with your access'
          : 'Runs inside DorkOS, with full access to this computer',
    });
  } else {
    facts.push({ label: 'Access', value: 'Runs on its own, apart from DorkOS' });
  }
  facts.push({ label: 'Runs as', value: 'You' });
  if (permissions.runtime === 'subprocess') {
    facts.push(
      permissions.net.length > 0
        ? { label: 'Network', value: 'Can reach', hosts: permissions.net }
        : { label: 'Network', value: 'Reaches nothing on the internet' }
    );
  } else if (permissions.hasServer !== false) {
    facts.push({ label: 'Network', value: 'Can reach anything this computer can' });
  }
  return facts;
}

/**
 * Whether an approval asks about a copy that was allowed before and changed
 * since: its screens are paused until the person looks.
 *
 * @param approval - The waiting copy.
 */
export function isChangedSinceAllowed(
  approval: Pick<PendingExtensionApproval, 'updatedFrom' | 'changedFiles'>
): boolean {
  return approval.updatedFrom !== null || approval.changedFiles !== null;
}

/**
 * What changed and when, as one line: "Version 2.2.1 → 2.3.0 · client.js,
 * extension.json · Noticed 2h ago".
 *
 * @param approval - The waiting copy.
 */
export function approvalChangeLine(
  approval: Pick<PendingExtensionApproval, 'updatedFrom' | 'changedFiles' | 'version' | 'since'>
): string {
  const files = approval.changedFiles ?? [];
  const rest = files.length - NAMED_CHANGED_FILES;
  return [
    approval.updatedFrom ? `Version ${approval.updatedFrom} → ${approval.version}` : null,
    files.length > 0
      ? files.slice(0, NAMED_CHANGED_FILES).join(', ') + (rest > 0 ? ` and ${rest} more files` : '')
      : null,
    `Noticed ${formatRelativeTime(approval.since).toLowerCase()}`,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}
