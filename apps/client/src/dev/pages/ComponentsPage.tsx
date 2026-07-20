import { PlaygroundPageLayout } from '../PlaygroundPageLayout';
import { COMPONENTS_SECTIONS } from '../playground-registry';
import { ButtonShowcases } from '../showcases/ButtonShowcases';
import { BannerShowcases } from '../showcases/BannerShowcases';
import { FeedbackShowcases } from '../showcases/FeedbackShowcases';
import { NavigationShowcases } from '../showcases/NavigationShowcases';
import { SidebarShowcases } from '../showcases/SidebarShowcases';
import { OverlayShowcases } from '../showcases/OverlayShowcases';
import { DataDisplayShowcases } from '../showcases/DataDisplayShowcases';
import { DrawerShowcases } from '../showcases/DrawerShowcases';
import { ChatPrimitivesShowcases } from '../showcases/ChatPrimitivesShowcases';

/** UI component gallery page for the dev playground. */
export function ComponentsPage() {
  return (
    <PlaygroundPageLayout
      title="Components"
      description="Interactive gallery of shared UI components."
      sections={COMPONENTS_SECTIONS}
    >
      <ButtonShowcases />
      <BannerShowcases />
      <FeedbackShowcases />
      <NavigationShowcases />
      <SidebarShowcases />
      <OverlayShowcases />
      <DrawerShowcases />
      <DataDisplayShowcases />
      <ChatPrimitivesShowcases />
    </PlaygroundPageLayout>
  );
}
