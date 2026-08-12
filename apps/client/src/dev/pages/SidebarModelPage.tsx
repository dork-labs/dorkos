import { PageContainer } from '@/layers/shared/ui';
import { TocSidebar } from '../TocSidebar';
import { SIDEBAR_MODEL_SECTIONS } from '../sections/sidebar-model-sections';
import { SidebarModelShowcases } from '../showcases/SidebarModelShowcases';
import { MobileTabBarShowcase } from '../showcases/MobileTabsShowcases';

/**
 * The Sidebar Model page — `buildSidebarModel` over its four journey fixtures.
 *
 * **Composed on `PageContainer` rather than `PlaygroundPageLayout`**, which is
 * the one place this page departs from its neighbours. The layout component
 * hand-rolls its own `p-6` and has no width vocabulary; this page is a
 * page-level surface and takes the app's shared one (DOR-1047), so the gutters
 * and the responsive step come from the same place every route gets them. The
 * header and the TOC are the same two pieces `PlaygroundPageLayout` composes,
 * so nothing about how the page reads changes.
 *
 * `scroll={false}` because the scroller is the playground's own `SidebarInset`;
 * a second one here would trap the page's scrollbar inside the content column
 * and break the TOC's anchor jumps.
 *
 * @module dev/pages/SidebarModelPage
 */
export function SidebarModelPage() {
  return (
    <PageContainer width="full" scroll={false}>
      <header className="pb-4">
        <h1 className="text-xl font-bold">Sidebar Model</h1>
        <p className="text-muted-foreground text-sm">
          One pure function decides every zone, section and row — and says why. Four journey
          fixtures, both themes, no server.
        </p>
      </header>

      <div className="flex gap-8">
        {/* A `<div>` and not a `<main>`: the playground's `SidebarInset` is
            already the document's `<main>`, and a second one nested inside it
            is two axe violations (`landmark-no-duplicate-main`,
            `landmark-main-is-top-level`) on a page whose whole job is to pass
            an axe run. */}
        <div className="min-w-0 flex-1 space-y-8">
          <SidebarModelShowcases />
          <MobileTabBarShowcase />
        </div>
        <TocSidebar sections={SIDEBAR_MODEL_SECTIONS} />
      </div>
    </PageContainer>
  );
}
