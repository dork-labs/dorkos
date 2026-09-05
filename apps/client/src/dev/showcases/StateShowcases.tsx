import { Inbox, PackageSearch } from 'lucide-react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  Button,
  Card,
  DetailRow,
  EmptyState,
  QueryErrorState,
  RemovableChip,
  Spinner,
} from '@/layers/shared/ui';

/**
 * The five shells every panel reaches for: nothing here, it broke, a fact,
 * a dismissible pill, and "hold on".
 *
 * Each one replaced a pile of hand-written copies (DOR-1763), so this page is
 * where a drift between two of them would show up first.
 */
export function StateShowcases() {
  return (
    <>
      <PlaygroundSection
        title="EmptyState"
        description="One shape for every 'nothing here yet' panel: a glyph, a short headline, one supporting line, and a way out when there is one."
      >
        <ShowcaseLabel>Plain</ShowcaseLabel>
        <ShowcaseDemo>
          <EmptyState
            icon={Inbox}
            headline="No messages yet"
            description="Anything your agents send you lands here."
          />
        </ShowcaseDemo>

        <ShowcaseLabel>With an action</ShowcaseLabel>
        <ShowcaseDemo>
          <EmptyState
            icon={PackageSearch}
            headline="No packages match your filters"
            description="Try adjusting your search or category filters."
            action={{ label: 'Reset filters', onClick: () => {}, variant: 'outline' }}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>With a faded preview of the filled state</ShowcaseLabel>
        <ShowcaseDemo>
          <EmptyState
            icon={Inbox}
            headline="No messages yet"
            description="Anything your agents send you lands here."
            preview={
              <div className="space-y-2">
                <div className="bg-muted h-8 rounded-md" />
                <div className="bg-muted h-8 rounded-md" />
              </div>
            }
          />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="QueryErrorState"
        description="EmptyState wearing the destructive tone — the panel four page-level surfaces used to hand-roll, down to the same class order."
      >
        <ShowcaseLabel>Failed</ShowcaseLabel>
        <ShowcaseDemo>
          <QueryErrorState
            title="Could not load your team"
            description="The DorkOS server did not answer. Check that it is still running."
            onRetry={() => {}}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Retrying (button waits with a spinner)</ShowcaseLabel>
        <ShowcaseDemo>
          <QueryErrorState
            title="Couldn't load your reports"
            description="The feedback service is unreachable. Check that you're online and try again."
            onRetry={() => {}}
            isRetrying
          />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="DetailRow"
        description="A label and its value on one line. The row owns structure only — the block around it sets the type size and colour, so every row inside one panel agrees."
      >
        <ShowcaseLabel>Right-aligned values (a readout you scan)</ShowcaseLabel>
        <ShowcaseDemo>
          <Card className="w-full max-w-sm gap-0 text-xs">
            <DetailRow label="Turn">streaming</DetailRow>
            <DetailRow label="Last event">seq 412</DetailRow>
            <DetailRow label="Session id" wrap>
              8f2c1d90-4c1a-4c0e-9d2b-1f7a55c3e401
            </DetailRow>
            <DetailRow label="Cache read" indent swatch="#6366f1">
              12.4k
            </DetailRow>
          </Card>
        </ShowcaseDemo>

        <ShowcaseLabel>Fixed label column (values that are sentences)</ShowcaseLabel>
        <ShowcaseDemo>
          <Card className="text-muted-foreground w-full max-w-sm gap-0 text-xs">
            <DetailRow label="Source" align="start" wrap>
              Comes with the flow plugin
            </DetailRow>
            <DetailRow label="Tools" align="start">
              8
            </DetailRow>
          </Card>
        </ShowcaseDemo>

        <ShowcaseLabel>Copyable</ShowcaseLabel>
        <ShowcaseDemo>
          <Card className="text-muted-foreground text-2xs w-full max-w-sm gap-0">
            <DetailRow
              label="Session ID"
              align="start"
              copyValue="8f2c1d90-4c1a-4c0e-9d2b-1f7a55c3e401"
              valueClassName="font-mono select-all"
            >
              8f2c1d90-4c1a-4c0e-9d2b-1f7a55c3e401
            </DetailRow>
          </Card>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="RemovableChip"
        description="A pill with an X on the end — an active filter, a chosen option. Composes Badge's pill shape rather than redrawing it."
      >
        <ShowcaseLabel>One and several</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap items-center gap-1">
            <RemovableChip onRemove={() => {}} removeLabel="Remove agent filter">
              code-reviewer
            </RemovableChip>
            <RemovableChip onRemove={() => {}} removeLabel="Remove status filter">
              Status: running
            </RemovableChip>
            <RemovableChip onRemove={() => {}} removeLabel="Remove project filter">
              Project: dorkos
            </RemovableChip>
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Spinner"
        description="The one spinning-loader glyph, sized from the shared icon scale. Hidden from screen readers unless you give it a label."
      >
        <ShowcaseLabel>Sizes</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="text-muted-foreground flex items-center gap-6">
            <Spinner size="xs" />
            <Spinner size="sm" />
            <Spinner size="md" />
            <Spinner size="lg" />
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Inside a button</ShowcaseLabel>
        <ShowcaseDemo>
          <Button size="sm" disabled>
            <Spinner size="xs" />
            Saving
          </Button>
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
