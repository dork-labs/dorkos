/**
 * Permission preview display for the install confirmation dialog and the
 * package detail sheet. Renders every permission group produced by
 * `formatPermissionPreview` — effects, shell commands, scheduled jobs, secrets,
 * external hosts, dependencies, and conflicts — collapsing any group that has
 * no items.
 *
 * @module features/marketplace/ui/PermissionPreviewSection
 */
import type { PermissionPreview } from '@dorkos/shared/marketplace-schemas';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Clock,
  File,
  Globe,
  Key,
  Puzzle,
  Terminal,
} from 'lucide-react';
import type { ComponentType } from 'react';

import { cn } from '@/layers/shared/lib';
import {
  formatPermissionPreview,
  type FormattedPermission,
  type PermissionDetailItem,
  type PermissionSeverity,
} from '../lib/format-permissions';

// ---------------------------------------------------------------------------
// Icon resolution
// ---------------------------------------------------------------------------

/** Map from icon string keys (as returned by `formatPermissionPreview`) to lucide components. */
const ICON_MAP: Record<
  string,
  ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>
> = {
  file: File,
  puzzle: Puzzle,
  clock: Clock,
  terminal: Terminal,
  key: Key,
  globe: Globe,
  check: Check,
  // formatPermissionPreview uses 'alert-triangle' (not 'alert') for warnings/errors
  'alert-triangle': AlertTriangle,
};

// ---------------------------------------------------------------------------
// Severity → className mapping
// ---------------------------------------------------------------------------

const SEVERITY_CLASS: Record<PermissionSeverity, string> = {
  info: 'text-muted-foreground',
  warning: 'text-amber-600 dark:text-amber-400',
  error: 'text-destructive',
};

// ---------------------------------------------------------------------------
// Internal sub-components
// ---------------------------------------------------------------------------

/**
 * The expandable path list on a row. A native `<details>` gives keyboard and
 * screen-reader access for free, and the list scrolls inside a fixed height so
 * a plugin with a hundred-plus files never pushes the Install button off the
 * dialog.
 *
 * @param items - Detail lines to reveal.
 * @param label - Text of the disclosure trigger.
 */
function PermissionDetails({ items, label }: { items: PermissionDetailItem[]; label: string }) {
  return (
    <details className="group/details mt-1.5">
      <summary
        className={cn(
          'text-muted-foreground hover:text-foreground focus-ring inline-flex cursor-pointer',
          'list-none items-center gap-1 rounded-sm text-xs select-none',
          '[&::-webkit-details-marker]:hidden'
        )}
      >
        <ChevronRight className="size-3 shrink-0 transition-transform duration-200 group-open/details:rotate-90" />
        {label}
      </summary>
      <ul className="bg-muted/40 mt-1.5 max-h-64 space-y-0.5 overflow-y-auto rounded-md p-2">
        {items.map((detail, index) => (
          <li key={index} className="flex items-baseline gap-2 font-mono text-[11px]">
            {detail.tag && (
              <span
                className={cn(
                  'w-14 shrink-0',
                  detail.severity ? SEVERITY_CLASS[detail.severity] : SEVERITY_CLASS.info
                )}
              >
                {detail.tag}
              </span>
            )}
            <span className="text-foreground min-w-0 break-all" data-testid="file-change-path">
              {detail.text}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * A single permission row with an icon, label, optional description, and an
 * optional inline disclosure holding its detail lines.
 *
 * @param item - The formatted permission row to display.
 */
function PermissionItem({ item }: { item: FormattedPermission }) {
  const Icon = ICON_MAP[item.icon] ?? File;
  const colorClass = item.severity ? SEVERITY_CLASS[item.severity] : SEVERITY_CLASS.info;

  return (
    <li className={cn('flex items-start gap-2 text-sm', colorClass)}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        {item.mono ? (
          <code className="bg-muted text-foreground block rounded px-1.5 py-1 font-mono text-xs break-all">
            {item.label}
          </code>
        ) : (
          <span>{item.label}</span>
        )}
        {item.description && (
          <p className="text-muted-foreground mt-0.5 text-xs">{item.description}</p>
        )}
        {item.details && item.details.length > 0 && (
          <PermissionDetails items={item.details} label={item.detailsLabel ?? 'Show details'} />
        )}
      </div>
    </li>
  );
}

interface SectionProps {
  title: string;
  items: FormattedPermission[];
  /** When `'warning'`, the section heading uses amber/warning colour. */
  tone?: 'warning';
  /** Start expanded. Defaults to true for sections with ≤3 items. */
  defaultOpen?: boolean;
  /**
   * Drop the row count from the heading. Set for the effects section, whose
   * rows are summary sentences: "What this package will do (2)" alongside a row
   * reading "135 files" invites the reader to think two files are involved.
   */
  hideCount?: boolean;
}

/**
 * A collapsible permission group with summary count. Returns `null` when
 * `items` is empty so the heading is never orphaned.
 *
 * Uses the native `<details>/<summary>` element for accessible,
 * zero-JS progressive disclosure with CSS transitions.
 */
function PermissionSection({ title, items, tone, defaultOpen, hideCount }: SectionProps) {
  if (items.length === 0) return null;

  const open = defaultOpen ?? items.length <= 3;

  return (
    <details open={open} className="group/perm">
      <summary
        className={cn(
          'flex cursor-pointer list-none items-center gap-2 text-xs font-semibold tracking-wider uppercase',
          'select-none [&::-webkit-details-marker]:hidden',
          tone === 'warning' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
        )}
      >
        <ChevronRight className="size-3 shrink-0 transition-transform duration-200 group-open/perm:rotate-90" />
        {title}
        {!hideCount && (
          <span className="text-muted-foreground font-normal tracking-normal normal-case">
            ({items.length})
          </span>
        )}
      </summary>
      <ul className="mt-2 space-y-1.5">
        {items.map((item, index) => (
          <PermissionItem key={index} item={item} />
        ))}
      </ul>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

interface PermissionPreviewSectionProps {
  /** Raw permission preview as returned by the server preview endpoint. */
  preview: PermissionPreview;
  /**
   * The folder this install targets — the DorkOS data directory for a global
   * install, the project's `.dork` folder for an agent-local one. Given it, the
   * effects section says whether every file stays inside. Omit it and no
   * containment claim is made, because an unchecked reassurance is worse than
   * none.
   */
  installBase?: string;
}

/**
 * Renders a full, human-readable breakdown of everything a package will do on
 * install: file effects, shell commands it declares, scheduled jobs it
 * creates, secrets required, external hosts, dependencies, and conflicts.
 *
 * The commands heading says "declares", not "will run". A package's
 * `hooks/hooks.json` only reaches a settings file when the package is
 * project-scoped AND of type plugin or skill-pack, and the cockpit's default
 * install scope is global — so "will run" would over-claim in the common case.
 * The declaration is real either way (the file lands on disk, and a later
 * project-scoped install would run it), so the honest verb is the weaker one.
 *
 * Sections with no items render nothing (no orphaned headings), so a package
 * that declares no commands and schedules no jobs shows no empty promise of
 * either. The commands and conflicts sections start expanded and use
 * amber/warning tone where relevant, because they are what a person needs to
 * see before trusting a stranger's package.
 *
 * The effects section names the folder the files land in, counts each action
 * separately, and puts every path behind a disclosure. A file count on its own
 * is not consent: the thing a person most needs before approving an install is
 * which existing files disappear, and that is the first group in the list.
 *
 * Used by both the package detail sheet and the install confirmation dialog.
 *
 * @param preview - Raw `PermissionPreview` from the server.
 * @param installBase - Folder the install targets, when the caller knows it.
 */
export function PermissionPreviewSection({ preview, installBase }: PermissionPreviewSectionProps) {
  const groups = formatPermissionPreview(preview, { installBase });

  return (
    <div className="space-y-6">
      <PermissionSection title="What this package will do" items={groups.effects} hideCount />
      <PermissionSection
        title="Commands this package declares"
        items={groups.commands}
        defaultOpen
      />
      <PermissionSection title="Jobs it will schedule" items={groups.schedules} defaultOpen />
      <PermissionSection title="Secrets required" items={groups.secrets} />
      <PermissionSection title="External hosts" items={groups.hosts} />
      <PermissionSection title="Dependencies" items={groups.dependencies} />
      <PermissionSection title="Conflicts" items={groups.conflicts} tone="warning" />
    </div>
  );
}
