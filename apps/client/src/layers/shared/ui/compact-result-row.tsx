interface CompactResultRowProps {
  /** Status icon (Check, X, etc.). */
  icon: React.ReactNode;
  /** Primary label text or element. */
  label: React.ReactNode;
  /** Optional trailing element (badge, etc.). */
  trailing?: React.ReactNode;
  /** Optional content below the row (e.g. timeout message). */
  children?: React.ReactNode;
  'data-testid'?: string;
  [key: `data-${string}`]: string | undefined;
}

/** Compact single-row display for decided/submitted final states. */
export function CompactResultRow({
  icon,
  label,
  trailing,
  children,
  ...dataProps
}: CompactResultRowProps) {
  return (
    <div
      className="bg-muted/50 rounded-msg-tool shadow-msg-tool border px-3 py-1 text-sm transition-all duration-150"
      {...dataProps}
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
