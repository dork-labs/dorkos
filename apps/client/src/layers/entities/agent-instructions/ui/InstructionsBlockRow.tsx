/**
 * One block of an agent's instructions: a row that opens to its text.
 *
 * @module entities/agent-instructions/ui/InstructionsBlockRow
 */
import { useState } from 'react';
import { ChevronRight, Lock } from 'lucide-react';
import type { InstructionsBlock } from '@dorkos/shared/agent-instructions-schemas';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { TemplateText } from './TemplateText';

/** Props for {@link InstructionsBlockRow}. */
export interface InstructionsBlockRowProps {
  block: InstructionsBlock;
  /** Labels for the documented variables, by id. */
  labels: ReadonlyMap<string, string>;
  /** Whether this runtime sends some blocks once per conversation (Codex). */
  showDelivery: boolean;
}

/**
 * A rough token count as a person reads it.
 *
 * @param tokens - The estimate.
 */
export function formatTokens(tokens: number): string {
  return `~${tokens.toLocaleString('en-US')}`;
}

/**
 * The row. Closed by default: the list is the map, the text is the detail.
 *
 * @param props - See {@link InstructionsBlockRowProps}.
 */
export function InstructionsBlockRow({ block, labels, showDelivery }: InstructionsBlockRowProps) {
  const [open, setOpen] = useState(false);
  const overrides = block.overrideCount ?? 0;
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-slot="instructions-block"
      data-block-id={block.id}
      data-locked={block.locked ? 'true' : 'false'}
    >
      <CollapsibleTrigger className="focus-ring hover:bg-row-hover flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left transition-colors max-md:min-h-15">
        <ChevronRight
          aria-hidden
          className={cn(
            'text-muted-foreground size-4 shrink-0 transition-transform motion-reduce:transition-none',
            open && 'rotate-90'
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{block.title}</span>
            {block.locked && (
              <Lock aria-label="Locked" className="text-muted-foreground size-3.5 shrink-0" />
            )}
          </span>
          <span className="text-muted-foreground block text-xs">
            {block.conditionNote}
            {showDelivery && block.delivery === 'once' ? ' · Sent once at start' : ''}
          </span>
        </span>
        {block.text !== null && (
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {formatTokens(block.tokens)}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-2 px-4 pb-3">
          {block.text !== null ? (
            <pre
              data-slot="instructions-block-text"
              className="border-border bg-row-group max-h-72 overflow-auto rounded-md border p-3 font-mono text-xs leading-5 whitespace-pre-wrap"
            >
              <TemplateText text={block.text} labels={labels} />
            </pre>
          ) : (
            <p className="text-muted-foreground text-xs">Built each turn from what is happening.</p>
          )}
          <p className="text-muted-foreground text-xs">
            {block.locked
              ? 'Locked. Shown only, for everyone.'
              : `Change it in ${block.editIn ?? 'its file'}.`}{' '}
            From {block.source}.
          </p>
          {overrides > 0 && (
            <p className="text-muted-foreground text-xs">
              {overrides === 1 ? '1 agent overrides this.' : `${overrides} agents override this.`}
            </p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
