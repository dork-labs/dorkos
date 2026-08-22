import { PageContainer } from '@/layers/shared/ui';
import { TocSidebar } from '../TocSidebar';
import { SIDEBAR_BOOT_SECTIONS } from '../sections/sidebar-boot-sections';
import { SidebarBootShowcases } from '../showcases/SidebarBootShowcases';
import { SidebarMotionShowcases } from '../showcases/SidebarMotionShowcases';

/**
 * The Sidebar Boot & Motion page — how the panel comes up, in both of its two
 * ways, and how it moves once it has.
 *
 * Composed on `PageContainer` like its neighbour `SidebarModelPage`, for the
 * same reason: a page-level surface takes the app's shared width vocabulary
 * (DOR-1047), and `scroll={false}` because the playground's own `SidebarInset`
 * already owns the scroller.
 *
 * @module dev/pages/SidebarBootPage
 */
export function SidebarBootPage() {
  return (
    <PageContainer width="full" scroll={false}>
      <header className="pb-4">
        <h1 className="text-xl font-bold">Sidebar Boot &amp; Motion</h1>
        <p className="text-muted-foreground text-sm">
          The panel paints in one of two ways — warm, in its final shape in the first frame, or
          cold, as bones that are replaced in a single reveal. It never assembles itself in front of
          you — and once it is up, it moves only to explain a change you did not cause.
        </p>
      </header>

      <div className="flex gap-8">
        {/* A `<div>` and not a `<main>`: the playground's `SidebarInset` is
            already the document's `<main>`. */}
        <div className="min-w-0 flex-1 space-y-8">
          <SidebarBootShowcases />
          <SidebarMotionShowcases />
        </div>
        <TocSidebar sections={SIDEBAR_BOOT_SECTIONS} />
      </div>
    </PageContainer>
  );
}
