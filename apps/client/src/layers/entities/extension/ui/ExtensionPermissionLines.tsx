/**
 * What an extension can reach, drawn the same way wherever a person decides
 * about it (DOR-2686): the inbox row, the Settings card and the marketplace
 * install preview.
 *
 * @module entities/extension/ui/ExtensionPermissionLines
 */
import { cn } from '@/layers/shared/lib';
import {
  extensionPermissionLines,
  type ExtensionPermissionAdditions,
  type ExtensionPermissionTone,
  type ExtensionPermissionView,
} from '../lib/permission-lines';

/** Props for {@link ExtensionPermissionLines}. */
export interface ExtensionPermissionLinesProps {
  /** What it declares, or `null` when the server sent nothing (draws nothing). */
  permissions: ExtensionPermissionView | null | undefined;
  /** What its last approval did not cover. A re-ask leads with these. */
  added?: ExtensionPermissionAdditions | null;
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
  'data-testid': testId,
  className,
}: ExtensionPermissionLinesProps) {
  if (!permissions) return null;
  const lines = extensionPermissionLines(permissions, added);
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
