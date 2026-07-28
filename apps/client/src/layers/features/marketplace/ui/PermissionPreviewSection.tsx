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
 * A single permission row with an icon, label, and optional description.
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
}

/**
 * A collapsible permission group with summary count. Returns `null` when
 * `items` is empty so the heading is never orphaned.
 *
 * Uses the native `<details>/<summary>` element for accessible,
 * zero-JS progressive disclosure with CSS transitions.
 */
function PermissionSection({ title, items, tone, defaultOpen }: SectionProps) {
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
        <span className="text-muted-foreground font-normal tracking-normal normal-case">
          ({items.length})
        </span>
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
 * Used by both the package detail sheet and the install confirmation dialog.
 *
 * @param preview - Raw `PermissionPreview` from the server.
 */
export function PermissionPreviewSection({ preview }: PermissionPreviewSectionProps) {
  const groups = formatPermissionPreview(preview);

  return (
    <div className="space-y-6">
      <PermissionSection title="What this package will do" items={groups.effects} />
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
