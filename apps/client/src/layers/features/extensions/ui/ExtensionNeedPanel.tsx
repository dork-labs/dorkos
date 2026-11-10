/**
 * The one decision an open row leads with, when its extension needs the
 * person: a title, what it is about, one primary button and at most one more.
 *
 * The two approval panels use Security's words as written (Nov 8). Their
 * buttons are the only way an installed extension gets allowed from this
 * list: the row's switch never approves.
 *
 * @module features/extensions/ui/ExtensionNeedPanel
 */
import { useState, type Ref } from 'react';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import type { PendingExtensionApproval } from '@dorkos/shared/extension-approval-schemas';
import {
  extensionServerErrorCopy,
  isExtensionServerErrorCode,
} from '@dorkos/shared/extension-server-status';
import { Button } from '@/layers/shared/ui';
import { cn, formatRelativeTime } from '@/layers/shared/lib';
import {
  APP_NEEDS_UPDATE_COPY,
  AppNeedsUpdateNotice,
  extensionPermissionLines,
  permissionLineText,
  permissionViewFromRecord,
  approvedSetOf,
  useAddedSinceSeen,
  type ExtensionPermissionView,
} from '@/layers/entities/extension';
import type { ExtensionRowNeed } from '../lib/extension-row-state';

/** Props for {@link ExtensionNeedPanel}. */
export interface ExtensionNeedPanelProps {
  /** The extension record. */
  extension: ExtensionRecordPublic;
  /** Why the row needs the person. */
  need: ExtensionRowNeed;
  /** Its row in the approval queue, when it has one: what changed, and since when. */
  pending?: PendingExtensionApproval;
  /** Allow it to run (the approval). */
  onApprove: () => void;
  /** Whether an approval is being sent. */
  isApproving: boolean;
  /** "Not now" / "Keep paused": changes nothing, closes the row. */
  onDefer: () => void;
  /** Reload extensions, offered for one that stopped working. */
  onReload: () => void;
  /** Whether a reload is in progress. */
  isReloading: boolean;
  /** The panel's primary button, so Review can move focus to it. */
  primaryRef?: Ref<HTMLButtonElement>;
}

/** Panel chrome by tone. Dark uses a quieter tint than the shared tokens. */
const TONE_PANEL = {
  warning: 'bg-status-warning-bg dark:bg-[hsl(40_25%_14%)]',
  error: 'bg-status-error-bg dark:bg-[hsl(0_25%_14%)]',
  neutral: 'bg-muted',
} as const;

/** The panel's tone for each need. */
const NEED_TONE: Record<ExtensionRowNeed, keyof typeof TONE_PANEL> = {
  'screens-paused': 'warning',
  'needs-ok': 'warning',
  'not-working': 'error',
  'cant-load': 'error',
  'needs-update': 'neutral',
  'needs-newer': 'neutral',
};

/** Lines the three named facts already say, left out of the rest. */
const NAMED_LINE_KEYS = new Set(['in-process', 'separate', 'net', 'page']);

/**
 * Access, runs as, and network: one line each, as Security wrote them.
 *
 * @param permissions - What the extension declares.
 */
function namedFacts(permissions: ExtensionPermissionView): Array<[string, string]> {
  const facts: Array<[string, string]> = [];
  if (permissions.runtime === 'in-process') {
    facts.push([
      'Access',
      permissions.hasServer === false
        ? 'Screens run inside DorkOS, with your access'
        : 'Runs inside DorkOS, with full access to this computer',
    ]);
  } else {
    facts.push(['Access', 'Runs on its own, apart from DorkOS']);
  }
  facts.push(['Runs as', 'Runs as you']);
  if (permissions.runtime === 'subprocess') {
    facts.push([
      'Network',
      permissions.net.length > 0
        ? `Can reach ${permissions.net.join(', ')}`
        : 'Reaches nothing on the internet',
    ]);
  } else if (permissions.hasServer !== false) {
    facts.push(['Network', 'Can reach anything this computer can']);
  }
  return facts;
}

/** Why DorkOS can't vouch for an installed copy (spec flow-multiproject §9.1). */
function originProblemCopy(problem: NonNullable<ExtensionRecordPublic['originProblem']>): string {
  if (problem === 'changed') {
    return 'Its files changed after install, so DorkOS can’t vouch for it. Look it over first.';
  }
  if (problem === 'dev-link')
    return 'It runs from your folder, so DorkOS can’t vouch for its source.';
  return 'Its plugin links to files elsewhere, so DorkOS can’t vouch for its source.';
}

/**
 * The decision panel at the top of an open row that needs the person.
 *
 * @param props - {@link ExtensionNeedPanelProps}.
 */
export function ExtensionNeedPanel({
  extension,
  need,
  pending,
  onApprove,
  isApproving,
  onDefer,
  onReload,
  isReloading,
  primaryRef,
}: ExtensionNeedPanelProps) {
  const name = extension.manifest.name;
  const permissions = permissionViewFromRecord(extension);
  // After a stale refusal here, what the redrawn panel lists that the one the
  // person saw did not.
  const addedSinceSeen = useAddedSinceSeen(extension.id, approvedSetOf(permissions));
  const [showLog, setShowLog] = useState(false);

  const panel = (title: string, body: React.ReactNode, testId: string) => (
    <div
      role="group"
      aria-label={title}
      className={cn('space-y-3 rounded-lg p-4', TONE_PANEL[NEED_TONE[need]])}
      data-testid={`${testId}-${extension.id}`}
    >
      <p className="text-sm font-semibold">{title}</p>
      {body}
    </div>
  );

  if (need === 'screens-paused') {
    const changed = [
      pending?.updatedFrom
        ? `Version ${pending.updatedFrom} → ${extension.manifest.version}`
        : null,
      pending?.changedFiles && pending.changedFiles.length > 0
        ? pending.changedFiles.slice(0, 3).join(', ') +
          (pending.changedFiles.length > 3
            ? ` and ${pending.changedFiles.length - 3} more files`
            : '')
        : null,
      pending ? `Noticed ${formatRelativeTime(pending.since).toLowerCase()}` : null,
    ].filter((part): part is string => part !== null);
    return panel(
      `${name}’s files changed since you allowed it. Its screens are paused until you look.`,
      <>
        {changed.length > 0 && (
          <p
            className="text-muted-foreground text-sm"
            data-testid={`extension-changed-${extension.id}`}
          >
            {changed.join(' · ')}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            ref={primaryRef}
            size="sm"
            onClick={onApprove}
            disabled={isApproving}
            data-testid={`extension-approve-run-${extension.id}`}
          >
            Allow the new version
          </Button>
          <Button size="sm" variant="secondary" onClick={onDefer}>
            Keep paused
          </Button>
        </div>
      </>,
      'extension-screens-paused'
    );
  }

  if (need === 'needs-ok') {
    const extra = permissions
      ? extensionPermissionLines(permissions, addedSinceSeen).filter(
          (line) => !NAMED_LINE_KEYS.has(line.key)
        )
      : [];
    return panel(
      `${name} wants to run on this computer.`,
      <>
        {permissions && (
          <dl
            className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm max-sm:grid-cols-1"
            data-testid={`extension-permissions-${extension.id}`}
          >
            {namedFacts(permissions).map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="min-w-0 break-words max-sm:mb-1">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {extra.length > 0 && (
          <ul
            className="space-y-1 text-sm"
            data-testid={`extension-permission-extras-${extension.id}`}
          >
            {extra.map((line) => (
              <li
                key={line.key}
                data-tone={line.tone}
                className={cn(
                  'break-words',
                  line.tone === 'new' && 'font-medium',
                  line.tone === 'warning' && 'text-status-warning-fg',
                  line.tone === 'plain' && 'text-muted-foreground'
                )}
              >
                {permissionLineText(line)}
              </li>
            ))}
          </ul>
        )}
        {extension.originProblem && (
          <p
            className="text-status-warning-fg text-sm"
            data-testid={`extension-origin-problem-${extension.id}`}
          >
            {originProblemCopy(extension.originProblem)}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            ref={primaryRef}
            size="sm"
            onClick={onApprove}
            disabled={isApproving}
            data-testid={`extension-approve-run-${extension.id}`}
          >
            Allow
          </Button>
          <Button size="sm" variant="secondary" onClick={onDefer}>
            Not now
          </Button>
        </div>
      </>,
      'extension-needs-approval'
    );
  }

  if (need === 'not-working') {
    const { error, serverError, status } = extension;
    const sentence =
      serverError && isExtensionServerErrorCode(serverError.code)
        ? serverError.message || extensionServerErrorCopy(serverError.code, name)
        : error
          ? `${status === 'compile_error' ? 'Couldn’t build' : 'Couldn’t start'}: ${error.message}`
          : null;
    const details = serverError?.details ?? error?.details;
    return panel(
      'It stopped working.',
      <>
        {sentence && <p className="text-sm">{sentence}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button ref={primaryRef} size="sm" onClick={onReload} disabled={isReloading}>
            Try again
          </Button>
          {details && (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={showLog}
              onClick={() => setShowLog((open) => !open)}
            >
              {showLog ? 'Hide the log' : 'Show the log'}
            </Button>
          )}
        </div>
        {showLog && details && (
          <pre className="bg-background max-h-40 overflow-auto rounded-md p-2 text-xs">
            {details}
          </pre>
        )}
      </>,
      'extension-not-working'
    );
  }

  if (need === 'needs-update') {
    return (
      <div
        role="group"
        aria-label={APP_NEEDS_UPDATE_COPY.headline(extension.manifest.name)}
        className={cn('rounded-lg p-4', TONE_PANEL.neutral)}
        data-testid={`extension-needs-update-${extension.id}`}
      >
        <AppNeedsUpdateNotice name={extension.manifest.name} />
      </div>
    );
  }

  if (need === 'cant-load') {
    return panel(
      'DorkOS can’t read its manifest.',
      extension.error ? (
        <pre className="font-mono text-xs break-words whitespace-pre-wrap">
          {extension.error.message}
        </pre>
      ) : null,
      'extension-cant-load'
    );
  }

  return panel(
    extension.manifest.minHostVersion
      ? `It needs DorkOS ${extension.manifest.minHostVersion} or newer.`
      : 'It needs a newer DorkOS.',
    null,
    'extension-needs-newer'
  );
}
