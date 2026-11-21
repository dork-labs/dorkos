import { cn } from '@/layers/shared/lib';

/** Props for {@link CodeGroups}. */
export interface CodeGroupsProps {
  /** The code to show. */
  code: string;
  /** Extra classes. */
  className?: string;
}

/**
 * A short code split into two halves so it reads and types cleanly, and never
 * wraps mid-group (DOR-4744).
 */
export function CodeGroups({ code, className }: CodeGroupsProps) {
  const half = Math.ceil(code.length / 2);
  return (
    <p
      className={cn(
        'font-mono text-2xl font-semibold tracking-widest whitespace-nowrap',
        className
      )}
      aria-label={code.split('').join(' ')}
    >
      <span>{code.slice(0, half)}</span> <span>{code.slice(half)}</span>
    </p>
  );
}
