/**
 * Writing a person's answer to "share globally installed packages with which
 * agent tools?" (`harness.global`, DOR-678) on the space side (spec
 * `computer-side-starts-alone` §5.7). The computer side reads it
 * (`harness/global-scope.ts`) and never writes it.
 *
 * @module services/core/approvals/computer-asks/global-sharing
 */
import type { HarnessId } from '@dorkos/shared/harness-schemas';
import { readConsent, writeConsent } from './consent-config.js';

/**
 * Record which agent tools DorkOS shares globally installed packages with, and
 * stamp when the question was answered.
 *
 * Needs `initConfigManager` to have run: this OPENS the store and writes, which
 * is why only the two explicit verbs (`dorkos harness global --enable` and
 * `--disable`) reach it, and never a read-only path (DOR-678).
 *
 * `askedAt` is stamped on every write, including one that empties the list. A
 * decline is a timestamp with an empty list, and it is remembered — which is
 * what stops the ask printing again for somebody who already said no.
 *
 * The list is REPLACED rather than merged, and every caller passes a list it
 * derived from the stored one. One explicit verb, one array element, nothing
 * round-tripped, which is the shape ADR-0302's amendment established.
 *
 * @param harnesses - the new list, already deduplicated and ordered by the caller.
 * @param reason - the subsystem name for the config-write log line.
 * @param now - the timestamp to stamp; injected so a test can pin it.
 */
export function writeGlobalSharing(
  harnesses: readonly HarnessId[],
  reason: string,
  now: Date = new Date()
): void {
  writeConsent('harness', reason, {
    ...readConsent('harness'),
    global: { harnesses: [...harnesses], askedAt: now.toISOString() },
  });
}
