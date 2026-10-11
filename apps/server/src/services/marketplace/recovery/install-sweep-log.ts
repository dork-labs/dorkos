import type { MeshCore } from '@dorkos/mesh';
import { logger } from '../../../lib/logger.js';
import { registerRestoredAgents } from '../restored-agents.js';
import { retryInFlightTargetsLater, type InstallSweepSummary } from './backup-janitor.js';

/**
 * Build the logger for an install-recovery sweep: it registers the agents the sweep
 * restored, logs what it did when it did anything, and looks once more at targets
 * left to another running DorkOS.
 *
 * @param getMeshCore - The mesh, read at call time because it starts after the sweep.
 * @returns A function taking the swept scope (for the log line) and the sweep's totals.
 */
export function installSweepLogger(
  getMeshCore: () => MeshCore | undefined
): (scope: string, summary: InstallSweepSummary) => void {
  const logInstallSweep = (scope: string, summary: InstallSweepSummary): void => {
    registerRestoredAgents(summary.restoredAgentRoots, getMeshCore());
    const { settled, kept, discarded, inFlightTargets } = summary;
    if (settled + kept + discarded + inFlightTargets.length > 0) {
      logger.info(
        `[Marketplace] Settled interrupted ${scope}: ${settled} settled, ${kept} kept, ${discarded} leftovers removed, ${inFlightTargets.length} left to another running DorkOS`
      );
    }
    // A target left to another process is looked at once more when every record
    // there has aged past the point where its owner matters.
    retryInFlightTargetsLater(inFlightTargets, logger, (retry) =>
      logInstallSweep(`${scope} (retry)`, { ...retry, inFlightTargets: [] })
    );
  };
  return logInstallSweep;
}
