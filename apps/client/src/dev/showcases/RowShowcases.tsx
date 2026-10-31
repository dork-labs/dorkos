import { AlertCircle, CalendarClock, Inbox, MoreHorizontal, Play, Plug } from 'lucide-react';
import {
  Button,
  Card,
  CardDescription,
  CardTitle,
  FieldCard,
  FieldCardContent,
  ListRow,
  SwitchSettingRow,
} from '@/layers/shared/ui';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

const noop = () => {};

/** Two ghost icon actions, the most a row carries. */
function RowActions() {
  return (
    <>
      <Button variant="ghost" size="icon-sm" aria-label="Run now">
        <Play />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="More">
        <MoreHorizontal />
      </Button>
    </>
  );
}

/** Every row state, once: rest, hover (try it), selected, emphasized, disabled, static. */
function RowStates({ inset = 'page' }: { inset?: 'page' | 'group' }) {
  const glyph = <CalendarClock className="size-icon-sm" />;
  return (
    <>
      <ListRow
        inset={inset}
        leading={glyph}
        title="Morning digest"
        meta="7:00"
        onSelect={noop}
        actions={<RowActions />}
      />
      <ListRow
        inset={inset}
        leading={glyph}
        title="Weekly review"
        meta="Mon"
        selected
        onSelect={noop}
      />
      <ListRow
        inset={inset}
        leading={glyph}
        title="Release notes for a very long project name that has to truncate"
        meta="2 new"
        emphasized
        onSelect={noop}
      />
      <ListRow
        inset={inset}
        leading={<Plug className="size-icon-sm" />}
        title="Calendar sync"
        trailing={<span className="text-status-error-fg">Reconnect</span>}
        onSelect={noop}
      />
      <ListRow
        inset={inset}
        leading={glyph}
        title="Nightly backup"
        secondLine="Last ran 3h ago · finished in 42s"
        meta={<span className="text-faint">3h</span>}
      />
    </>
  );
}

/** Cards, groups and rows: the Phase 2 grammar in every context it sits in. */
export function RowShowcases() {
  return (
    <PlaygroundSection
      title="List rows"
      description="One row grammar (ListRow) and one tint ladder (bg-row-hover / bg-row-selected) on every ground: the page, a group inside a card, and a group inside a modal. Hover a row, then tab through: focus is an inset outline with the hover tint, and actions show on hover and on focus."
    >
      <ShowcaseLabel>On the page — inset=&quot;page&quot;</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-background w-full max-w-md rounded-md p-4">
          <div className="-mx-2 flex flex-col">
            <RowStates />
          </div>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        In a group (FieldCard) — inset=&quot;group&quot;, no rules between rows
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-background w-full max-w-md rounded-md p-4">
          <FieldCard>
            <RowStates inset="group" />
          </FieldCard>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>In a modal — the gentler ladder and the ink climb</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-background shadow-modal w-full max-w-md rounded-lg p-4">
          <div className="flex flex-col gap-6">
            <FieldCard>
              <FieldCardContent>
                <SwitchSettingRow
                  label="Notifications"
                  description="Tell me when an agent needs me"
                  checked
                  onCheckedChange={noop}
                />
                <SwitchSettingRow
                  label="Sounds"
                  description="Play a sound when a run finishes"
                  checked={false}
                  onCheckedChange={noop}
                />
              </FieldCardContent>
            </FieldCard>
            <FieldCard>
              <RowStates inset="group" />
            </FieldCard>
          </div>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Cards — no border; a chosen card takes the ink outline and a check
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-background grid w-full max-w-2xl grid-cols-1 gap-3 rounded-md p-4 sm:grid-cols-3">
          <Card variant="interactive" gap="sm">
            <CardTitle>Researcher</CardTitle>
            <CardDescription>Reads, then writes it up</CardDescription>
          </Card>
          <Card variant="interactive" gap="sm" selected aria-pressed>
            <CardTitle>Builder</CardTitle>
            <CardDescription>Ships the change</CardDescription>
          </Card>
          <Card variant="interactive" gap="sm">
            <CardTitle>Reviewer</CardTitle>
            <CardDescription>Reads the diff</CardDescription>
          </Card>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Empty, filtered and failed lists</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-background flex w-full max-w-md flex-col gap-4 rounded-md p-4">
          <div className="text-muted-foreground flex flex-col items-center gap-2 py-6 text-sm">
            <Inbox className="size-6" aria-hidden />
            <span>No schedules yet.</span>
            <Button size="sm">Create one</Button>
          </div>
          <div className="-mx-2">
            <ListRow
              title={
                <span className="text-muted-foreground">Nothing matches &lsquo;foo&rsquo;</span>
              }
              titleText="Nothing matches 'foo'"
              wrapTitle
              trailing={
                <Button variant="ghost" size="sm">
                  Clear filter
                </Button>
              }
            />
            <ListRow
              leading={<AlertCircle className="text-status-error-fg size-icon-sm" />}
              title="Couldn't load schedules."
              wrapTitle
              trailing={
                <Button variant="ghost" size="sm">
                  Try again
                </Button>
              }
            />
          </div>
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
