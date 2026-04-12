import { useState } from 'react';
import { Palette, Settings2, Server } from 'lucide-react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';
import {
  Button,
  FieldCard,
  FieldCardContent,
  SettingRow,
  Switch,
  NavigationLayout,
  NavigationLayoutBody,
  NavigationLayoutSidebar,
  NavigationLayoutItem,
  NavigationLayoutContent,
  NavigationLayoutPanel,
  NavigationLayoutPanelHeader,
  NavigationLayoutDialogHeader,
  ResponsiveDialogTitle,
} from '@/layers/shared/ui';
import { SettingsDialog } from '@/layers/features/settings';
import { AppearanceTab } from '@/layers/features/settings/ui/tabs/AppearanceTab';
import { PreferencesTab } from '@/layers/features/settings/ui/tabs/PreferencesTab';
import { StatusBarTab } from '@/layers/features/settings/ui/tabs/StatusBarTab';
import { ServerTab } from '@/layers/features/settings/ui/ServerTab';
import { ToolsTab } from '@/layers/features/settings/ui/ToolsTab';
import { ChannelsTab } from '@/layers/features/settings/ui/ChannelsTab';
import { AgentsTab } from '@/layers/features/settings/ui/AgentsTab';
import { AdvancedTab } from '@/layers/features/settings/ui/AdvancedTab';
import { MockedQueryProvider, TabShell } from './settings-showcase-helpers';

/** Comprehensive showcase for the Settings dialog system. */
export function SettingsShowcases() {
  return (
    <>
      <FullSettingsDialogSection />
      <IndividualTabsSection />
      <MobileDrillInSection />
      <LoadingEmptyStatesSection />
      <PrimitivesSection />
    </>
  );
}

/** Section 1 — full Settings dialog driven by a state-bound trigger button. */
function FullSettingsDialogSection() {
  const [open, setOpen] = useState(false);
  return (
    <PlaygroundSection
      title="Full Settings Dialog"
      description="The complete Settings dialog with all tabs. Server/Tools/Channels tabs render in their empty state because the playground transport returns null for all queries — see Loading & Empty States for richer demos."
    >
      <ShowcaseDemo responsive>
        <Button onClick={() => setOpen(true)}>Open Settings</Button>
        <SettingsDialog open={open} onOpenChange={setOpen} />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** Section 3 — every settings tab rendered standalone inside a bare `NavigationLayout`. */
function IndividualTabsSection() {
  return (
    <PlaygroundSection
      title="Individual Tabs"
      description="Each settings tab rendered in isolation inside a bare NavigationLayout shell. Useful for iterating on a single tab without opening the full dialog."
    >
      <ShowcaseLabel>Appearance Tab</ShowcaseLabel>
      <ShowcaseDemo>
        <TabShell value="appearance">
          <AppearanceTab />
        </TabShell>
      </ShowcaseDemo>

      <ShowcaseLabel>Preferences Tab</ShowcaseLabel>
      <ShowcaseDemo>
        <TabShell value="preferences">
          <PreferencesTab />
        </TabShell>
      </ShowcaseDemo>

      <ShowcaseLabel>Status Bar Tab</ShowcaseLabel>
      <ShowcaseDemo>
        <TabShell value="statusBar">
          <StatusBarTab />
        </TabShell>
      </ShowcaseDemo>

      <ShowcaseLabel>Server Tab</ShowcaseLabel>
      <ShowcaseDemo>
        <MockedQueryProvider>
          <TabShell value="server">
            <ServerTab />
          </TabShell>
        </MockedQueryProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>Tools Tab</ShowcaseLabel>
      <ShowcaseDemo>
        <MockedQueryProvider>
          <TabShell value="tools">
            <ToolsTab />
          </TabShell>
        </MockedQueryProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>Channels Tab</ShowcaseLabel>
      <ShowcaseDemo>
        <MockedQueryProvider>
          <TabShell value="channels">
            <ChannelsTab />
          </TabShell>
        </MockedQueryProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>Agents Tab</ShowcaseLabel>
      <ShowcaseDemo>
        <MockedQueryProvider>
          <TabShell value="agents">
            <AgentsTab />
          </TabShell>
        </MockedQueryProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>Advanced Tab</ShowcaseLabel>
      <ShowcaseDemo>
        <TabShell value="advanced">
          <AdvancedTab />
        </TabShell>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** Section 4 — narrow-viewport drill-in interaction for the Settings sidebar. */
function MobileDrillInSection() {
  const [active, setActive] = useState('preferences');
  return (
    <PlaygroundSection
      title="Mobile Drill-In"
      description="At narrow viewports the sidebar collapses to a list view, and tapping an item drills into the panel with a back button. Use the viewport toggle to see the responsive behavior."
    >
      <ShowcaseDemo responsive>
        <div className="border-border overflow-hidden rounded-lg border" style={{ height: 480 }}>
          <NavigationLayout value={active} onValueChange={setActive}>
            <NavigationLayoutDialogHeader>
              <ResponsiveDialogTitle className="text-sm font-medium">
                Settings
              </ResponsiveDialogTitle>
            </NavigationLayoutDialogHeader>
            <NavigationLayoutBody>
              <NavigationLayoutSidebar>
                <NavigationLayoutItem value="appearance" icon={Palette}>
                  Appearance
                </NavigationLayoutItem>
                <NavigationLayoutItem value="preferences" icon={Settings2}>
                  Preferences
                </NavigationLayoutItem>
                <NavigationLayoutItem value="server" icon={Server}>
                  Server
                </NavigationLayoutItem>
              </NavigationLayoutSidebar>
              <NavigationLayoutContent className="p-4">
                <NavigationLayoutPanel value="appearance">
                  <div className="space-y-4">
                    <NavigationLayoutPanelHeader>Appearance</NavigationLayoutPanelHeader>
                    <AppearanceTab />
                  </div>
                </NavigationLayoutPanel>
                <NavigationLayoutPanel value="preferences">
                  <div className="space-y-4">
                    <NavigationLayoutPanelHeader>Preferences</NavigationLayoutPanelHeader>
                    <PreferencesTab />
                  </div>
                </NavigationLayoutPanel>
                <NavigationLayoutPanel value="server">
                  <div className="space-y-4">
                    <NavigationLayoutPanelHeader>Server</NavigationLayoutPanelHeader>
                    <MockedQueryProvider>
                      <ServerTab />
                    </MockedQueryProvider>
                  </div>
                </NavigationLayoutPanel>
              </NavigationLayoutContent>
            </NavigationLayoutBody>
          </NavigationLayout>
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/**
 * Section 5 — empty branches of data-driven tabs.
 *
 * Every settings tab is parameterless after the `settings-dialog-02-tabbed-primitive`
 * migration, so loading vs empty vs loaded is purely a function of what the surrounding
 * `QueryClient` knows. These showcases deliberately omit `MockedQueryProvider` so the
 * tabs fall through to the playground's null transport and render their no-data branches.
 */
function LoadingEmptyStatesSection() {
  return (
    <PlaygroundSection
      title="Loading & Empty States"
      description="Skeleton and empty-state renderings for data-driven tabs. The playground transport returns null for all queries, so unwrapped tabs render their no-data branches."
    >
      <ShowcaseLabel>Server Tab — Empty (no config)</ShowcaseLabel>
      <ShowcaseDemo>
        <TabShell value="server">
          <ServerTab />
        </TabShell>
      </ShowcaseDemo>

      <ShowcaseLabel>Channels Tab — Empty Catalog</ShowcaseLabel>
      <ShowcaseDemo>
        <TabShell value="channels">
          <ChannelsTab />
        </TabShell>
      </ShowcaseDemo>

      <ShowcaseLabel>Agents Tab — No Default Agent</ShowcaseLabel>
      <ShowcaseDemo>
        <TabShell value="agents">
          <AgentsTab />
        </TabShell>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** Section 6 — settings primitives (FieldCard, SettingRow) used by every tab. */
function PrimitivesSection() {
  const [toggleA, setToggleA] = useState(true);
  const [toggleB, setToggleB] = useState(false);
  return (
    <PlaygroundSection
      title="Settings Primitives"
      description="Building blocks used by every settings tab — FieldCard wraps groups of rows, SettingRow is the horizontal label/description/control row."
    >
      <ShowcaseLabel>FieldCard with SettingRows</ShowcaseLabel>
      <ShowcaseDemo>
        <FieldCard>
          <FieldCardContent>
            <SettingRow label="Show timestamps" description="Display message timestamps in chat">
              <Switch checked={toggleA} onCheckedChange={setToggleA} />
            </SettingRow>
            <SettingRow label="Auto-hide tool calls" description="Fade out completed tool calls">
              <Switch checked={toggleB} onCheckedChange={setToggleB} />
            </SettingRow>
          </FieldCardContent>
        </FieldCard>
      </ShowcaseDemo>

      <ShowcaseLabel>FieldCard — single row</ShowcaseLabel>
      <ShowcaseDemo>
        <FieldCard>
          <FieldCardContent>
            <SettingRow label="Theme" description="Choose your preferred color scheme">
              <Button variant="outline" size="sm">
                System
              </Button>
            </SettingRow>
          </FieldCardContent>
        </FieldCard>
      </ShowcaseDemo>

      <ShowcaseLabel>SettingRow — disabled</ShowcaseLabel>
      <ShowcaseDemo>
        <SettingRow label="Background sync" description="Requires premium plan">
          <Switch checked={false} disabled />
        </SettingRow>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
