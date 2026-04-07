import { useState, useCallback, useMemo } from 'react';
import { AnimatePresence } from 'motion/react';
import { Sun, Moon, Monitor, Globe } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DorkLogo } from '@dorkos/icons/logos';
import {
  useAppStore,
  useSettingsDeepLink,
  useSlotContributions,
  useTheme,
  useTransport,
  type Theme,
} from '@/layers/shared/model';
import { cn, getPlatform } from '@/layers/shared/lib';
import { useTunnelStatus } from '@/layers/entities/tunnel';
import { TunnelDialog } from '@/layers/features/settings';
import { isNewer, isFeatureUpdate } from '@/layers/features/status';
import { SidebarUpgradeCard } from './SidebarUpgradeCard';

const THEME_ORDER: Theme[] = ['light', 'dark', 'system'];

const THEME_ICONS = {
  light: Sun,
  dark: Moon,
  system: Monitor,
} as const;

/**
 * Bottom bar for the sidebar footer. Shows branding link, settings gear button,
 * theme cycle toggle (light → dark → system), a devtools toggle in DEV mode,
 * a version row at the very bottom, and an upgrade card above the bar when
 * a newer version is available.
 */
export function SidebarFooterBar() {
  const { devtoolsOpen } = useAppStore();
  const { theme, setTheme } = useTheme();
  const ThemeIcon = THEME_ICONS[theme];
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [tunnelDialogOpen, setTunnelDialogOpen] = useState(false);
  const { data: liveStatus } = useTunnelStatus();
  const { open: openSettings } = useSettingsDeepLink();

  const footerButtons = useSlotContributions('sidebar.footer');
  const filteredButtons = useMemo(
    () => footerButtons.filter((b) => !b.showInDevOnly || import.meta.env.DEV),
    [footerButtons]
  );

  const { data: serverConfig } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 5 * 60 * 1000,
  });

  const version = serverConfig?.version;
  const latestVersion = serverConfig?.latestVersion ?? null;
  const isDevMode = serverConfig?.isDevMode ?? false;
  const dismissedVersions = useMemo(
    () => serverConfig?.dismissedUpgradeVersions ?? [],
    [serverConfig?.dismissedUpgradeVersions]
  );

  const hasUpdate =
    latestVersion !== null && version !== undefined && isNewer(latestVersion, version);
  const isFeature = hasUpdate && isFeatureUpdate(latestVersion!, version!);
  const isDismissed = hasUpdate && dismissedVersions.includes(latestVersion!);

  const [patchCardOpen, setPatchCardOpen] = useState(false);
  const showCard = hasUpdate && !isDismissed && (isFeature || patchCardOpen);

  const handleDismissVersion = useCallback(
    async (dismissVersion: string) => {
      const updated = [...dismissedVersions, dismissVersion];
      await transport.updateConfig({ ui: { dismissedUpgradeVersions: updated } });
      queryClient.invalidateQueries({ queryKey: ['config'] });
      setPatchCardOpen(false);
    },
    [dismissedVersions, transport, queryClient]
  );

  const cycleTheme = useCallback(() => {
    const idx = THEME_ORDER.indexOf(theme);
    setTheme(THEME_ORDER[(idx + 1) % THEME_ORDER.length]);
  }, [theme, setTheme]);

  return (
    <div>
      <AnimatePresence>
        {showCard && (
          <SidebarUpgradeCard
            key="upgrade-card"
            currentVersion={version!}
            latestVersion={latestVersion!}
            isFeature={isFeature}
            onDismiss={handleDismissVersion}
          />
        )}
      </AnimatePresence>

      <div className="flex items-center px-2 py-1.5">
        <a
          href="https://dorkos.ai"
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground/50 hover:text-muted-foreground transition-colors duration-150"
        >
          <DorkLogo variant="current" size={60} />
        </a>
        <div className="ml-auto flex items-center gap-0.5">
          {serverConfig?.tunnel && !getPlatform().isEmbedded && (
            <>
              <button
                onClick={() => setTunnelDialogOpen(true)}
                className={cn(
                  'relative rounded-md p-1 transition-colors duration-150',
                  'text-muted-foreground/50 hover:text-muted-foreground'
                )}
                aria-label={
                  (liveStatus ?? serverConfig.tunnel).connected
                    ? `Remote connected: ${new URL((liveStatus ?? serverConfig.tunnel).url!).hostname}`
                    : 'Remote disconnected'
                }
              >
                <Globe className="size-(--size-icon-sm)" />
                <span
                  className={cn(
                    'absolute top-0.5 right-0.5 size-1.5 rounded-full transition-colors duration-300',
                    (liveStatus ?? serverConfig.tunnel).connected ? 'bg-green-500' : 'bg-gray-400'
                  )}
                />
              </button>
              <TunnelDialog open={tunnelDialogOpen} onOpenChange={setTunnelDialogOpen} />
            </>
          )}
          {filteredButtons.map((button) => {
            // Theme button needs dynamic icon based on current theme
            const Icon = button.id === 'theme' ? ThemeIcon : button.icon;
            // Override click handlers for buttons whose behavior requires React hooks
            // (see sidebar-contributions.ts for the placeholder onClick comments).
            const handleClick =
              button.id === 'theme'
                ? cycleTheme
                : button.id === 'settings'
                  ? () => openSettings()
                  : button.onClick;
            const label = button.id === 'theme' ? `Theme: ${theme}. Click to cycle.` : button.label;

            return (
              <button
                key={button.id}
                onClick={handleClick}
                className={cn(
                  'rounded-md p-1 transition-colors duration-150',
                  button.id === 'devtools' && devtoolsOpen
                    ? 'text-amber-500'
                    : button.id === 'devtools'
                      ? 'text-amber-500/60 hover:text-amber-500'
                      : 'text-muted-foreground/50 hover:text-muted-foreground'
                )}
                aria-label={label}
                title={button.id === 'theme' ? `Theme: ${theme}` : undefined}
              >
                <Icon className="size-(--size-icon-sm)" />
              </button>
            );
          })}
        </div>
      </div>

      {/* Version row */}
      <div
        className={cn(
          '-mt-1 px-2 pb-1.5 text-[10px]',
          hasUpdate && !isDismissed && !isFeature ? 'cursor-pointer' : 'cursor-default',
          isDevMode ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
        )}
        onClick={
          hasUpdate && !isDismissed && !isFeature ? () => setPatchCardOpen((v) => !v) : undefined
        }
        onKeyDown={
          hasUpdate && !isDismissed && !isFeature
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setPatchCardOpen((v) => !v);
                }
              }
            : undefined
        }
        role={hasUpdate && !isDismissed && !isFeature ? 'button' : undefined}
        tabIndex={hasUpdate && !isDismissed && !isFeature ? 0 : undefined}
        aria-label={isDevMode ? 'Development build' : version ? `Version ${version}` : undefined}
      >
        {isDevMode ? (
          'DEV'
        ) : version ? (
          <span className="inline-flex items-center gap-1">
            v{version} <span className="text-muted-foreground/50">beta</span>
            {hasUpdate && !isDismissed && (
              <span
                className={cn(
                  'inline-block size-1.5 rounded-full',
                  isFeature ? 'bg-amber-500' : 'bg-muted-foreground/50'
                )}
                aria-hidden="true"
              />
            )}
          </span>
        ) : null}
      </div>
    </div>
  );
}
