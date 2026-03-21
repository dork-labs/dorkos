import { cn } from '@/layers/shared/lib';

/** Severity level for exception indicators on subsystem cards. */
type ExceptionSeverity = 'warning' | 'error';

const EXCEPTION_COLORS: Record<ExceptionSeverity, string> = {
  warning: 'text-amber-600 dark:text-amber-500',
  error: 'text-red-600 dark:text-red-500',
} as const;

interface SubsystemCardProps {
  title: string;
  /** Primary metric line, e.g. "3 schedules". */
  primaryMetric: string;
  /** Secondary info line, e.g. "Next: 47m" or "Tg · Slack". */
  secondaryInfo?: string;
  /** Exception indicator shown only when count > 0. */
  exception?: { count: number; label: string; severity: ExceptionSeverity };
  /** When true, shows a muted "Disabled" label instead of metric data. */
  disabled?: boolean;
  onClick: () => void;
}

/**
 * Clickable subsystem health card used in the System Status row.
 * Shows primary metric, optional secondary info, and conditional exception count.
 */
export function SubsystemCard({
  title,
  primaryMetric,
  secondaryInfo,
  exception,
  disabled = false,
  onClick,
}: SubsystemCardProps) {
  return (
    <button
      type="button"
      className="bg-card shadow-soft card-interactive w-full cursor-pointer rounded-xl border p-4 text-left"
      onClick={onClick}
    >
      <p
        className={cn(
          'text-sm font-medium',
          disabled ? 'text-muted-foreground/50' : 'text-foreground'
        )}
      >
        {title}
      </p>
      {disabled ? (
        <p className="text-muted-foreground/50 mt-1 text-xs">Disabled</p>
      ) : (
        <>
          <p className="text-muted-foreground mt-1 text-xs">{primaryMetric}</p>
          {secondaryInfo && <p className="text-muted-foreground mt-0.5 text-xs">{secondaryInfo}</p>}
          {exception && exception.count > 0 && (
            <p className={cn('mt-1 text-xs', EXCEPTION_COLORS[exception.severity])}>
              {exception.count} {exception.label}
            </p>
          )}
        </>
      )}
    </button>
  );
}
