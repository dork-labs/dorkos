import { NotificationStore } from '../services/notifications/notification-store.js';
import {
  NotificationService,
  setNotificationService,
} from '../services/notifications/notification-service.js';
import { NotifyBudget } from '../services/relay/notify-budget.js';
import { PushSubscriptionStore } from '../services/notifications/push-subscription-store.js';
import { WebPushChannel } from '../services/notifications/channels/web-push.js';
import {
  setEscalationService,
  EscalationService,
} from '../services/notifications/escalation-service.js';
import { NOTIFICATION_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import { configManager } from '../services/core/config-manager.js';
import { watchSessionLifecycle } from '../services/notifications/emitters/session-lifecycle.js';
import {
  startLimitPlanning,
  installContinueService,
  installResumeService,
} from '../services/session/index.js';
import { probeForReset } from '../services/runtimes/claude-code/accounts/account-probe.js';
import { watchAskResolution } from '../services/notifications/emitters/ask-resolution.js';
import { watchRuntimeSigninFailures } from '../services/notifications/emitters/runtime-signin.js';
import { watchCreditsRefusals } from '../services/notifications/emitters/credits-refused.js';
import { announceInstalledVersion } from '../services/notifications/emitters/update-installed.js';
import { warnAboutGitProtection } from '../lib/git-safety.js';
import { watchShiftReport } from '../services/notifications/emitters/shift-report.js';
import type { Db } from '@dorkos/db';
import type { ActivityService } from '../services/activity/activity-service.js';
import type { RelayChannelDeps } from '../services/notifications/channels/relay.js';

/** Wire the notification owners at their original boot frontier with live launch and relay reads. */
export function wireStartupNotifications({
  db,
  dorkHome,
  readRelayChannelDeps,
  activityService,
  continueLaunchDeps,
  resumeLaunchDeps,
  setStopSessionContinuation,
}: {
  db: Db;
  dorkHome: string;
  readRelayChannelDeps: () => RelayChannelDeps | undefined;
  activityService: ActivityService;
  continueLaunchDeps: Parameters<typeof installContinueService>[0]['launchDeps'];
  resumeLaunchDeps: Parameters<typeof installResumeService>[0]['launchDeps'];
  setStopSessionContinuation: (stop: () => void) => void;
}) {
  // The notification pipeline (spec `notification-system`), built EARLY and
  // deliberately: the dead-letter hook and the mesh liveness observer both
  // subscribe further down, and a notification raised between their
  // subscription and this line would be lost. The only thing it needs now is
  // the database; its out-of-app leg is read per send from `relayChannelDeps`,
  // which the relay wiring assigns once the adapters exist.
  //
  // Every seam that RAISES a notification calls the module-level `notify`
  // rather than holding this, so a projector, an MCP tool and a route do not
  // each grow a dependency on the inbox in order to say one sentence.
  const notificationStore = new NotificationStore(db);
  const notificationService = new NotificationService(notificationStore, {
    relay: () => readRelayChannelDeps(),
  });
  setNotificationService(notificationService);

  // The hourly allowance that bounds how often an agent may interrupt a person.
  // Built HERE rather than beside the MCP tool deps it used to live in, because
  // two things spend it now: `relay_notify_user` and the escalation ladder. Two
  // budgets would be two ceilings, which is one ceiling too many.
  const notifyBudget = new NotifyBudget();

  // The escalation ladder (spec `notification-system` task 4.3,
  // ADR 260819-234829): what happens when nobody answers. Built beside the
  // pipeline for the same boot-order reason — a session that errors during
  // startup arms a timer through the module-level `armEscalation`, which is a
  // no-op until this line runs.
  const pushSubscriptions = new PushSubscriptionStore(db);
  const webPushChannel = new WebPushChannel({ dorkHome, subscriptions: pushSubscriptions });
  setEscalationService(
    new EscalationService({
      store: notificationStore,
      push: webPushChannel,
      relay: () => readRelayChannelDeps(),
      // Read live, never cached: turning the knob to `never` has to silence a
      // timer that is already running, not only the next one.
      readDelay: () =>
        configManager.get('notifications')?.escalation?.phoneAfterMinutes ??
        NOTIFICATION_PREFS_DEFAULTS.escalation.phoneAfterMinutes,
      reserveNote: (agentId) => notifyBudget.tryReserve(agentId),
    })
  );

  // A finished turn, and the history row an error leaves when it clears.
  watchSessionLifecycle();
  // What happens next when a session's account runs out: its plan and state,
  // the advisor's claims, and the recorder behind `accounts.markContinued`
  // (spec claude-account-fleet D9 and §X). After the usage store, which it
  // watches, and the Activity feed, which records each move.
  {
    const stopPlanning = startLimitPlanning();
    const uninstallContinue = installContinueService({
      activity: activityService,
      // Read when an automatic handoff fires, long after boot: the app and its
      // Mesh and room ports exist by then (the app is created further down).
      launchDeps: continueLaunchDeps,
    });
    // Waits for an account's reset, confirms it with a reading and resumes the
    // session by itself. After the planner, which settles pre-restart `auto`
    // plans before this re-arms the stored waits.
    const uninstallResume = installResumeService({
      launchDeps: resumeLaunchDeps,
      // Task 2.2's idle probe, for an account the store cannot confirm on its
      // own. An account it cannot probe is still confirmed from store readings.
      probe: probeForReset,
    });
    setStopSessionContinuation(() => {
      uninstallResume();
      stopPlanning();
      uninstallContinue();
    });
  }
  // How every Ask ended — including the ones nobody answered.
  watchAskResolution();
  // A runtime whose sign-in stopped working, noticed at whichever turn trips
  // over it first — including the 3am ones nobody is watching (DOR-1654).
  watchRuntimeSigninFailures();
  // A turn DorkOS credits refused, told whoever started it, so a refused
  // scheduled task or room turn is never silent (ADR 261001-000811).
  watchCreditsRefusals();
  // Nothing tells the server it was updated, so it compares versions on boot.
  void announceInstalledVersion(dorkHome);
  // Git older than 2.38 cannot refuse a folder set up to look like a git
  // repository; say so once, in plain words (DOR-2326).
  void warnAboutGitProtection();
  // "While you were away" — composed once the day's first activity arrives.
  watchShiftReport(notificationStore);

  return { notificationService, notifyBudget, pushSubscriptions, webPushChannel };
}
