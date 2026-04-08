/**
 * Permission preview display for the install confirmation dialog and the
 * package detail sheet. Renders all five permission groups produced by
 * `formatPermissionPreview` — effects, secrets, external hosts, dependencies,
 * and conflicts — collapsing any group that has no items.
 *
 * @module features/marketplace/ui/PermissionPreviewSection
 */
import type { PermissionPreview } from '@dorkos/shared/marketplace-schemas';
import { AlertTriangle, Check, Clock, File, Globe, Key, Puzzle } from 'lucide-react';
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
      <div className="flex-1">
        <span>{item.label}</span>
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
}

/**
 * A labelled permission group. Returns `null` when `items` is empty so the
 * heading is never orphaned.
 */
function PermissionSection({ title, items, tone }: SectionProps) {
  if (items.length === 0) return null;

  return (
    <section className="space-y-2">
      <h4
        className={cn(
          'text-xs font-semibold tracking-wider uppercase',
          tone === 'warning' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
        )}
      >
        {title}
      </h4>
      <ul className="space-y-1.5">
        {items.map((item, index) => (
          // index key is safe here — list is derived from a stable, ordered PermissionPreview
          <PermissionItem key={index} item={item} />
        ))}
      </ul>
    </section>
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
 * install — file effects, secrets required, external hosts, dependencies, and
 * conflicts.
 *
 * Sections with no items render nothing (no orphaned headings). The conflicts
 * section uses amber/warning tone to draw the user's attention.
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
      <PermissionSection title="Secrets required" items={groups.secrets} />
      <PermissionSection title="External hosts" items={groups.hosts} />
      <PermissionSection title="Dependencies" items={groups.dependencies} />
      <PermissionSection title="Conflicts" items={groups.conflicts} tone="warning" />
    </div>
  );
}
