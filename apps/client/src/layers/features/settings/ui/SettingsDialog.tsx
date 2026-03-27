import { useState, Suspense } from 'react';
import { Palette, Settings2, LayoutList, Server, Wrench, Cog, Bot } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTransport, useAppStore, useTheme, useSlotContributions } from '@/layers/shared/model';
import { FONT_CONFIGS, type FontFamilyKey } from '@/layers/shared/lib';
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
  Switch,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingRow,
  FieldCard,
  FieldCardContent,
} from '@/layers/shared/ui';
import {
  STATUS_BAR_REGISTRY,
  useStatusBarVisibility,
  resetStatusBarPreferences,
} from '@/layers/features/status';
import type { StatusBarItemConfig } from '@/layers/features/status';
import { ServerTab } from './ServerTab';
import { TunnelDialog } from './TunnelDialog';
import { AdvancedTab } from './AdvancedTab';
import { ServerRestartOverlay } from './ServerRestartOverlay';
import { ToolsTab } from './ToolsTab';
import { AgentsTab } from './AgentsTab';

/** Toggle row for a single status bar registry item. */
function StatusBarSettingRow({ item }: { item: StatusBarItemConfig }) {
  const [visible, setVisible] = useStatusBarVisibility(item.key);
  return (
    <SettingRow label={item.label} description={item.description}>
      <Switch checked={visible} onCheckedChange={setVisible} />
    </SettingRow>
  );
}

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Tabbed settings dialog for appearance, behavior, and advanced options. */
export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { theme, setTheme } = useTheme();
  const [activeTab, setActiveTab] = useState('appearance');
  const extensionTabs = useSlotContributions('settings.tabs');
  const [tunnelDialogOpen, setTunnelDialogOpen] = useState(false);
  const [restartOverlayOpen, setRestartOverlayOpen] = useState(false);
  const {
    showTimestamps,
    setShowTimestamps,
    expandToolCalls,
    setExpandToolCalls,
    autoHideToolCalls,
    setAutoHideToolCalls,
    devtoolsOpen,
    toggleDevtools,
    fontSize,
    setFontSize,
    fontFamily,
    setFontFamily,
    resetPreferences,
    showShortcutChips,
    setShowShortcutChips,
    showTaskCelebrations,
    setShowTaskCelebrations,
    enableNotificationSound,
    setEnableNotificationSound,
    enablePulseNotifications,
    setEnablePulseNotifications,
    promoEnabled,
    setPromoEnabled,
  } = useAppStore();

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
              <NavigationLayoutItem value="tools" icon={Wrench}>
                Tools
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
                <div className="space-y-4">
                  <NavigationLayoutPanelHeader
                    actions={
                      <button
                        onClick={() => {
                          resetPreferences();
                          setTheme('system');
                        }}
                        className="text-muted-foreground hover:text-foreground text-xs transition-colors duration-150"
                      >
                        Reset to defaults
                      </button>
                    }
                  >
                    Appearance
                  </NavigationLayoutPanelHeader>

                  <FieldCard>
                    <FieldCardContent>
                      <SettingRow label="Theme" description="Choose your preferred color scheme">
                        <Select value={theme} onValueChange={setTheme}>
                          <SelectTrigger className="w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="light">Light</SelectItem>
                            <SelectItem value="dark">Dark</SelectItem>
                            <SelectItem value="system">System</SelectItem>
                          </SelectContent>
                        </Select>
                      </SettingRow>

                      <SettingRow
                        label="Font family"
                        description="Choose the typeface for the interface"
                      >
                        <Select
                          value={fontFamily}
                          onValueChange={(v) => setFontFamily(v as FontFamilyKey)}
                        >
                          <SelectTrigger className="w-40">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {FONT_CONFIGS.map((font) => (
                              <SelectItem key={font.key} value={font.key}>
                                <div className="flex flex-col">
                                  <span>{font.displayName}</span>
                                  <span className="text-muted-foreground text-xs">
                                    {font.description}
                                  </span>
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </SettingRow>

                      <SettingRow
                        label="Font size"
                        description="Adjust the text size across the interface"
                      >
                        <Select
                          value={fontSize}
                          onValueChange={(v) => setFontSize(v as 'small' | 'medium' | 'large')}
                        >
                          <SelectTrigger className="w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="small">Small</SelectItem>
                            <SelectItem value="medium">Medium</SelectItem>
                            <SelectItem value="large">Large</SelectItem>
                          </SelectContent>
                        </Select>
                      </SettingRow>
                    </FieldCardContent>
                  </FieldCard>
                </div>
              </NavigationLayoutPanel>

              <NavigationLayoutPanel value="preferences">
                <div className="space-y-4">
                  <NavigationLayoutPanelHeader>Preferences</NavigationLayoutPanelHeader>

                  <FieldCard>
                    <FieldCardContent>
                      <SettingRow
                        label="Show timestamps"
                        description="Display message timestamps in chat"
                      >
                        <Switch checked={showTimestamps} onCheckedChange={setShowTimestamps} />
                      </SettingRow>

                      <SettingRow
                        label="Expand tool calls"
                        description="Auto-expand tool call details in messages"
                      >
                        <Switch checked={expandToolCalls} onCheckedChange={setExpandToolCalls} />
                      </SettingRow>

                      <SettingRow
                        label="Auto-hide tool calls"
                        description="Fade out completed tool calls after a few seconds"
                      >
                        <Switch
                          checked={autoHideToolCalls}
                          onCheckedChange={setAutoHideToolCalls}
                        />
                      </SettingRow>

                      <SettingRow
                        label="Show shortcut chips"
                        description="Display shortcut hints below the message input"
                      >
                        <Switch
                          checked={showShortcutChips}
                          onCheckedChange={setShowShortcutChips}
                        />
                      </SettingRow>

                      <SettingRow
                        label="Task celebrations"
                        description="Show animations when tasks complete"
                      >
                        <Switch
                          checked={showTaskCelebrations}
                          onCheckedChange={setShowTaskCelebrations}
                        />
                      </SettingRow>

                      <SettingRow
                        label="Notification sound"
                        description="Play a sound when AI finishes responding (3s+ responses)"
                      >
                        <Switch
                          checked={enableNotificationSound}
                          onCheckedChange={setEnableNotificationSound}
                        />
                      </SettingRow>

                      <SettingRow
                        label="Pulse run notifications"
                        description="Show a toast when a scheduled Pulse run completes"
                      >
                        <Switch
                          checked={enablePulseNotifications}
                          onCheckedChange={setEnablePulseNotifications}
                        />
                      </SettingRow>

                      <SettingRow
                        label="Feature suggestions"
                        description="Show feature discovery cards on the dashboard and sidebar"
                      >
                        <Switch checked={promoEnabled} onCheckedChange={setPromoEnabled} />
                      </SettingRow>

                      <SettingRow label="Show dev tools" description="Enable developer tools panel">
                        <Switch checked={devtoolsOpen} onCheckedChange={() => toggleDevtools()} />
                      </SettingRow>
                    </FieldCardContent>
                  </FieldCard>
                </div>
              </NavigationLayoutPanel>

              <NavigationLayoutPanel value="statusBar">
                <div className="space-y-4">
                  <NavigationLayoutPanelHeader
                    actions={
                      <button
                        onClick={resetStatusBarPreferences}
                        className="text-muted-foreground hover:text-foreground text-xs transition-colors duration-150"
                      >
                        Reset to defaults
                      </button>
                    }
                  >
                    Status Bar
                  </NavigationLayoutPanelHeader>
                  <FieldCard>
                    <FieldCardContent>
                      {STATUS_BAR_REGISTRY.map((item) => (
                        <StatusBarSettingRow key={item.key} item={item} />
                      ))}
                    </FieldCardContent>
                  </FieldCard>
                </div>
              </NavigationLayoutPanel>

              <NavigationLayoutPanel value="server">
                <div className="space-y-3">
                  <NavigationLayoutPanelHeader>Server</NavigationLayoutPanelHeader>
                  <ServerTab
                    config={config}
                    isLoading={isLoading}
                    onOpenTunnelDialog={() => setTunnelDialogOpen(true)}
                  />
                </div>
              </NavigationLayoutPanel>

              <NavigationLayoutPanel value="tools">
                <div className="space-y-4">
                  <NavigationLayoutPanelHeader>Tools</NavigationLayoutPanelHeader>
                  <ToolsTab />
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
