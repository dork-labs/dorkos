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
  Zap,
  Plug2,
} from 'lucide-react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
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
        <SettingsDemo />

        <ShowcaseLabel>Compact (4 items)</ShowcaseLabel>
        <CompactDemo />

        <ShowcaseLabel>Minimal (2 items)</ShowcaseLabel>
        <MinimalDemo />
      </PlaygroundSection>
    </>
  );
}

function SettingsDemo() {
  const [active, setActive] = useState('appearance');

  return (
    <div className="border-border overflow-hidden rounded-lg border">
      <NavigationLayout value={active} onValueChange={setActive}>
        <NavigationLayoutBody>
        <NavigationLayoutSidebar>
          <NavigationLayoutItem value="appearance" icon={Palette}>Appearance</NavigationLayoutItem>
          <NavigationLayoutItem value="preferences" icon={Settings2}>Preferences</NavigationLayoutItem>
          <NavigationLayoutItem value="statusBar" icon={LayoutList}>Status Bar</NavigationLayoutItem>
          <NavigationLayoutItem value="server" icon={Server}>Server</NavigationLayoutItem>
          <NavigationLayoutItem value="tools" icon={Wrench}>Tools</NavigationLayoutItem>
          <NavigationLayoutItem value="advanced" icon={Cog}>Advanced</NavigationLayoutItem>
        </NavigationLayoutSidebar>

        <NavigationLayoutContent className="p-4">
          <NavigationLayoutPanel value="appearance">
            <PanelPlaceholder title="Appearance" description="Theme, font family, font size controls." />
          </NavigationLayoutPanel>
          <NavigationLayoutPanel value="preferences">
            <PanelPlaceholder title="Preferences" description="Timestamps, tool calls, notifications." />
          </NavigationLayoutPanel>
          <NavigationLayoutPanel value="statusBar">
            <PanelPlaceholder title="Status Bar" description="Toggle visibility of status bar items." />
          </NavigationLayoutPanel>
          <NavigationLayoutPanel value="server">
            <PanelPlaceholder title="Server" description="Version, port, uptime, tunnel config." />
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
          <NavigationLayoutItem value="identity" icon={User}>Identity</NavigationLayoutItem>
          <NavigationLayoutItem value="persona" icon={Sparkles}>Persona</NavigationLayoutItem>
          <NavigationLayoutItem value="capabilities" icon={Zap}>Capabilities</NavigationLayoutItem>
          <NavigationLayoutItem value="connections" icon={Plug2}>Connections</NavigationLayoutItem>
        </NavigationLayoutSidebar>

        <NavigationLayoutContent className="p-4">
          <NavigationLayoutPanel value="identity">
            <PanelPlaceholder title="Identity" description="Agent name, slug, description." />
          </NavigationLayoutPanel>
          <NavigationLayoutPanel value="persona">
            <PanelPlaceholder title="Persona" description="System prompt and personality traits." />
          </NavigationLayoutPanel>
          <NavigationLayoutPanel value="capabilities">
            <PanelPlaceholder title="Capabilities" description="Tools, MCP servers, permissions." />
          </NavigationLayoutPanel>
          <NavigationLayoutPanel value="connections">
            <PanelPlaceholder title="Connections" description="Relay subscriptions and mesh peers." />
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
          <NavigationLayoutItem value="general" icon={Settings2}>General</NavigationLayoutItem>
          <NavigationLayoutItem value="advanced" icon={Cog}>Advanced</NavigationLayoutItem>
        </NavigationLayoutSidebar>

        <NavigationLayoutContent className="p-4">
          <NavigationLayoutPanel value="general">
            <PanelPlaceholder title="General" description="Basic configuration options." />
          </NavigationLayoutPanel>
          <NavigationLayoutPanel value="advanced">
            <PanelPlaceholder title="Advanced" description="Power-user settings and diagnostics." />
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
