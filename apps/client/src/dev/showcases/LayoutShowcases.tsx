import { PageContainer } from '@/layers/shared/ui';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/** Stand-in page content, so each width tier has something whose edges you can see. */
function SampleContent({ label }: { label: string }) {
  return (
    <div className="border-primary/40 bg-primary/5 text-muted-foreground rounded-md border border-dashed p-4 text-sm">
      {label}
    </div>
  );
}

/**
 * The page-width vocabulary, all three tiers side by side.
 *
 * Each demo is given a fixed height so the boxes can be compared as boxes — the
 * point of the section is the WIDTH each tier settles at inside the same pane,
 * which is the thing that used to differ page by page.
 */
export function LayoutShowcases() {
  return (
    <PlaygroundSection
      title="PageContainer"
      description="Every route's content box. Three width tiers and nothing else: wide (80rem) for dashboards and grids, reading (56rem) for forms and feeds, full for panes that should fill. Both caps read a CSS token, so widening a whole class of pages is one line in index.css. `width` has no default — every page states its intent."
    >
      <ShowcaseLabel>width=&quot;wide&quot; — 80rem cap</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="bg-background h-32 rounded-md border">
          <PageContainer width="wide">
            <SampleContent label="max-w-[var(--page-width-wide)] · dashboards, grids, the marketplace" />
          </PageContainer>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>width=&quot;reading&quot; — 56rem cap</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="bg-background h-32 rounded-md border">
          <PageContainer width="reading">
            <SampleContent label="max-w-[var(--page-width-reading)] · activity, workspaces, connections, settings-shaped pages" />
          </PageContainer>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>width=&quot;full&quot; — no cap, gutters still apply</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="bg-background h-32 rounded-md border">
          <PageContainer width="full">
            <SampleContent label="fills the pane · team, tasks" />
          </PageContainer>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>{'scroll={false} — the page scrolls an inner region instead'}</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-background h-40 rounded-md border">
          <PageContainer width="reading" scroll={false} className="gap-3">
            <SampleContent label="header stays put" />
            <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-dashed p-3 text-sm">
              {Array.from({ length: 12 }, (_, i) => (
                <p key={i} className="text-muted-foreground py-1">
                  inner scroller, row {i + 1}
                </p>
              ))}
            </div>
          </PageContainer>
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
