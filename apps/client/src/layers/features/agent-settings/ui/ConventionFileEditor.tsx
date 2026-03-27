import { useCallback } from 'react';
import { Switch, Field, FieldCard, FieldCardContent, FieldLabel } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';

interface ConventionFileEditorProps {
  /** Section title, e.g. "Custom Instructions (SOUL.md)" */
  title: string;
  /** Current file content */
  content: string;
  /** Whether injection is enabled */
  enabled: boolean;
  /** Maximum character count */
  maxChars: number;
  /** Advisory text shown below the header (used for NOPE.md) */
  disclaimer?: string;
  /** Called when content changes */
  onChange: (content: string) => void;
  /** Called when the enable toggle changes */
  onToggle: (enabled: boolean) => void;
}

/**
 * Inline markdown editor for convention files (SOUL.md, NOPE.md).
 * Includes a toggle switch, character count, and optional advisory disclaimer.
 * When toggled off, the editor remains visible (for drafting) but visually dimmed.
 */
export function ConventionFileEditor({
  title,
  content,
  enabled,
  maxChars,
  disclaimer,
  onChange,
  onToggle,
}: ConventionFileEditorProps) {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value);
    },
    [onChange]
  );

  return (
    <FieldCard className={cn(!enabled && 'opacity-60')}>
      <FieldCardContent>
        {/* Header with toggle */}
        <Field orientation="horizontal" className="items-center justify-between">
          <FieldLabel className="text-sm font-medium">{title}</FieldLabel>
          <Switch checked={enabled} onCheckedChange={onToggle} aria-label={`Toggle ${title}`} />
        </Field>

        {/* Disclaimer (NOPE.md) */}
        {disclaimer && <p className="text-muted-foreground text-xs italic">{disclaimer}</p>}

        {/* Textarea */}
        <div className="space-y-2">
          <textarea
            value={content}
            onChange={handleChange}
            rows={8}
            maxLength={maxChars}
            className="border-border bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring w-full resize-none rounded-md border px-3 py-2 font-mono text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            placeholder={enabled ? 'Write markdown content...' : 'Toggle on to enable injection'}
          />
          <p className="text-muted-foreground text-right text-xs">
            {content.length} / {maxChars.toLocaleString()}
          </p>
        </div>
      </FieldCardContent>
    </FieldCard>
  );
}
