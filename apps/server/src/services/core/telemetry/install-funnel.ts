/**
 * The app half of the install funnel (DOR-2862): site visit → install → first
 * run → active.
 *
 * Three feature-usage events, all through the usage reporter, so they ride its
 * consent exactly:
 *
 * - `app_started` — once per boot.
 * - `first_run_completed` — once per install, the first time the usage channel
 *   is on after onboarding has finished. It carries the install ref the
 *   dorkos.ai install command left in the data directory, when there is one
 *   (`@dorkos/shared/install-ref`), so PostHog can join the visit that copied
 *   the command to this install without an account.
 * - `instance_active` — at most once per UTC day while DorkOS runs.
 *
 * **Consent.** Everything here goes through the usage reporter, which is only
 * registered when the channel's final consent is true: `telemetry.usage` on, no
 * env kill switch, and the Tier 1 notice gate captured before this boot's
 * notice. {@link startInstallFunnel} does nothing at all unless that reporter is
 * active, so nothing is sent on the boot that shows the notice, and an
 * opted-out install sends, reads and writes nothing here. "Sent" below means
 * handed to the reporter; like every usage event it is best-effort.
 *
 * What has already been reported is kept in `<dorkHome>/telemetry-funnel.json`
 * so a restart never repeats `first_run_completed` or a day's `instance_active`.
 *
 * @module services/core/telemetry/install-funnel
 */
import fs from 'node:fs';
import path from 'node:path';

import { readInstallRef } from '@dorkos/shared/install-ref';
import { z } from 'zod';

import { isUsageReporterActive, reportUsageEvent } from '../usage-reporter.js';

/** File name (under dorkHome) recording which funnel events were already sent. */
export const FUNNEL_STATE_FILENAME = 'telemetry-funnel.json';

/** How often a long-running server checks whether a new UTC day has begun. */
export const INSTANCE_ACTIVE_CHECK_MS = 60 * 60 * 1000;

const FunnelStateSchema = z.object({
  firstRunReportedAt: z.string().nullable().default(null),
  lastActiveDay: z.string().nullable().default(null),
});

type FunnelState = z.infer<typeof FunnelStateSchema>;

/** The runtime switches `app_started` counts (Claude Code is always on). */
interface RuntimeSwitches {
  codex: { enabled: boolean };
  opencode: { enabled: boolean };
}

/** Options for {@link startInstallFunnel}. */
export interface InstallFunnelOptions {
  /** Resolved data directory (holds the install ref and the funnel state). */
  dorkHome: string;
  /** The `runtimes` config section, read once at boot for `app_started`. */
  runtimes: RuntimeSwitches;
  /** Whether onboarding has finished (`config.onboarding.completedAt` is set). */
  isOnboardingComplete: () => boolean;
  /** Subscribe to settings writes; the listener gets the sections each write touched. */
  onSettingsChange: (listener: (sections: readonly string[]) => void) => () => void;
  /** Clock override (tests). */
  now?: () => Date;
  /** Day-check interval override (tests). Defaults to {@link INSTANCE_ACTIVE_CHECK_MS}. */
  checkIntervalMs?: number;
}

/** Read the funnel state; a missing or unreadable file means nothing was sent yet. */
function readState(filePath: string): FunnelState {
  try {
    return FunnelStateSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return FunnelStateSchema.parse({});
  }
}

/** Persist the funnel state. A failed write only risks a repeat event, never an error. */
function writeState(filePath: string, state: FunnelState): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify(state), 'utf8');
  } catch {
    // Telemetry must never surface to the user.
  }
}

/**
 * Report `app_started`, then `first_run_completed` and `instance_active` when
 * they are due, and keep watching: a finished onboarding reports the first run
 * straight away, and a new UTC day reports `instance_active` again.
 *
 * A no-op, reading and writing nothing, when the usage reporter is not active.
 *
 * @param options - Data directory, config readers, and clock overrides.
 * @returns A function that stops watching.
 */
export function startInstallFunnel(options: InstallFunnelOptions): () => void {
  if (!isUsageReporterActive()) return () => {};
  const now = options.now ?? (() => new Date());
  const statePath = path.join(options.dorkHome, FUNNEL_STATE_FILENAME);

  reportUsageEvent({
    event: 'app_started',
    properties: {
      os: `${process.platform}-${process.arch}`,
      runtimesConfigured:
        1 + (options.runtimes.codex.enabled ? 1 : 0) + (options.runtimes.opencode.enabled ? 1 : 0),
    },
  });

  const reportFirstRunIfDue = (): void => {
    // Re-checked on every call: a reporter shut down since boot must not let
    // an event be marked sent that it would drop.
    if (!isUsageReporterActive()) return;
    const state = readState(statePath);
    if (state.firstRunReportedAt || !options.isOnboardingComplete()) return;
    const ref = readInstallRef(options.dorkHome);
    reportUsageEvent({
      event: 'first_run_completed',
      properties: ref
        ? {
            installRef: ref.token,
            ...(ref.utmSource ? { utmSource: ref.utmSource } : {}),
            ...(ref.utmCampaign ? { utmCampaign: ref.utmCampaign } : {}),
          }
        : {},
    });
    writeState(statePath, { ...state, firstRunReportedAt: now().toISOString() });
  };

  const reportActiveIfDue = (): void => {
    if (!isUsageReporterActive()) return;
    const state = readState(statePath);
    const today = now().toISOString().slice(0, 10);
    if (state.lastActiveDay === today) return;
    reportUsageEvent({ event: 'instance_active', properties: {} });
    writeState(statePath, { ...state, lastActiveDay: today });
  };

  reportFirstRunIfDue();
  reportActiveIfDue();

  const unsubscribe = options.onSettingsChange((sections) => {
    if (sections.includes('onboarding')) reportFirstRunIfDue();
  });
  const timer = setInterval(reportActiveIfDue, options.checkIntervalMs ?? INSTANCE_ACTIVE_CHECK_MS);
  timer.unref();

  return () => {
    unsubscribe();
    clearInterval(timer);
  };
}
