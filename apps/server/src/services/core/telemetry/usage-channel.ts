/**
 * Start the feature-usage channel when its consent holds: at boot, or the
 * moment a person turns it on while DorkOS runs (DOR-5018).
 *
 * The usage reporter and the install funnel used to start only at boot, from
 * the consent captured then. A fresh install's first run happens on its first
 * boot, when nobody has answered yet, so a "yes" given that boot (the consent
 * card shows right after setup) started nothing. `first_run_completed` then
 * waited for a restart, and an app left running for two weeks, or restarted
 * after that, never sent it at all: the funnel records an old first run as
 * already reported. The same held for turning usage on in Settings mid-run.
 *
 * Starting on the answer keeps the consent rule whole: the live check is the
 * person's own answer (`userHasDecided` and `telemetry.usage` both exactly
 * true, no env kill switch), so a never-answered install still sends nothing
 * on the boot that shows the first-run notice.
 *
 * @module services/core/telemetry/usage-channel
 */

/** What {@link startUsageChannel} needs. */
export interface UsageChannelOptions {
  /** The usage channel's consent captured at boot (setting, kill switch and notice gate). */
  consentedAtBoot: boolean;
  /** The person's live answer for the usage channel, read on every telemetry change. */
  usageOn: () => boolean;
  /** Subscribe to config changes; returns an unsubscribe. */
  onChange: (listener: (change: { sections: readonly string[] }) => void) => () => void;
  /** Register the usage reporter (enabled) and start the install funnel. Called at most once. */
  start: () => void;
}

/** Read the live answer; a reader that throws counts as no. */
function readUsageOn(usageOn: () => boolean): boolean {
  try {
    return usageOn();
  } catch {
    return false;
  }
}

/**
 * Start the usage channel now if consent held at boot; otherwise start it the
 * first time the person's live answer turns it on.
 *
 * @param options - Boot consent, the live answer, the change feed and the starter.
 * @returns A function that stops waiting (a no-op once started).
 */
export function startUsageChannel(options: UsageChannelOptions): () => void {
  if (options.consentedAtBoot) {
    options.start();
    return () => {};
  }
  let started = false;
  const unsubscribe = options.onChange((change) => {
    if (started || !change.sections.includes('telemetry')) return;
    if (!readUsageOn(options.usageOn)) return;
    started = true;
    unsubscribe();
    options.start();
  });
  return () => {
    if (!started) unsubscribe();
  };
}
