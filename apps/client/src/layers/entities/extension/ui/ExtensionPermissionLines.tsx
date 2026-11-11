/**
 * What an extension can reach, drawn the same way wherever a person decides
 * about it (DOR-2686): the inbox row, the Settings card and the marketplace
 * install preview.
 *
 * @module entities/extension/ui/ExtensionPermissionLines
 */
import { useState } from 'react';
import { cn } from '@/layers/shared/lib';
import {
  extensionPermissionLines,
  type ExtensionCalledAppEntry,
  type ExtensionPermissionAdditions,
  type ExtensionPermissionTone,
  type ExtensionPermissionView,
} from '../lib/permission-lines';
import { extensionAccessFacts } from '../lib/access-facts';

/** Props for {@link ExtensionPermissionLines}. */
export interface ExtensionPermissionLinesProps {
  /** What it declares, or `null` when the server sent nothing (draws nothing). */
  permissions: ExtensionPermissionView | null | undefined;
  /** What its last approval did not cover. A re-ask leads with these. */
  added?: ExtensionPermissionAdditions | null;
  /** Line keys to leave out, because something beside the list says them. */
  omit?: ReadonlySet<string>;
  /** Test id for the list. */
  'data-testid'?: string;
  /** Chrome for the list. */
  className?: string;
}

const TONE_CLASS: Record<ExtensionPermissionTone, string> = {
  plain: 'text-muted-foreground',
  new: 'text-foreground font-medium',
  warning: 'text-status-warning-fg',
};

/**
 * "Runs separately from DorkOS.", "Can connect to: …", "Can run: …" and the
 * rest, one line each, or "Runs inside DorkOS with full access to this
 * computer." for an extension that runs inside. A re-ask leads with what is
 * new ("Now also wants to connect to: …"). Hosts and programs are listed in
 * full and wrap, never cut short: a hidden host is a host nobody agreed to.
 *
 * @param props - What it declares, and what is new since the last yes.
 */
export function ExtensionPermissionLines({
  permissions,
  added,
  omit,
  'data-testid': testId,
  className,
}: ExtensionPermissionLinesProps) {
  if (!permissions) return null;
  const lines = extensionPermissionLines(permissions, added).filter((line) => !omit?.has(line.key));
  if (lines.length === 0) return null;
  return (
    <ul
      className={cn('space-y-1 text-xs', className)}
      data-slot="extension-permission-lines"
      data-testid={testId}
    >
      {lines.map((line) => (
        <li
          key={line.key}
          data-line={line.key}
          data-tone={line.tone}
          className={cn('min-w-0 break-words', TONE_CLASS[line.tone])}
        >
          {line.parts.map((part, index) =>
            typeof part === 'string' ? (
              part
            ) : (
              // A name the author chose, isolated so it cannot reorder the copy.
              <bdi key={index} className="font-mono break-all">
                {part.name}
              </bdi>
            )
          )}
          {line.apps && <CalledAppRows apps={line.apps} />}
          {line.items && (
            <>
              {' '}
              <span className="text-foreground font-mono break-all">
                {line.items.map((item, index) => (
                  <span key={`${index}:${item}`}>
                    {index > 0 && ', '}
                    <bdi>{item}</bdi>
                  </span>
                ))}
              </span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/** How many other apps show before "and N more". */
const APPS_SHOWN = 4;

/**
 * One row per other app: its name in bold, then what it shares, and "New" on
 * an app the last yes did not cover. Past four, "and N more" opens the rest
 * in place.
 *
 * @param props - The rows.
 */
function CalledAppRows({ apps }: { apps: readonly ExtensionCalledAppEntry[] }) {
  const [open, setOpen] = useState(false);
  const shown = open ? apps : apps.slice(0, APPS_SHOWN);
  const hidden = apps.length - shown.length;
  return (
    <ul className="mt-1 space-y-0.5 pl-3" data-slot="called-apps">
      {shown.map((app) => (
        <li key={app.id} data-app={app.id} data-new={app.isNew || undefined}>
          <bdi className="text-foreground font-semibold">{app.name}</bdi> · {app.detail}
          {app.isNew && (
            <span className="text-foreground ml-1.5 rounded-sm border px-1 text-[10px] font-medium">
              New
            </span>
          )}
        </li>
      ))}
      {hidden > 0 && (
        <li>
          <button
            type="button"
            className="text-foreground underline-offset-2 hover:underline"
            onClick={() => setOpen(true)}
          >
            and {hidden} more
          </button>
        </li>
      )}
    </ul>
  );
}

/** Props for {@link ExtensionAccessFacts}. */
export interface ExtensionAccessFactsProps {
  /** What it declares. */
  permissions: ExtensionPermissionView;
  /** Test id for the list. */
  'data-testid'?: string;
  /** Chrome for the list. */
  className?: string;
}

/**
 * Access, runs as, and network, one line each (Security's words, Nov 8).
 * Hosts are listed in full and isolated, like every other permission line.
 *
 * @param props - What it declares.
 */
export function ExtensionAccessFacts({
  permissions,
  'data-testid': testId,
  className,
}: ExtensionAccessFactsProps) {
  return (
    <dl
      className={cn(
        'grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs max-sm:grid-cols-1',
        className
      )}
      data-slot="extension-access-facts"
      data-testid={testId}
    >
      {extensionAccessFacts(permissions).map((fact) => (
        <div key={fact.label} className="contents">
          <dt className="text-muted-foreground">{fact.label}</dt>
          <dd className="min-w-0 break-words max-sm:mb-1">
            {fact.value}
            {fact.hosts && (
              <>
                {' '}
                {/* On a phone the hosts take their own line, and a host only
                    ever wraps at a dot, never mid-word. */}
                <span className="font-mono max-sm:block">
                  {fact.hosts.map((host, index) => (
                    <span key={`${index}:${host}`}>
                      {index > 0 && ', '}
                      <bdi>
                        {host.split('.').map((label, part) => (
                          <span key={part}>
                            {part > 0 && (
                              <>
                                .<wbr />
                              </>
                            )}
                            {label}
                          </span>
                        ))}
                      </bdi>
                    </span>
                  ))}
                </span>
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
