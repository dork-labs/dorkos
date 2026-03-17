import { ButtonShowcases } from '../showcases/ButtonShowcases';
import { FormShowcases } from '../showcases/FormShowcases';
import { FeedbackShowcases } from '../showcases/FeedbackShowcases';
import { NavigationShowcases } from '../showcases/NavigationShowcases';
import { SidebarShowcases } from '../showcases/SidebarShowcases';
import { OverlayShowcases } from '../showcases/OverlayShowcases';
import { DataDisplayShowcases } from '../showcases/DataDisplayShowcases';
import { TocSidebar } from '../TocSidebar';
import { COMPONENTS_SECTIONS } from '../playground-registry';

/** UI component gallery page for the dev playground. */
export function ComponentsPage() {
  return (
    <>
      <header className="border-border border-b px-6 py-4">
        <h1 className="text-xl font-bold">Components</h1>
        <p className="text-muted-foreground text-sm">
          Interactive gallery of shared UI components.
        </p>
      </header>

      <div className="flex gap-8 p-6">
        <main className="min-w-0 flex-1 space-y-8">
          <ButtonShowcases />
          <FormShowcases />
          <FeedbackShowcases />
          <NavigationShowcases />
          <SidebarShowcases />
          <OverlayShowcases />
          <DataDisplayShowcases />
        </main>
        <TocSidebar sections={COMPONENTS_SECTIONS} />
      </div>
    </>
  );
}
