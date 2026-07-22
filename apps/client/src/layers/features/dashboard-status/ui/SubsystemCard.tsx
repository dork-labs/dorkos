import { cn } from '@/layers/shared/lib';

/** Severity level for exception indicators on subsystem cards. */
type ExceptionSeverity = 'warning' | 'error';

const EXCEPTION_COLORS: Record<ExceptionSeverity, string> = {
  warning: 'text-amber-600 dark:text-amber-500',
  error: 'text-red-600 dark:text-red-500',
} as const;

interface SubsystemCardProps {
  /** Outcome headline — the primary line, e.g. "Connected to Telegram". */
  outcome: string;
  /** Small caption naming the subsystem for operators, e.g. "Relay". */
  caption?: string;
  /** Optional extra detail line, e.g. "Next run in 47m". */
  detail?: string;
  /** Exception indicator shown only when count > 0. */
  exception?: { count: number; label: string; severity: ExceptionSeverity };
  /** When true, shows a muted "Disabled" label instead of the outcome. */
  disabled?: boolean;
  onClick: () => void;
}

/**
 * Clickable subsystem health card used in the System Status row. Leads with an
 * operator outcome, with the internal subsystem name kept as a small caption.
 */
export function SubsystemCard({
  outcome,
  caption,
  detail,
  exception,
  disabled = false,
  onClick,
}: SubsystemCardProps) {
  return (
    <button
      type="button"
      className="bg-card shadow-soft card-interactive flex h-full w-full cursor-pointer flex-col items-start rounded-xl border p-4 text-left"
      onClick={onClick}
    >
      {caption && (
        <p
          className={cn(
            'text-[0.65rem] font-medium tracking-widest uppercase',
            disabled ? 'text-muted-foreground/50' : 'text-muted-foreground'
          )}
        >
          {caption}
        </p>
      )}
      {disabled ? (
        <p className="text-muted-foreground/50 mt-1 text-sm font-medium">Disabled</p>
      ) : (
        <>
          <p className="text-foreground mt-1 text-sm font-medium">{outcome}</p>
          {detail && <p className="text-muted-foreground mt-0.5 text-xs">{detail}</p>}
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
