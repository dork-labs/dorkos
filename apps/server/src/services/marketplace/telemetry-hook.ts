/**
 * Marketplace install telemetry hook.
 *
 * Thin registration point for a single process-wide telemetry reporter that
 * receives one {@link InstallEvent} per terminal install/uninstall/update
 * outcome. The default is a no-op so the marketplace installer can call
 * {@link reportInstallEvent} unconditionally without leaking telemetry
 * concerns into the orchestrator.
 *
 * Spec 04 will plug in a real reporter via {@link registerTelemetryReporter};
 * until then this module exists purely as the contract.
 *
 * @module services/marketplace/telemetry-hook
 */

import type { PackageType } from '@dorkos/marketplace';

/**
 * A single terminal outcome from the marketplace installer pipeline.
 *
 * Emitted exactly once per `install`, `uninstall`, or `update` operation,
 * regardless of which type-specific flow handled the package.
 */
export interface InstallEvent {
  /** The package identifier (e.g. `code-review-suite`). */
  packageName: string;
  /** The marketplace source the package was resolved from. */
  marketplace: string;
  /** The package taxonomy bucket. */
  type: PackageType;
  /** The terminal outcome of the install pipeline. */
  outcome: 'success' | 'failure' | 'cancelled';
  /** Wall-clock duration of the operation in milliseconds. */
  durationMs: number;
  /** Stable error code when `outcome === 'failure'`. */
  errorCode?: string;
}

/**
 * A telemetry reporter receives a single {@link InstallEvent} and persists or
 * forwards it. Reporters must be resilient — any thrown error is swallowed by
 * {@link reportInstallEvent}.
 */
export type TelemetryReporter = (event: InstallEvent) => Promise<void>;

let reporter: TelemetryReporter | null = null;

/**
 * Register the process-wide telemetry reporter. Replaces any previously
 * registered reporter.
 *
 * @param r - The reporter to install.
 */
export function registerTelemetryReporter(r: TelemetryReporter): void {
  reporter = r;
}

/**
 * Report a marketplace install event to the registered reporter.
 *
 * No-op when no reporter is registered. Errors thrown by the reporter are
 * swallowed — telemetry must never fail user operations.
 *
 * @param event - The terminal install event to report.
 */
export async function reportInstallEvent(event: InstallEvent): Promise<void> {
  if (!reporter) return;
  try {
    await reporter(event);
  } catch {
    // Telemetry must never fail user operations.
  }
}

/**
 * Reset the registered reporter to its default (unregistered) state so each
 * test starts from a clean module singleton.
 *
 * @internal Test-only — not part of the public API.
 */
export function _resetTelemetryReporter(): void {
  reporter = null;
}
