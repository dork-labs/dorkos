import { cn } from '@/layers/shared/lib';

/** Props for {@link AgentPreviewCard}. */
export interface AgentPreviewCardProps {
  /** The chosen emoji face. */
  face: string;
  /** The typed name, or empty while blank. */
  name: string;
  /** One honest line describing the job. */
  jobLine: string;
  /** Capability chips derived from the template or offer. */
  capabilities: string[];
  /** Extra classes for the outer card. */
  className?: string;
}

/**
 * The live preview of the agent taking shape (M3, right column). Mirrors the
 * name, face, job line, and capability chips as the person types — a small
 * "here's who you're making" card, not a form.
 *
 * @param props - The face, name, job line, and capability chips to render.
 */
export function AgentPreviewCard({
  face,
  name,
  jobLine,
  capabilities,
  className,
}: AgentPreviewCardProps) {
  const shownName = name.trim() || 'Your agent';
  const isPlaceholder = name.trim().length === 0;

  return (
    <div
      className={cn(
        'bg-card shadow-soft flex flex-col items-center gap-3 rounded-lg border p-5',
        className
      )}
      data-testid="agent-preview"
    >
      <span
        className="bg-primary/10 flex size-16 items-center justify-center rounded-full text-3xl"
        aria-hidden
      >
        {face}
      </span>
      <div className="space-y-1 text-center">
        <p
          className={cn('text-lg font-semibold', isPlaceholder && 'text-muted-foreground')}
          data-testid="preview-name"
        >
          {shownName}
        </p>
        <p className="text-muted-foreground text-sm leading-relaxed">{jobLine}</p>
      </div>
      {capabilities.length > 0 && (
        <div className="flex flex-wrap justify-center gap-1.5" data-testid="preview-capabilities">
          {capabilities.map((cap) => (
            <span
              key={cap}
              className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs"
            >
              {cap}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
