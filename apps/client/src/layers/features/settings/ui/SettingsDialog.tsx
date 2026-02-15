import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTransport, useAppStore, useTheme } from '@/layers/shared/model';
import { cn, FONT_CONFIGS, type FontFamilyKey } from '@/layers/shared/lib';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  Switch,
  Label,
  Badge,
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

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { theme, setTheme } = useTheme();
  const [activeTab, setActiveTab] = useState('appearance');
  const {
    showTimestamps, setShowTimestamps,
    expandToolCalls, setExpandToolCalls,
    autoHideToolCalls, setAutoHideToolCalls,
    devtoolsOpen, toggleDevtools,
    verboseLogging, setVerboseLogging,
    fontSize, setFontSize,
    fontFamily, setFontFamily,
    resetPreferences,
    showStatusBarCwd, setShowStatusBarCwd,
    showStatusBarPermission, setShowStatusBarPermission,
    showStatusBarModel, setShowStatusBarModel,
    showStatusBarCost, setShowStatusBarCost,
    showStatusBarContext, setShowStatusBarContext,
    showStatusBarGit, setShowStatusBarGit,
    showShortcutChips, setShowShortcutChips,
    showTaskCelebrations, setShowTaskCelebrations,
    enableNotificationSound, setEnableNotificationSound,
    showStatusBarSound, setShowStatusBarSound,
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
      <ResponsiveDialogContent className="max-w-lg p-0 gap-0">
        <ResponsiveDialogHeader className="px-4 py-3 border-b space-y-0">
          <ResponsiveDialogTitle className="text-sm font-medium">Settings</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col flex-1 overflow-hidden">
          <TabsList className="grid w-full grid-cols-4 mx-4 mt-3" style={{ width: 'calc(100% - 2rem)' }}>
            <TabsTrigger value="appearance">Appearance</TabsTrigger>
            <TabsTrigger value="preferences">Preferences</TabsTrigger>
            <TabsTrigger value="statusBar">Status Bar</TabsTrigger>
            <TabsTrigger value="server">Server</TabsTrigger>
          </TabsList>

          <div className="overflow-y-auto flex-1 p-4 min-h-[280px]">
            <TabsContent value="appearance" className="mt-0 space-y-6">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-foreground">Appearance</h3>
                  <button
                    onClick={() => { resetPreferences(); setTheme('system'); }}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors duration-150"
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
                  <Select value={fontFamily} onValueChange={(v) => setFontFamily(v as FontFamilyKey)}>
                    <SelectTrigger className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FONT_CONFIGS.map((font) => (
                        <SelectItem key={font.key} value={font.key}>
                          <div className="flex flex-col">
                            <span>{font.displayName}</span>
                            <span className="text-xs text-muted-foreground">{font.description}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingRow>

                <SettingRow label="Font size" description="Adjust the text size across the interface">
                  <Select value={fontSize} onValueChange={(v) => setFontSize(v as 'small' | 'medium' | 'large')}>
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
                <h3 className="text-sm font-semibold text-foreground">Preferences</h3>

                <SettingRow label="Show timestamps" description="Display message timestamps in chat">
                  <Switch checked={showTimestamps} onCheckedChange={setShowTimestamps} />
                </SettingRow>

                <SettingRow label="Expand tool calls" description="Auto-expand tool call details in messages">
                  <Switch checked={expandToolCalls} onCheckedChange={setExpandToolCalls} />
                </SettingRow>

                <SettingRow label="Auto-hide tool calls" description="Fade out completed tool calls after a few seconds">
                  <Switch checked={autoHideToolCalls} onCheckedChange={setAutoHideToolCalls} />
                </SettingRow>

                <SettingRow label="Show shortcut chips" description="Display shortcut hints below the message input">
                  <Switch checked={showShortcutChips} onCheckedChange={setShowShortcutChips} />
                </SettingRow>

                <SettingRow label="Task celebrations" description="Show animations when tasks complete">
                  <Switch checked={showTaskCelebrations} onCheckedChange={setShowTaskCelebrations} />
                </SettingRow>

                <SettingRow label="Notification sound" description="Play a sound when AI finishes responding (3s+ responses)">
                  <Switch checked={enableNotificationSound} onCheckedChange={setEnableNotificationSound} />
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
              <SettingRow label="Show git status" description="Display branch name and change count">
                <Switch checked={showStatusBarGit} onCheckedChange={setShowStatusBarGit} />
              </SettingRow>
              <SettingRow label="Show permission mode" description="Display current permission setting">
                <Switch checked={showStatusBarPermission} onCheckedChange={setShowStatusBarPermission} />
              </SettingRow>
              <SettingRow label="Show model" description="Display selected AI model">
                <Switch checked={showStatusBarModel} onCheckedChange={setShowStatusBarModel} />
              </SettingRow>
              <SettingRow label="Show cost" description="Display session cost in USD">
                <Switch checked={showStatusBarCost} onCheckedChange={setShowStatusBarCost} />
              </SettingRow>
              <SettingRow label="Show context usage" description="Display context window utilization">
                <Switch checked={showStatusBarContext} onCheckedChange={setShowStatusBarContext} />
              </SettingRow>
              <SettingRow label="Show sound toggle" description="Display notification sound toggle">
                <Switch checked={showStatusBarSound} onCheckedChange={setShowStatusBarSound} />
              </SettingRow>
            </TabsContent>

            <TabsContent value="server" className="mt-0 space-y-3">
              {/* Server Section */}
              <h3 className="text-sm font-semibold text-foreground">Server</h3>

              {isLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="flex items-center justify-between py-1">
                      <div className="h-4 w-24 rounded bg-muted animate-pulse" />
                      <div className="h-4 w-16 rounded bg-muted animate-pulse" />
                    </div>
                  ))}
                </div>
              ) : config ? (
                <div className="space-y-1">
                  <ConfigRow label="Version" value={config.version} />
                  <ConfigRow label="Port" value={String(config.port)} />
                  <ConfigRow label="Uptime" value={formatUptime(config.uptime)} />
                  <ConfigRow label="Working Directory" value={config.workingDirectory} mono truncate />
                  <ConfigRow label="Node.js" value={config.nodeVersion} />
                  <ConfigRow
                    label="Claude CLI"
                    value={config.claudeCliPath || 'Not found'}
                    mono
                    truncate
                    muted={!config.claudeCliPath}
                  />

                  <ConfigBadgeRow
                    label="Tunnel"
                    value={config.tunnel.enabled ? 'Enabled' : 'Disabled'}
                    variant={config.tunnel.enabled ? 'default' : 'secondary'}
                  />

                  {config.tunnel.enabled && (
                    <>
                      <ConfigBadgeRow
                        label="Tunnel Status"
                        value={config.tunnel.connected ? 'Connected' : 'Disconnected'}
                        variant={config.tunnel.connected ? 'default' : 'secondary'}
                      />

                      {config.tunnel.url && (
                        <ConfigRow label="Tunnel URL" value={config.tunnel.url} mono />
                      )}

                      <ConfigRow
                        label="Tunnel Auth"
                        value={config.tunnel.authEnabled ? 'Enabled' : 'Disabled'}
                      />

                      <ConfigBadgeRow
                        label="ngrok Token"
                        value={config.tunnel.tokenConfigured ? 'Configured' : 'Not configured'}
                        variant={config.tunnel.tokenConfigured ? 'default' : 'secondary'}
                      />
                    </>
                  )}
                </div>
              ) : null}
            </TabsContent>
          </div>
        </Tabs>
      </ResponsiveDialogContent>
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
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}

function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, []);
  return { copied, copy };
}

function ConfigRow({
  label,
  value,
  mono,
  truncate,
  muted,
}: {
  label: string;
  value: string;
  mono?: boolean;
  truncate?: boolean;
  muted?: boolean;
}) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      onClick={() => copy(value)}
      className="flex w-full items-center justify-between py-1 gap-4 rounded -mx-1 px-1 hover:bg-muted/50 active:bg-muted/70 transition-colors duration-100"
    >
      <span className="text-sm text-muted-foreground shrink-0">{label}</span>
      {copied ? (
        <span className="text-xs text-muted-foreground">Copied</span>
      ) : (
        <span
          className={cn(
            'text-sm text-right',
            mono && 'font-mono',
            truncate && 'min-w-0 max-w-48 truncate',
            muted && 'text-muted-foreground',
          )}
          dir={truncate ? 'rtl' : undefined}
          title={value}
        >
          {value}
        </span>
      )}
    </button>
  );
}

function ConfigBadgeRow({
  label,
  value,
  variant,
}: {
  label: string;
  value: string;
  variant: 'default' | 'secondary';
}) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      onClick={() => copy(value)}
      className="flex w-full items-center justify-between py-1 rounded -mx-1 px-1 hover:bg-muted/50 active:bg-muted/70 transition-colors duration-100"
    >
      <span className="text-sm text-muted-foreground">{label}</span>
      {copied ? (
        <span className="text-xs text-muted-foreground">Copied</span>
      ) : (
        <Badge variant={variant}>{value}</Badge>
      )}
    </button>
  );
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}
