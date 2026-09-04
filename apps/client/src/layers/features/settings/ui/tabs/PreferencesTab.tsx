import { useQueryClient } from '@tanstack/react-query';
import { useAppStore, useSettingsDeepLink } from '@/layers/shared/model';
import {
  useComposerRichText,
  useUpdateComposerPrefs,
  useUpdateConfig,
} from '@/layers/entities/config';
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
 * Preferences tab — how chat looks and behaves, and what the app offers you.
 *
 * Two groups, not one flat stack (DOR-1758): **Chat** is everything about the
 * conversation in front of you, including the two switches that came back from
 * the old Advanced tab (the message box, and watching for agents started
 * elsewhere); **Discovery** is the two rows about being shown something again.
 * The developer-panel switch left for Settings → Experiments, where a debugging
 * aid belongs.
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
    showTaskCelebrations,
    setShowTaskCelebrations,
    promoEnabled,
    setPromoEnabled,
    enableMessagePolling,
    setEnableMessagePolling,
    setOnboardingHiddenForSession,
  } = useAppStore();
  const richText = useComposerRichText();
  const { setRichText } = useUpdateComposerPrefs();
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
    <div className="space-y-6">
      <section className="space-y-2">
        {/* Muted/uppercase/tracking, not the panel title's own size and
            weight — a screen reader (and the eye) needs one heading read as
            the panel and this one read as subordinate to it, the way the
            sidebar's own group labels already do (review nit). */}
        <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
          Chat
        </h3>
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

            {/*
             * Formatting as you type is ON by default since the owner's
             * 2026-08-12 call, so this switch is no longer an opt-in — it is the
             * way out.
             *
             * That is why it stays visible. Someone whose message box misbehaves
             * can put it back without finding and hand-editing
             * `~/.dork/config.json`, and a kill-switch has to be reachable when
             * the thing it gates is what broke. With the feature on for everyone,
             * that reachability matters more than it did as an opt-in, not less.
             *
             * The fair counter-argument is that a switch here is a promise to
             * carry both fields forever. The exit plan answers it, unchanged in
             * shape: this row, the `richText` prop, `TextareaField` and the whole
             * plain path come out together. What that cleanup now waits on is the
             * nested-list serialize fix, not a default flip. Removing this row is
             * its obvious first move, not a discovery someone has to make.
             */}
            <SwitchSettingRow
              label="Format text as you type"
              description="See bold, headings, and lists take shape in the message box while you write."
              checked={richText}
              onCheckedChange={setRichText}
            />

            <SwitchSettingRow
              label="Watch for agents you started somewhere else"
              description="Turn this on if work you started in a terminal takes a while to show up here."
              checked={enableMessagePolling}
              onCheckedChange={setEnableMessagePolling}
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
          </FieldCardContent>
        </FieldCard>
      </section>

      <WelcomeBackCard />

      <section className="space-y-2">
        <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
          Discovery
        </h3>
        <FieldCard>
          <FieldCardContent>
            <SwitchSettingRow
              label="Feature suggestions"
              description="Show feature discovery cards on the dashboard and sidebar"
              checked={promoEnabled}
              onCheckedChange={setPromoEnabled}
            />

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
      </section>
    </div>
  );
}
