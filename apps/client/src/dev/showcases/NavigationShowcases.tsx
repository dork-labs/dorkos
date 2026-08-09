import { useState } from 'react';
import {
  Palette,
  Settings2,
  LayoutList,
  Server,
  Wrench,
  Cog,
  User,
  Sparkles,
  Plug2,
} from 'lucide-react';
import { PlaygroundSection } from '../PlaygroundSection';
import { AppTabStrip } from '@/layers/features/app-tabs';
import type { AppTab } from '@/layers/shared/model';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  NavigationLayout,
  NavigationLayoutBody,
  NavigationLayoutSidebar,
  NavigationLayoutItem,
  NavigationLayoutContent,
  NavigationLayoutPanel,
  NavigationLayoutPanelHeader,
} from '@/layers/shared/ui';

/** NavigationLayout showcases: sidebar navigation with desktop/mobile variants. */
export function NavigationShowcases() {
  return (
    <>
      <PlaygroundSection
        title="NavigationLayout"
        description="Vertical sidebar navigation for dialogs and settings panels. Renders a sidebar with animated active pill on desktop, list + drill-down on mobile."
      >
        <ShowcaseLabel>Settings-style (6 items)</ShowcaseLabel>
        <ShowcaseDemo responsive>
          <SettingsDemo />
        </ShowcaseDemo>

        <ShowcaseLabel>Compact (4 items)</ShowcaseLabel>
        <ShowcaseDemo responsive>
          <CompactDemo />
        </ShowcaseDemo>

        <ShowcaseLabel>Minimal (2 items)</ShowcaseLabel>
        <ShowcaseDemo responsive>
          <MinimalDemo />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="AppTabStrip"
        description="The cockpit window's tab strip. Each tab is one location; the name, icon and live dot are all derived from its href. The last tab has no close control, and the whole strip is a single Tab stop with arrow-key traversal."
      >
        <ShowcaseLabel>One tab (nothing to close)</ShowcaseLabel>
        <ShowcaseDemo responsive>
          <AppTabStripDemo tabs={TAB_SAMPLES.slice(0, 1)} />
        </ShowcaseDemo>

        <ShowcaseLabel>A few tabs</ShowcaseLabel>
        <ShowcaseDemo responsive>
          <AppTabStripDemo tabs={TAB_SAMPLES.slice(0, 4)} />
        </ShowcaseDemo>

        <ShowcaseLabel>More tabs than fit (scrolls)</ShowcaseLabel>
        <ShowcaseDemo responsive>
          <AppTabStripDemo tabs={TAB_SAMPLES} />
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}

/** One tab per route the strip can name, plus chat tabs named after projects. */
const TAB_SAMPLES: AppTab[] = [
  { id: 'tab-home', href: '/' },
  { id: 'tab-api', href: '/session?session=s-api&dir=%2FUsers%2Fkai%2Fcode%2Fapi' },
  { id: 'tab-web', href: '/session?session=s-web&dir=%2FUsers%2Fkai%2Fcode%2Fweb-cockpit' },
  { id: 'tab-agents', href: '/team?view=topology' },
  { id: 'tab-activity', href: '/activity' },
  { id: 'tab-tasks', href: '/tasks' },
  { id: 'tab-workspaces', href: '/workspaces' },
  { id: 'tab-marketplace', href: '/marketplace' },
];

/** Live strip with local state — the real component, not a lookalike. */
function AppTabStripDemo({ tabs: initial }: { tabs: AppTab[] }) {
  const [tabs, setTabs] = useState(initial);
  const [activeId, setActiveId] = useState(initial[0].id);
  const [spawned, setSpawned] = useState(0);

  return (
    <div className="border-border overflow-hidden rounded-lg border">
      <AppTabStrip
        tabs={tabs}
        activeId={activeId}
        onActivate={setActiveId}
        onClose={(id) => {
          setTabs((current) => {
            const index = current.findIndex((tab) => tab.id === id);
            const next = current.filter((tab) => tab.id !== id);
            if (id === activeId) setActiveId((next[index] ?? next[index - 1]).id);
            return next;
          });
        }}
        onCreate={() => {
          const tab = { id: `tab-new-${spawned}`, href: '/' };
          setSpawned((count) => count + 1);
          setTabs((current) => [...current, tab]);
          setActiveId(tab.id);
        }}
      />
      <div className="text-muted-foreground bg-background p-6 text-center text-xs">
        Content of the active tab
      </div>
    </div>
  );
}

function SettingsDemo() {
  const [active, setActive] = useState('appearance');

  return (
    <div className="border-border overflow-hidden rounded-lg border">
      <NavigationLayout value={active} onValueChange={setActive}>
        <NavigationLayoutBody>
          <NavigationLayoutSidebar>
            <NavigationLayoutItem value="appearance" icon={Palette}>
              Appearance
            </NavigationLayoutItem>
            <NavigationLayoutItem value="preferences" icon={Settings2}>
              Preferences
            </NavigationLayoutItem>
            <NavigationLayoutItem value="statusBar" icon={LayoutList}>
              Status Bar
            </NavigationLayoutItem>
            <NavigationLayoutItem value="server" icon={Server}>
              Server
            </NavigationLayoutItem>
            <NavigationLayoutItem value="tools" icon={Wrench}>
              Tools
            </NavigationLayoutItem>
            <NavigationLayoutItem value="advanced" icon={Cog}>
              Advanced
            </NavigationLayoutItem>
          </NavigationLayoutSidebar>

          <NavigationLayoutContent className="p-4">
            <NavigationLayoutPanel value="appearance">
              <PanelPlaceholder
                title="Appearance"
                description="Theme, font family, font size controls."
              />
            </NavigationLayoutPanel>
            <NavigationLayoutPanel value="preferences">
              <PanelPlaceholder
                title="Preferences"
                description="Timestamps, tool calls, notifications."
              />
            </NavigationLayoutPanel>
            <NavigationLayoutPanel value="statusBar">
              <PanelPlaceholder
                title="Status Bar"
                description="Toggle visibility of status bar items."
              />
            </NavigationLayoutPanel>
            <NavigationLayoutPanel value="server">
              <PanelPlaceholder
                title="Server"
                description="Version, port, uptime, tunnel config."
              />
            </NavigationLayoutPanel>
            <NavigationLayoutPanel value="tools">
              <PanelPlaceholder title="Tools" description="Tool approval and configuration." />
            </NavigationLayoutPanel>
            <NavigationLayoutPanel value="advanced">
              <PanelPlaceholder title="Advanced" description="Reset data, restart server." />
            </NavigationLayoutPanel>
          </NavigationLayoutContent>
        </NavigationLayoutBody>
      </NavigationLayout>
    </div>
  );
}

function CompactDemo() {
  const [active, setActive] = useState('identity');

  return (
    <div className="border-border overflow-hidden rounded-lg border">
      <NavigationLayout value={active} onValueChange={setActive}>
        <NavigationLayoutBody>
          <NavigationLayoutSidebar>
            <NavigationLayoutItem value="identity" icon={User}>
              Identity
            </NavigationLayoutItem>
            <NavigationLayoutItem value="persona" icon={Sparkles}>
              Persona
            </NavigationLayoutItem>
            <NavigationLayoutItem value="tools" icon={Wrench}>
              Tools
            </NavigationLayoutItem>
            <NavigationLayoutItem value="connections" icon={Plug2}>
              Connections
            </NavigationLayoutItem>
          </NavigationLayoutSidebar>

          <NavigationLayoutContent className="p-4">
            <NavigationLayoutPanel value="identity">
              <PanelPlaceholder title="Identity" description="Agent name, slug, description." />
            </NavigationLayoutPanel>
            <NavigationLayoutPanel value="persona">
              <PanelPlaceholder
                title="Persona"
                description="System prompt and personality traits."
              />
            </NavigationLayoutPanel>
            <NavigationLayoutPanel value="tools">
              <PanelPlaceholder title="Tools" description="Tool access, safety limits." />
            </NavigationLayoutPanel>
            <NavigationLayoutPanel value="connections">
              <PanelPlaceholder
                title="Connections"
                description="Relay subscriptions and mesh peers."
              />
            </NavigationLayoutPanel>
          </NavigationLayoutContent>
        </NavigationLayoutBody>
      </NavigationLayout>
    </div>
  );
}

function MinimalDemo() {
  const [active, setActive] = useState('general');

  return (
    <div className="border-border overflow-hidden rounded-lg border">
      <NavigationLayout value={active} onValueChange={setActive}>
        <NavigationLayoutBody>
          <NavigationLayoutSidebar>
            <NavigationLayoutItem value="general" icon={Settings2}>
              General
            </NavigationLayoutItem>
            <NavigationLayoutItem value="advanced" icon={Cog}>
              Advanced
            </NavigationLayoutItem>
          </NavigationLayoutSidebar>

          <NavigationLayoutContent className="p-4">
            <NavigationLayoutPanel value="general">
              <PanelPlaceholder title="General" description="Basic configuration options." />
            </NavigationLayoutPanel>
            <NavigationLayoutPanel value="advanced">
              <PanelPlaceholder
                title="Advanced"
                description="Power-user settings and diagnostics."
              />
            </NavigationLayoutPanel>
          </NavigationLayoutContent>
        </NavigationLayoutBody>
      </NavigationLayout>
    </div>
  );
}

function PanelPlaceholder({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-3">
      <NavigationLayoutPanelHeader>{title}</NavigationLayoutPanelHeader>
      <p className="text-muted-foreground text-sm">{description}</p>
      <div className="space-y-2">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="bg-muted/50 h-8 rounded-md" />
        ))}
      </div>
    </div>
  );
}
