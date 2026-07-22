import { useAppStore } from '@/layers/shared/model';
import { useUpdateConfig } from '@/layers/entities/config';
import {
  Button,
  SwitchSettingRow,
  SettingRow,
  FieldCard,
  FieldCardContent,
  NavigationLayoutPanelHeader,
} from '@/layers/shared/ui';

/**
 * Preferences tab — chat display, notification, and developer toggles.
 *
 * Reads its own state from `useAppStore` directly, mirroring the inline body
 * that previously lived in `SettingsDialog.tsx`. Rendered inside a
 * `<NavigationLayoutPanel value="preferences">` by the dialog shell.
 */
export function PreferencesTab() {
  const {
    showTimestamps,
    setShowTimestamps,
    expandToolCalls,
    setExpandToolCalls,
    autoHideToolCalls,
    setAutoHideToolCalls,
    devtoolsOpen,
    toggleDevtools,
    showShortcutChips,
    setShowShortcutChips,
    showTaskCelebrations,
    setShowTaskCelebrations,
    enableNotificationSound,
    setEnableNotificationSound,
    enableTasksNotifications,
    setEnableTasksNotifications,
    promoEnabled,
    setPromoEnabled,
    setSettingsOpen,
    setOnboardingHiddenForSession,
  } = useAppStore();
  const updateConfig = useUpdateConfig();

  /**
   * Reopen the first-run setup flow: clear the authoritative completion signals
   * (`completedAt`/`dismissedAt`) and step history, drop the session-local
   * suppression flag, and close Settings so the overlay is visible.
   */
  const replaySetup = () => {
    updateConfig.mutate({
      onboarding: {
        completedSteps: [],
        skippedSteps: [],
        startedAt: null,
        dismissedAt: null,
        completedAt: null,
      },
    });
    setOnboardingHiddenForSession(false);
    setSettingsOpen(false);
  };

  return (
    <div className="space-y-4">
      <NavigationLayoutPanelHeader>Preferences</NavigationLayoutPanelHeader>

      <FieldCard>
        <FieldCardContent>
          <SwitchSettingRow
            label="Show timestamps"
            description="Display message timestamps in chat"
            checked={showTimestamps}
            onCheckedChange={setShowTimestamps}
          />

          <SwitchSettingRow
            label="Expand tool calls"
            description="Auto-expand tool call details in messages"
            checked={expandToolCalls}
            onCheckedChange={setExpandToolCalls}
          />

          <SwitchSettingRow
            label="Auto-hide tool calls"
            description="Fade out completed tool calls after a few seconds"
            checked={autoHideToolCalls}
            onCheckedChange={setAutoHideToolCalls}
          />

          <SwitchSettingRow
            label="Show shortcut chips"
            description="Display shortcut hints below the message input"
            checked={showShortcutChips}
            onCheckedChange={setShowShortcutChips}
          />

          <SwitchSettingRow
            label="Task celebrations"
            description="Show animations when tasks complete"
            checked={showTaskCelebrations}
            onCheckedChange={setShowTaskCelebrations}
          />

          <SwitchSettingRow
            label="Notification sound"
            description="Play a sound when AI finishes responding (3s+ responses)"
            checked={enableNotificationSound}
            onCheckedChange={setEnableNotificationSound}
          />

          <SwitchSettingRow
            label="Tasks run notifications"
            description="Show a toast when a scheduled Tasks run completes"
            checked={enableTasksNotifications}
            onCheckedChange={setEnableTasksNotifications}
          />

          <SwitchSettingRow
            label="Feature suggestions"
            description="Show feature discovery cards on the dashboard and sidebar"
            checked={promoEnabled}
            onCheckedChange={setPromoEnabled}
          />

          <SwitchSettingRow
            label="Show dev tools"
            description="Enable developer tools panel"
            checked={devtoolsOpen}
            onCheckedChange={() => toggleDevtools()}
          />
        </FieldCardContent>
      </FieldCard>

      <FieldCard>
        <FieldCardContent>
          <SettingRow
            label="Replay setup"
            description="Walk through the first-run setup again from the beginning"
          >
            <Button
              variant="outline"
              size="sm"
              onClick={replaySetup}
              disabled={updateConfig.isPending}
            >
              Replay setup
            </Button>
          </SettingRow>
        </FieldCardContent>
      </FieldCard>
    </div>
  );
}
