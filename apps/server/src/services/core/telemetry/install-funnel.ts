/**
 * The app half of the install funnel (DOR-2862): site visit → install → first
 * run → active.
 *
 * Three feature-usage events, all through the usage reporter, so they ride its
 * consent exactly, including its live check: turning usage off mid-run stops
 * them at once, with no restart:
 *
 * - `app_started` — once per boot.
 * - `first_run_completed` — once per install, the first time the usage channel
 *   is on after the first run is over (finished or dismissed, the same rule as
 *   `firstRunClosed`). It carries the install ref the dorkos.ai install command
 *   left in the data directory, when there is one (`@dorkos/shared/install-ref`),
 *   as plain properties a query can join to the site's copy event. Nothing here
 *   aliases or merges PostHog persons.
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
 * (written atomically) so a restart never repeats `first_run_completed` or a
 * day's `instance_active`. An install that upgrades into this code with its
 * first run long over has no such file; {@link startInstallFunnel} records its
 * first run as already reported rather than sending a late, misleading one.
 *
 * @module services/core/telemetry/install-funnel
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { UserConfig } from '@dorkos/shared/config-schema';
import { readInstallRef } from '@dorkos/shared/install-ref';
import { z } from 'zod';

import type { ConfigManager } from '../config-manager.js';
import { firstRunClosed } from '../onboarding/first-run.js';
import { isUsageReporterActive, reportUsageEvent } from '../usage-reporter.js';

/** File name (under dorkHome) recording which funnel events were already sent. */
export const FUNNEL_STATE_FILENAME = 'telemetry-funnel.json';

/** How often a long-running server checks whether a new UTC day has begun. */
export const INSTANCE_ACTIVE_CHECK_MS = 60 * 60 * 1000;

/**
 * How long ago a first run can have ended and still be reported when no funnel
 * state exists yet. Older means an install that upgraded into this code (or
 * opted in long after setup): its first run is recorded, not sent. Matches the
 * default 14-day window a funnel query would use.
 */
export const FIRST_RUN_REPORT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const FunnelStateSchema = z.object({
  firstRunReportedAt: z.string().nullable().default(null),
  lastActiveDay: z.string().nullable().default(null),
});

type FunnelState = z.infer<typeof FunnelStateSchema>;

/** The two config reads and the change feed the funnel needs. */
export type FunnelConfig = Pick<ConfigManager, 'get' | 'onChange'>;

/** Options for {@link startInstallFunnel}. */
export interface InstallFunnelOptions {
  /** Resolved data directory (holds the install ref and the funnel state). */
  dorkHome: string;
  /** Settings: `runtimes` (for `app_started`), `onboarding`, and the change feed. */
  config: FunnelConfig;
  /** Clock override (tests). */
  now?: () => Date;
  /** Day-check interval override (tests). Defaults to {@link INSTANCE_ACTIVE_CHECK_MS}. */
  checkIntervalMs?: number;
}

/** Read the funnel state, or `null` when there is no file (nothing recorded yet). */
function readState(filePath: string): FunnelState | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  try {
    return FunnelStateSchema.parse(JSON.parse(raw));
  } catch {
    return FunnelStateSchema.parse({});
  }
}

/**
 * Persist the funnel state through a unique temp file and a rename, so a crash
 * mid-write never leaves a torn file. A failed write only risks a repeat event.
 */
function writeState(filePath: string, state: FunnelState): void {
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch {
    // Telemetry must never surface to the user.
    fs.rmSync(tmp, { force: true });
  }
}

/** When the first run ended (finished or dismissed), or `null` while it is still open. */
function firstRunEndedAt(onboarding: UserConfig['onboarding']): number | null {
  if (!firstRunClosed(onboarding)) return null;
  const times = [onboarding.completedAt, onboarding.dismissedAt]
    .map((t) => (t ? Date.parse(t) : NaN))
    .filter((t) => !Number.isNaN(t));
  // Closed with no readable time: treat it as long over.
  return times.length > 0 ? Math.min(...times) : 0;
}

/**
 * Report `app_started`, then `first_run_completed` and `instance_active` when
 * they are due, and keep watching: a first run that ends reports straight away,
 * and a new UTC day reports `instance_active` again.
 *
 * A no-op, reading and writing nothing, while the usage reporter is not active
 * (registered with consent on, and consent still on now). Each send re-checks.
 *
 * @param options - Data directory, settings, and clock overrides.
 * @returns A function that stops watching.
 */
export function startInstallFunnel(options: InstallFunnelOptions): () => void {
  if (!isUsageReporterActive()) return () => {};
  const { config } = options;
  const now = options.now ?? (() => new Date());
  const statePath = path.join(options.dorkHome, FUNNEL_STATE_FILENAME);

  const runtimes = config.get('runtimes');
  reportUsageEvent({
    event: 'app_started',
    properties: {
      os: `${process.platform}-${process.arch}`,
      runtimesConfigured:
        1 + (runtimes.codex.enabled ? 1 : 0) + (runtimes.opencode.enabled ? 1 : 0),
    },
  });

  // Upgrade guard: no state yet, and the first run ended outside the window.
  const endedAtBoot = firstRunEndedAt(config.get('onboarding'));
  if (
    readState(statePath) === null &&
    endedAtBoot !== null &&
    now().getTime() - endedAtBoot > FIRST_RUN_REPORT_WINDOW_MS
  ) {
    writeState(statePath, { firstRunReportedAt: now().toISOString(), lastActiveDay: null });
  }

  const reportFirstRunIfDue = (): void => {
    // Re-checked on every call: consent withdrawn since boot must stop this
    // before anything is sent or marked sent.
    if (!isUsageReporterActive()) return;
    const state = readState(statePath) ?? FunnelStateSchema.parse({});
    if (state.firstRunReportedAt || firstRunEndedAt(config.get('onboarding')) === null) return;
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
    const state = readState(statePath) ?? FunnelStateSchema.parse({});
    const today = now().toISOString().slice(0, 10);
    if (state.lastActiveDay === today) return;
    reportUsageEvent({ event: 'instance_active', properties: {} });
    writeState(statePath, { ...state, lastActiveDay: today });
  };

  reportFirstRunIfDue();
  reportActiveIfDue();

  const unsubscribe = config.onChange((change) => {
    if (change.sections.includes('onboarding')) reportFirstRunIfDue();
  });
  const timer = setInterval(reportActiveIfDue, options.checkIntervalMs ?? INSTANCE_ACTIVE_CHECK_MS);
  timer.unref();

  return () => {
    unsubscribe();
    clearInterval(timer);
  };
}
