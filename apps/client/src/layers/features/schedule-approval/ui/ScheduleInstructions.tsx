import { ChevronRight } from 'lucide-react';
import type { Task } from '@dorkos/shared/types';
import { cn } from '@/layers/shared/lib';
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/layers/shared/ui';
import { ScheduleRunPermissions } from './ScheduleRunPermissions';

const SCROLL_EDGE_SHADOW = [
  '[background-color:hsl(var(--muted)/0.6)]',
  '[background-image:linear-gradient(hsl(var(--muted))_30%,transparent),linear-gradient(transparent,hsl(var(--muted))_70%),radial-gradient(farthest-side_at_50%_0,rgb(0_0_0/0.14),transparent),radial-gradient(farthest-side_at_50%_100%,rgb(0_0_0/0.14),transparent)]',
  '[background-position:top,bottom,top,bottom]',
  '[background-repeat:no-repeat]',
  '[background-size:100%_2rem,100%_2rem,100%_0.6rem,100%_0.6rem]',
  '[background-attachment:local,local,scroll,scroll]',
].join(' ');
/** Exact instructions and the mode, shared by every schedule review surface. */
export function ScheduleInstructions({
  task,
  attestsFile,
  revealed,
  setRevealed,
  compact,
  selectedMode,
  currentLabel,
  runtime,
  flowing = false,
  hidePermissions = false,
}: {
  task: Task;
  attestsFile: boolean;
  revealed: boolean;
  setRevealed: (open: boolean) => void;
  compact: boolean;
  selectedMode: string;
  currentLabel: string;
  runtime: string | null;
  flowing?: boolean;
  hidePermissions?: boolean;
}) {
  return (
    <>
      {/* Progressive disclosure, collapsed by default: the exact instructions are
          what a careful reader checks and a wall of prompt on every card is what
          stops anybody reading any of them. */}
      {attestsFile ? (
        // Its yes approves this task's file, so the whole prompt is in front of
        // the person, with no toggle, and scrolls inside its block when long
        // (DOR-3703, M4 and the designer's round 8b look).
        <div className="flex min-w-0 flex-col gap-1.5">
          {/* Never omitted, and never the smallest thing on the card. How much
              power an unattended run has is the most consequential fact here —
              it is half of what is being approved — so it reads at the
              card's body size, beside the instructions rather than behind them.
              A mode that acts without asking says so in words: the mode's NAME
              is not something a person should have to already know the meaning
              of. `isBypassPermissionMode` answers from the id, which is the
              fallback for the frames before the runtime's profile lands; it
              knows every bypass mode the shipped runtimes have. */}
          {!hidePermissions && (
            <ScheduleRunPermissions
              mode={selectedMode}
              label={currentLabel}
              runtime={runtime}
              showLabel={!flowing}
            />
          )}
          <pre
            data-slot="schedule-prompt"
            role="region"
            aria-label="Prompt"
            // A region that scrolls must take focus, or a keyboard can never read
            // its end (WCAG 2.1.1); it is a landmark, not a control.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={flowing ? undefined : 0}
            className={cn(
              'text-foreground/90 rounded-md p-2 font-sans text-sm break-words whitespace-pre-wrap',
              !flowing && [
                'focus-ring overflow-auto',
                compact ? 'max-h-[25dvh] sm:max-h-40' : 'max-h-[40dvh] sm:max-h-64',
                SCROLL_EDGE_SHADOW,
              ]
            )}
          >
            {task.prompt}
          </pre>
        </div>
      ) : (
        <Collapsible open={revealed} onOpenChange={setRevealed}>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                data-slot="schedule-reveal"
                className="text-muted-foreground hover:text-foreground -ml-2 h-6 px-2 text-xs"
              >
                <ChevronRight
                  className={cn('size-3.5 transition-transform', revealed && 'rotate-90')}
                  aria-hidden
                />
                {revealed ? 'Hide exact instructions' : 'Show exact instructions'}
              </Button>
            </CollapsibleTrigger>
            {/* Never omitted, and never the smallest thing on the card. How much
                power an unattended run has is the most consequential fact here —
                it is half of what is being approved — so it reads at the
                card's body size, beside the instructions rather than behind them.
                A mode that acts without asking says so in words: the mode's NAME
                is not something a person should have to already know the meaning
                of. `isBypassPermissionMode` answers from the id, which is the
                fallback for the frames before the runtime's profile lands; it
                knows every bypass mode the shipped runtimes have. */}
            {!hidePermissions && (
              <ScheduleRunPermissions
                mode={selectedMode}
                label={currentLabel}
                runtime={runtime}
                showLabel={!flowing}
              />
            )}
          </div>
          <CollapsibleContent>
            <pre
              data-slot="schedule-prompt"
              className="bg-muted/60 text-foreground/90 text-2xs mt-1.5 max-h-48 overflow-auto rounded-md p-2 font-mono break-words whitespace-pre-wrap"
            >
              {task.prompt}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}
    </>
  );
}
