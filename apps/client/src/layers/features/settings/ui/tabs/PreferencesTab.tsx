import { useQueryClient } from '@tanstack/react-query';
import { useAppStore, useSettingsDeepLink } from '@/layers/shared/model';
import { useUpdateConfig } from '@/layers/entities/config';
import {
  Button,
  SwitchSettingRow,
  SettingRow,
  FieldCard,
  FieldCardContent,
} from '@/layers/shared/ui';
import { WelcomeBackCard } from '../WelcomeBackCard';
import { configKeys } from '@/layers/entities/config';

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
    showTaskCelebrations,
    setShowTaskCelebrations,
    promoEnabled,
    setPromoEnabled,
    setOnboardingHiddenForSession,
  } = useAppStore();
  const { close: closeSettings } = useSettingsDeepLink();
  const updateConfig = useUpdateConfig();
  const queryClient = useQueryClient();

  /**
   * Reopen the first-run setup flow: clear the authoritative completion signals
   * (`completedAt`/`dismissedAt`) and step history, drop the session-local
   * suppression flag, and close Settings so the overlay is visible.
   *
   * Closing goes through the deep-link `close()`, which owns both halves of the
   * dialog's open state. The store flag alone is not enough: the skip-setup
   * toast's own "Replay setup" action opens this tab via `?settings=preferences`,
   * and that param kept the dialog parked over the welcome screen (DOR-839).
   */
  const replaySetup = () => {
    updateConfig.mutate(
      {
        onboarding: {
          completedSteps: [],
          skippedSteps: [],
          startedAt: null,
          dismissedAt: null,
          completedAt: null,
        },
      },
      {
        onSuccess: () => {
          // The prefix rather than the one key: every derived config query
          // hangs off `configKeys.all`, so this is what makes the overlay
          // reopen immediately.
          void queryClient.invalidateQueries({ queryKey: configKeys.all });
        },
      }
    );
    setOnboardingHiddenForSession(false);
    closeSettings();
  };

  return (
    <div className="space-y-4">
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
            label="To-do celebrations"
            description="Show animations when to-dos complete"
            checked={showTaskCelebrations}
            onCheckedChange={setShowTaskCelebrations}
          />

          {/* "Notification sound" used to sit here. Every sound DorkOS makes is
              now on the Notifications tab, beside the browser-notification and
              escalation settings — one place to answer "how loud may this be?"
              rather than one switch here and another in a session's popover. */}

          {/* "Scheduled run notifications" used to sit here, promising a toast
              when a scheduled task finished. No code ever rendered that toast —
              nothing in the client subscribed to task-run completion — so the
              setting was a promise nobody kept. Removed rather than wired,
              since there is no task-run-finished event to hang it on yet
              (DOR-1522). Reintroduce it once that event exists. */}

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

      <WelcomeBackCard />

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
