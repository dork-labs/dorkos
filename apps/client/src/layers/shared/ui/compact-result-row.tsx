import { cn } from '@/layers/shared/lib/utils';

/** Props for {@link CompactResultRow}. */
export interface CompactResultRowProps extends React.ComponentProps<'div'> {
  /** Status icon (Check, X, etc.). */
  icon: React.ReactNode;
  /** Primary label text or element. */
  label: React.ReactNode;
  /** Optional trailing element (badge, etc.). */
  trailing?: React.ReactNode;
  /** Optional content below the row (e.g. timeout message). */
  children?: React.ReactNode;
}

/** Compact single-row display for decided/submitted final states. */
export function CompactResultRow({
  icon,
  label,
  trailing,
  children,
  className,
  ...props
}: CompactResultRowProps) {
  return (
    <div
      data-slot="compact-result-row"
      className={cn(
        'bg-muted/50 rounded-msg-tool shadow-msg-tool border px-3 py-1 text-sm transition-colors duration-150',
        className
      )}
      {...props}
    >
      <div className="flex items-center gap-2">
        {icon}
        {label}
        {trailing}
      </div>
      {children}
    </div>
  );
}
