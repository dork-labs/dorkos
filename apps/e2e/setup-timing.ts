import type { FullConfig } from '@playwright/test';

/**
 * Record global setup boundaries in the existing Playwright JSON report.
 *
 * Playwright starts its web servers before calling global setup. Subtract the
 * report's stats.startTime from startedAt to measure the preceding runner and
 * server startup together; it is not a measurement of server boot alone.
 * A deadline that interrupts setup leaves status=running, never a false zero.
 */
export async function measureGlobalSetup(
  config: FullConfig,
  setup: () => Promise<void>
): Promise<void> {
  const started = performance.now();
  const timing: {
    startedAt: string;
    finishedAt?: string;
    durationMs?: number;
    status: 'running' | 'passed' | 'failed';
  } = { startedAt: new Date().toISOString(), status: 'running' };
  config.metadata.globalSetupTiming = timing;
  try {
    await setup();
    timing.status = 'passed';
  } catch (error) {
    timing.status = 'failed';
    throw error;
  } finally {
    timing.finishedAt = new Date().toISOString();
    timing.durationMs = performance.now() - started;
  }
}
