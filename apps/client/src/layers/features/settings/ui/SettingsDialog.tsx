import { useState, useEffect, Suspense } from 'react';
import { Palette, Settings2, LayoutList, Server, Wrench, Cog, Bot, Radio } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTransport, useAppStore, useSlotContributions } from '@/layers/shared/model';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFullscreenToggle,
  NavigationLayout,
  NavigationLayoutDialogHeader,
  NavigationLayoutBody,
  NavigationLayoutSidebar,
  NavigationLayoutItem,
  NavigationLayoutContent,
  NavigationLayoutPanel,
  NavigationLayoutPanelHeader,
} from '@/layers/shared/ui';
import { ServerTab } from './ServerTab';
import { TunnelDialog } from './TunnelDialog';
import { AdvancedTab } from './AdvancedTab';
import { ServerRestartOverlay } from './ServerRestartOverlay';
import { ToolsTab } from './ToolsTab';
import { ChannelsTab } from './ChannelsTab';
import { AgentsTab } from './AgentsTab';
import { RemoteAccessAction } from './RemoteAccessAction';
import { AppearanceTab } from './tabs/AppearanceTab';
import { PreferencesTab } from './tabs/PreferencesTab';
import { StatusBarTab } from './tabs/StatusBarTab';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Tabbed settings dialog for appearance, behavior, and advanced options. */
export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const settingsInitialTab = useAppStore((s) => s.settingsInitialTab);
  const [activeTab, setActiveTab] = useState(settingsInitialTab ?? 'appearance');
  const extensionTabs = useSlotContributions('settings.tabs');
  const [tunnelDialogOpen, setTunnelDialogOpen] = useState(false);
  const [restartOverlayOpen, setRestartOverlayOpen] = useState(false);

  // Sync active tab when dialog opens with a pre-targeted tab
  useEffect(() => {
    if (open && settingsInitialTab) setActiveTab(settingsInitialTab);
  }, [open, settingsInitialTab]);

  const transport = useTransport();
  const { data: config, isLoading } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 30_000,
    enabled: open,
  });

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        data-testid="settings-dialog"
        className="max-h-[85vh] max-w-2xl gap-0 p-0"
      >
        <NavigationLayout value={activeTab} onValueChange={setActiveTab}>
          <ResponsiveDialogFullscreenToggle />
          <NavigationLayoutDialogHeader>
            <ResponsiveDialogTitle className="text-sm font-medium">Settings</ResponsiveDialogTitle>
            <ResponsiveDialogDescription className="sr-only">
              Application settings
            </ResponsiveDialogDescription>
          </NavigationLayoutDialogHeader>

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
              <RemoteAccessAction onClick={() => setTunnelDialogOpen(true)} />
              <NavigationLayoutItem value="tools" icon={Wrench}>
                Tools
              </NavigationLayoutItem>
              <NavigationLayoutItem value="channels" icon={Radio}>
                Channels
              </NavigationLayoutItem>
              <NavigationLayoutItem value="agents" icon={Bot}>
                Agents
              </NavigationLayoutItem>
              <NavigationLayoutItem value="advanced" icon={Cog}>
                Advanced
              </NavigationLayoutItem>
              {extensionTabs.map((tab) => (
                <NavigationLayoutItem key={tab.id} value={tab.id} icon={tab.icon}>
                  {tab.label}
                </NavigationLayoutItem>
              ))}
            </NavigationLayoutSidebar>

            <NavigationLayoutContent className="min-h-[280px] p-4">
              <NavigationLayoutPanel value="appearance">
                <AppearanceTab />
              </NavigationLayoutPanel>
              <NavigationLayoutPanel value="preferences">
                <PreferencesTab />
              </NavigationLayoutPanel>
              <NavigationLayoutPanel value="statusBar">
                <StatusBarTab />
              </NavigationLayoutPanel>
              <NavigationLayoutPanel value="server">
                <div className="space-y-3">
                  <NavigationLayoutPanelHeader>Server</NavigationLayoutPanelHeader>
                  <ServerTab config={config} isLoading={isLoading} />
                </div>
              </NavigationLayoutPanel>
              <NavigationLayoutPanel value="tools">
                <ToolsTab />
              </NavigationLayoutPanel>
              <NavigationLayoutPanel value="channels">
                <div className="space-y-4">
                  <NavigationLayoutPanelHeader>Channels</NavigationLayoutPanelHeader>
                  <ChannelsTab />
                </div>
              </NavigationLayoutPanel>
              <NavigationLayoutPanel value="agents">
                <div className="space-y-4">
                  <NavigationLayoutPanelHeader>Agents</NavigationLayoutPanelHeader>
                  <AgentsTab />
                </div>
              </NavigationLayoutPanel>
              <NavigationLayoutPanel value="advanced">
                <div className="space-y-4">
                  <NavigationLayoutPanelHeader>Advanced</NavigationLayoutPanelHeader>
                  <AdvancedTab
                    onResetComplete={() => setRestartOverlayOpen(true)}
                    onRestartComplete={() => setRestartOverlayOpen(true)}
                  />
                </div>
              </NavigationLayoutPanel>
              {extensionTabs.map((tab) => {
                const TabComponent = tab.component;
                return (
                  <NavigationLayoutPanel key={tab.id} value={tab.id}>
                    <div className="space-y-4">
                      <NavigationLayoutPanelHeader>{tab.label}</NavigationLayoutPanelHeader>
                      <Suspense
                        fallback={
                          <div className="text-muted-foreground py-8 text-center text-sm">
                            Loading…
                          </div>
                        }
                      >
                        <TabComponent />
                      </Suspense>
                    </div>
                  </NavigationLayoutPanel>
                );
              })}
            </NavigationLayoutContent>
          </NavigationLayoutBody>
        </NavigationLayout>
      </ResponsiveDialogContent>
      <TunnelDialog open={tunnelDialogOpen} onOpenChange={setTunnelDialogOpen} />
      <ServerRestartOverlay
        open={restartOverlayOpen}
        onDismiss={() => setRestartOverlayOpen(false)}
      />
    </ResponsiveDialog>
  );
}
