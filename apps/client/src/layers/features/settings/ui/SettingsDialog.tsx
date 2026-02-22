import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTransport, useAppStore, useTheme } from '@/layers/shared/model';
import { FONT_CONFIGS, type FontFamilyKey } from '@/layers/shared/lib';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  Switch,
  Label,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui';
import { ServerTab } from './ServerTab';
import { TunnelDialog } from './TunnelDialog';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { theme, setTheme } = useTheme();
  const [activeTab, setActiveTab] = useState('appearance');
  const [tunnelDialogOpen, setTunnelDialogOpen] = useState(false);
  const {
    showTimestamps,
    setShowTimestamps,
    expandToolCalls,
    setExpandToolCalls,
    autoHideToolCalls,
    setAutoHideToolCalls,
    devtoolsOpen,
    toggleDevtools,
    verboseLogging,
    setVerboseLogging,
    fontSize,
    setFontSize,
    fontFamily,
    setFontFamily,
    resetPreferences,
    showStatusBarCwd,
    setShowStatusBarCwd,
    showStatusBarPermission,
    setShowStatusBarPermission,
    showStatusBarModel,
    setShowStatusBarModel,
    showStatusBarCost,
    setShowStatusBarCost,
    showStatusBarContext,
    setShowStatusBarContext,
    showStatusBarGit,
    setShowStatusBarGit,
    showShortcutChips,
    setShowShortcutChips,
    showTaskCelebrations,
    setShowTaskCelebrations,
    enableNotificationSound,
    setEnableNotificationSound,
    enablePulseNotifications,
    setEnablePulseNotifications,
    showStatusBarSound,
    setShowStatusBarSound,
    showStatusBarTunnel,
    setShowStatusBarTunnel,
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
      <ResponsiveDialogContent className="max-w-lg gap-0 p-0">
        <ResponsiveDialogHeader className="space-y-0 border-b px-4 py-3">
          <ResponsiveDialogTitle className="text-sm font-medium">Settings</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex flex-1 flex-col overflow-hidden"
        >
          <TabsList
            className="mx-4 mt-3 grid w-full grid-cols-4"
            style={{ width: 'calc(100% - 2rem)' }}
          >
            <TabsTrigger value="appearance">Appearance</TabsTrigger>
            <TabsTrigger value="preferences">Preferences</TabsTrigger>
            <TabsTrigger value="statusBar">Status Bar</TabsTrigger>
            <TabsTrigger value="server">Server</TabsTrigger>
          </TabsList>

          <div className="min-h-[280px] flex-1 overflow-y-auto p-4">
            <TabsContent value="appearance" className="mt-0 space-y-6">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-foreground text-sm font-semibold">Appearance</h3>
                  <button
                    onClick={() => {
                      resetPreferences();
                      setTheme('system');
                    }}
                    className="text-muted-foreground hover:text-foreground text-xs transition-colors duration-150"
                  >
                    Reset to defaults
                  </button>
                </div>

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

                <SettingRow label="Font family" description="Choose the typeface for the interface">
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
              </div>
            </TabsContent>

            <TabsContent value="preferences" className="mt-0 space-y-6">
              <div className="space-y-4">
                <h3 className="text-foreground text-sm font-semibold">Preferences</h3>

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
                  <Switch checked={autoHideToolCalls} onCheckedChange={setAutoHideToolCalls} />
                </SettingRow>

                <SettingRow
                  label="Show shortcut chips"
                  description="Display shortcut hints below the message input"
                >
                  <Switch checked={showShortcutChips} onCheckedChange={setShowShortcutChips} />
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

                <SettingRow label="Show dev tools" description="Enable developer tools panel">
                  <Switch checked={devtoolsOpen} onCheckedChange={() => toggleDevtools()} />
                </SettingRow>

                <SettingRow label="Verbose logging" description="Show detailed logs in the console">
                  <Switch checked={verboseLogging} onCheckedChange={setVerboseLogging} />
                </SettingRow>
              </div>
            </TabsContent>

            <TabsContent value="statusBar" className="mt-0 space-y-4">
              <SettingRow label="Show directory" description="Display current working directory">
                <Switch checked={showStatusBarCwd} onCheckedChange={setShowStatusBarCwd} />
              </SettingRow>
              <SettingRow
                label="Show git status"
                description="Display branch name and change count"
              >
                <Switch checked={showStatusBarGit} onCheckedChange={setShowStatusBarGit} />
              </SettingRow>
              <SettingRow
                label="Show permission mode"
                description="Display current permission setting"
              >
                <Switch
                  checked={showStatusBarPermission}
                  onCheckedChange={setShowStatusBarPermission}
                />
              </SettingRow>
              <SettingRow label="Show model" description="Display selected AI model">
                <Switch checked={showStatusBarModel} onCheckedChange={setShowStatusBarModel} />
              </SettingRow>
              <SettingRow label="Show cost" description="Display session cost in USD">
                <Switch checked={showStatusBarCost} onCheckedChange={setShowStatusBarCost} />
              </SettingRow>
              <SettingRow
                label="Show context usage"
                description="Display context window utilization"
              >
                <Switch checked={showStatusBarContext} onCheckedChange={setShowStatusBarContext} />
              </SettingRow>
              <SettingRow label="Show sound toggle" description="Display notification sound toggle">
                <Switch checked={showStatusBarSound} onCheckedChange={setShowStatusBarSound} />
              </SettingRow>
              <SettingRow label="Show tunnel" description="Display tunnel status and control">
                <Switch checked={showStatusBarTunnel} onCheckedChange={setShowStatusBarTunnel} />
              </SettingRow>
            </TabsContent>

            <TabsContent value="server" className="mt-0">
              <ServerTab config={config} isLoading={isLoading} onOpenTunnelDialog={() => setTunnelDialogOpen(true)} />
            </TabsContent>
          </div>
        </Tabs>
      </ResponsiveDialogContent>
      <TunnelDialog open={tunnelDialogOpen} onOpenChange={setTunnelDialogOpen} />
    </ResponsiveDialog>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <Label className="text-sm font-medium">{label}</Label>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      {children}
    </div>
  );
}
