import { useAppStore } from '@/layers/shared/model';
import {
  Switch,
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
  } = useAppStore();

  return (
    <div className="space-y-4">
      <NavigationLayoutPanelHeader>Preferences</NavigationLayoutPanelHeader>

      <FieldCard>
        <FieldCardContent>
          <SettingRow label="Show timestamps" description="Display message timestamps in chat">
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

          <SettingRow label="Task celebrations" description="Show animations when tasks complete">
            <Switch checked={showTaskCelebrations} onCheckedChange={setShowTaskCelebrations} />
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
            label="Tasks run notifications"
            description="Show a toast when a scheduled Tasks run completes"
          >
            <Switch
              checked={enableTasksNotifications}
              onCheckedChange={setEnableTasksNotifications}
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
  );
}
