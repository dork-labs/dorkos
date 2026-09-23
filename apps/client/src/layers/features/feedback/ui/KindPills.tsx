import { Bug, Lightbulb, MessageSquare } from 'lucide-react';
import type { FeedbackSubmissionKind } from '@dorkos/shared/telemetry-events';
import { cn } from '@/layers/shared/lib';

/** The three feedback kinds, in the order they appear. */
const KINDS: { value: FeedbackSubmissionKind; label: string; icon: typeof MessageSquare }[] = [
  { value: 'feedback', label: 'Feedback', icon: MessageSquare },
  { value: 'bug', label: 'Bug', icon: Bug },
  { value: 'idea', label: 'Idea', icon: Lightbulb },
];

interface KindPillsProps {
  /** The kind currently chosen. */
  kind: FeedbackSubmissionKind;
  /** Choose another. */
  onChange: (next: FeedbackSubmissionKind) => void;
}

/** Feedback · Bug · Idea, as a radio group of pills at the top of the feedback form. */
export function KindPills({ kind, onChange }: KindPillsProps) {
  return (
    <div role="radiogroup" aria-label="What kind of feedback" className="flex gap-1.5">
      {KINDS.map(({ value, label, icon: Icon }) => {
        const selected = kind === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(value)}
            className={cn(
              'focus-visible:ring-ring flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none',
              selected
                ? 'border-foreground/60 text-foreground bg-muted/60'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {label}
          </button>
        );
      })}
    </div>
  );
}
