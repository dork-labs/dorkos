/**
 * The agent instructions viewer (spec `context-viewer` phase 3): the blocks an
 * agent is told, in the order the model reads them, with a switcher for
 * runtime, place and level.
 *
 * One component for both views — Settings › Agent instructions (the
 * template) and the profile's "What this agent knows" (one agent) — so the
 * two read the same way. The server writes every block with the real prompt
 * builders; this only lays them out.
 *
 * @module entities/agent-instructions/ui/InstructionsViewer
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import type { UseQueryResult } from '@tanstack/react-query';
import type {
  InstructionsBlock,
  InstructionsLevel,
  InstructionsPlace,
  InstructionsRuntime,
  InstructionsView,
} from '@dorkos/shared/agent-instructions-schemas';
import {
  CollapsibleFieldCard,
  FieldCard,
  QueryErrorState,
  SegmentedControl,
  SegmentedControlItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@/layers/shared/ui';
import { InstructionsBlockRow, formatTokens } from './InstructionsBlockRow';

/** What the switcher has chosen. No runtime means the default (or the agent's own). */
export interface InstructionsSelection {
  runtime?: InstructionsRuntime;
  place: InstructionsPlace;
  level: InstructionsLevel;
}

const RUNTIMES: { value: InstructionsRuntime; label: string }[] = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'doe', label: 'Doe' },
];

const PLACES: { value: InstructionsPlace; label: string }[] = [
  { value: 'direct', label: 'Direct chat' },
  { value: 'room', label: 'Room' },
  { value: 'task', label: 'Scheduled task' },
];

const LEVELS: { value: InstructionsLevel; label: string }[] = [
  { value: 'ask', label: 'Ask' },
  { value: 'act', label: 'Act' },
  { value: 'autonomy', label: 'Full autonomy' },
];

/** Props for {@link InstructionsViewer}. */
export interface InstructionsViewerProps {
  selection: InstructionsSelection;
  onSelectionChange: (next: InstructionsSelection) => void;
  result: UseQueryResult<InstructionsView>;
  /** One line above the switcher saying what this view is. */
  intro: string;
  /** Controls beside the intro, such as "Preview as…". */
  actions?: ReactNode;
}

/** A section heading above a group: 24px above, 8px to it. */
function SectionHeading({ children }: { children: ReactNode }) {
  return <h3 className="text-muted-foreground mt-6 mb-2 text-xs font-medium">{children}</h3>;
}

/**
 * The viewer.
 *
 * @param props - See {@link InstructionsViewerProps}.
 */
export function InstructionsViewer({
  selection,
  onSelectionChange,
  result,
  intro,
  actions,
}: InstructionsViewerProps) {
  const view = result.data;
  const runtime = selection.runtime ?? view?.runtime ?? 'claude-code';
  const labels = useMemo(
    () => new Map((view?.variables ?? []).map((variable) => [variable.id, variable.label])),
    [view?.variables]
  );
  const session = view?.blocks.filter((block) => block.layer === 'session') ?? [];
  const turn = view?.blocks.filter((block) => block.layer === 'turn') ?? [];
  const showDelivery = runtime === 'codex';
  const [notIncludedOpen, setNotIncludedOpen] = useState(false);

  return (
    <div data-slot="instructions-viewer" className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-muted-foreground min-w-0 flex-1 text-sm">{intro}</p>
        {actions}
      </div>

      <div className="mt-4 space-y-2">
        <SegmentedControl
          aria-label="Runtime"
          value={runtime}
          onValueChange={(value) =>
            onSelectionChange({ ...selection, runtime: value as InstructionsRuntime })
          }
        >
          {RUNTIMES.map((option) => (
            <SegmentedControlItem key={option.value} value={option.value}>
              {option.label}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        <div className="grid grid-cols-2 gap-2">
          <Select
            value={selection.place}
            onValueChange={(value) =>
              onSelectionChange({ ...selection, place: value as InstructionsPlace })
            }
          >
            <SelectTrigger aria-label="Place" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLACES.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={selection.level}
            onValueChange={(value) =>
              onSelectionChange({ ...selection, level: value as InstructionsLevel })
            }
          >
            <SelectTrigger aria-label="Level" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEVELS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {result.isError && !view ? (
        <QueryErrorState
          className="mt-6"
          title="Couldn’t load the instructions"
          description="Check that DorkOS is running, then try again."
          onRetry={() => void result.refetch()}
          isRetrying={result.isFetching}
        />
      ) : !view ? (
        <div className="mt-6 space-y-2" aria-hidden>
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      ) : (
        <div aria-busy={result.isFetching}>
          <ul className="text-muted-foreground mt-4 space-y-1 text-xs">
            {[...view.runtimeNotes, view.levelNote].map((note) => (
              <li key={note} className="flex gap-1.5">
                <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                <span>{note}</span>
              </li>
            ))}
          </ul>

          <SectionHeading>
            Standing instructions · {session.length} blocks · {formatTokens(view.tokens)} tokens
          </SectionHeading>
          <BlockGroup blocks={session} labels={labels} showDelivery={showDelivery} />

          <SectionHeading>Added each turn, when it applies</SectionHeading>
          <BlockGroup blocks={turn} labels={labels} showDelivery={false} />

          {view.notIncluded.length > 0 && (
            <CollapsibleFieldCard
              className="mt-6"
              open={notIncludedOpen}
              onOpenChange={setNotIncludedOpen}
              trigger={`Not included here · ${view.notIncluded.length}`}
            >
              <ul>
                {view.notIncluded.map((block) => (
                  <li key={`${block.layer}:${block.id}`} className="py-2">
                    <span className="text-sm">{block.title}</span>
                    <span className="text-muted-foreground block text-xs">
                      {block.conditionNote}
                    </span>
                  </li>
                ))}
              </ul>
            </CollapsibleFieldCard>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A group of block rows.
 *
 * @param props - The blocks, the variable labels, and whether to show delivery.
 */
function BlockGroup({
  blocks,
  labels,
  showDelivery,
}: {
  blocks: InstructionsBlock[];
  labels: ReadonlyMap<string, string>;
  showDelivery: boolean;
}) {
  return (
    <FieldCard>
      <ol>
        {blocks.map((block) => (
          <li key={`${block.layer}:${block.id}`}>
            <InstructionsBlockRow block={block} labels={labels} showDelivery={showDelivery} />
          </li>
        ))}
      </ol>
    </FieldCard>
  );
}
