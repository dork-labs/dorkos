import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  PageContainer,
} from '@/layers/shared/ui';
import { Button } from '@/layers/shared/ui';
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
    <>
      <CardShowcase />
      <PageContainerShowcase />
    </>
  );
}

/** The surface every panel sits on — its two shapes, its spacing, its hover. */
function CardShowcase() {
  return (
    <PlaygroundSection
      title="Card"
      description="The one card shell. About ten files used to hand-write these classes because the corner they wanted, or the hover lift, was not reachable from the component — both are axes now."
    >
      <ShowcaseLabel>Header, body, footer</ShowcaseLabel>
      <ShowcaseDemo>
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Telegram</CardTitle>
            <CardDescription>Connected as @dorkbot</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-xs">
              Messages from this chat reach your agents.
            </p>
          </CardContent>
          <CardFooter>
            <Button size="sm" variant="outline">
              Disconnect
            </Button>
          </CardFooter>
        </Card>
      </ShowcaseDemo>

      <ShowcaseLabel>radius — md (default) and lg</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex w-full max-w-lg gap-3">
          <Card className="flex-1">rounded-lg</Card>
          <Card radius="lg" className="flex-1">
            rounded-xl
          </Card>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>variant=&quot;interactive&quot; — hover it, then tab to it</ShowcaseLabel>
      <ShowcaseDemo>
        <Card variant="interactive" className="w-full max-w-sm">
          <CardTitle>A card you can press</CardTitle>
          <Button size="sm" variant="outline" className="self-start">
            Connect
          </Button>
        </Card>
      </ShowcaseDemo>

      <ShowcaseLabel>gap — md (default), sm, and none for a body that spaces itself</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex w-full max-w-2xl gap-3">
          <Card className="flex-1 text-xs">
            <span>gap=md</span>
            <span>16px apart</span>
          </Card>
          <Card gap="sm" className="flex-1 text-xs">
            <span>gap=sm</span>
            <span>12px apart</span>
          </Card>
          <Card gap="none" className="flex-1 text-xs">
            <span>gap=none</span>
            <span className="mt-1">the body decides</span>
          </Card>
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** The page-width vocabulary, all three tiers side by side. */
function PageContainerShowcase() {
  return (
    <PlaygroundSection
      title="PageContainer"
      description="Every route's content box. Three width tiers and nothing else: wide (80rem) for top-level pages — dashboards, directories, feeds; reading (56rem) for true forms and prose only; full for panes that should fill. Both caps read a CSS token, so widening a whole class of pages is one line in index.css. `width` has no default — every page states its intent."
    >
      <ShowcaseLabel>width=&quot;wide&quot; — 80rem cap</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="bg-background h-32 rounded-md border">
          <PageContainer width="wide">
            <SampleContent label="max-w-[var(--page-width-wide)] · top-level pages: marketplace, activity, workspaces, connections" />
          </PageContainer>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>width=&quot;reading&quot; — 56rem cap</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="bg-background h-32 rounded-md border">
          <PageContainer width="reading">
            <SampleContent label="max-w-[var(--page-width-reading)] · true forms and prose: marketplace sources" />
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
