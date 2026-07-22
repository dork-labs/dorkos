import { useCallback, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { Search } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { useRegisterAgent } from '@/layers/entities/mesh';
import {
  useDiscoveryScan,
  useDiscoveryStore,
  useActedPaths,
  buildRegistrationOverrides,
  sortCandidates,
  CandidateCard,
  BulkAddBar,
  CollapsibleImportedSection,
} from '@/layers/entities/discovery';
import type { DiscoveryCandidate } from '@dorkos/shared/mesh-schemas';

interface AgentDiscoveryStepProps {
  onStepComplete: () => void;
}

/**
 * Import-your-projects onboarding step — surfaces AI agent projects discovered
 * on the user's machine so they can register the ones they want to manage.
 *
 * The scan is normally prefetched by the flow while the user meets DorkBot, so
 * this step usually mounts with results already in the shared discovery store
 * (and the flow only mounts it when the scan found something). It still
 * self-starts a scan when mounted standalone (dev playground) — guarded on
 * `lastScanAt` so it never wipes a prefetched result set.
 *
 * @param onStepComplete - Called when the user advances past this step
 */
export function AgentDiscoveryStep({ onStepComplete }: AgentDiscoveryStepProps) {
  const { startScan } = useDiscoveryScan();
  const { candidates, existingAgents, isScanning, progress, error, lastScanAt } =
    useDiscoveryStore();
  const registerAgent = useRegisterAgent();
  // Tracks paths the user has explicitly approved or skipped
  const { actedPaths, markActed } = useActedPaths();
  const reducedMotion = useReducedMotion();
  const autoStarted = useRef(false);

  // Self-start a scan only when no scan has ever run (standalone mount). When
  // the flow prefetched, `lastScanAt` is already set and we render its results
  // rather than kicking a second scan that would clear them.
  useEffect(() => {
    if (!autoStarted.current && !lastScanAt && !isScanning) {
      autoStarted.current = true;
      startScan();
    }
  }, [startScan, lastScanAt, isScanning]);

  // Sort candidates after scan completes for stable display
  const displayCandidates = useMemo(
    () => (isScanning ? candidates : sortCandidates(candidates)),
    [candidates, isScanning]
  );

  const handleApprove = useCallback(
    (candidate: DiscoveryCandidate) => {
      // Mark acted immediately so the card exits; registration continues in background
      markActed(candidate.path);
      registerAgent.mutate({
        path: candidate.path,
        overrides: buildRegistrationOverrides(candidate),
      });
    },
    [registerAgent, markActed]
  );

  const handleSkip = useCallback(
    (candidate: DiscoveryCandidate) => {
      markActed(candidate.path);
    },
    [markActed]
  );

  const handleAddAll = useCallback(() => {
    for (const candidate of displayCandidates) {
      if (actedPaths.has(candidate.path)) continue;
      markActed(candidate.path);
      registerAgent.mutate({
        path: candidate.path,
        overrides: buildRegistrationOverrides(candidate),
      });
    }
  }, [displayCandidates, actedPaths, registerAgent, markActed]);

  const hasExisting = existingAgents.length > 0;
  const hasCandidates = candidates.length > 0;
  const hasResults = hasExisting || hasCandidates;
  const scanComplete = !isScanning && lastScanAt !== null;
  // "Continue" is primary when every visible candidate has been approved or skipped,
  // or when there are only existing agents (no candidates needing action)
  const allActed = !hasCandidates || candidates.every((c) => actedPaths.has(c.path));
  // Only show unacted candidates — acted ones animate out via AnimatePresence
  const pendingCandidates = displayCandidates.filter((c) => !actedPaths.has(c.path));

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col items-center">
      {/* Header — adapts to scan state */}
      <div className="w-full shrink-0 text-center">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {isScanning && !hasResults ? 'Searching your machine...' : 'Import your projects'}
        </h2>
        {isScanning && !hasResults && (
          <div className="mt-2 space-y-1">
            <p className="text-muted-foreground text-sm">
              Looking for existing projects on your machine.
            </p>
            <p className="text-muted-foreground text-sm">
              Once imported, your agents can work across them — and you can connect to Slack,
              Telegram, and more.
            </p>
          </div>
        )}
      </div>

      {/* Scanning animation */}
      {isScanning && !hasResults && (
        <div className="mt-8 flex shrink-0 flex-col items-center gap-4">
          <motion.div
            animate={reducedMotion ? {} : { scale: [1, 1.15, 1] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
          >
            <Search className="text-muted-foreground size-8" />
          </motion.div>
          {progress && (
            <p className="text-muted-foreground text-sm">
              Scanned {progress.scannedDirs} directories
            </p>
          )}
        </div>
      )}

      {/* Progress indicator during scan with results */}
      {isScanning && hasResults && progress && (
        <div className="text-muted-foreground mt-4 shrink-0 text-center text-sm">
          Scanning... {progress.scannedDirs} directories &middot; Found {progress.foundAgents}{' '}
          project{progress.foundAgents === 1 ? '' : 's'}
        </div>
      )}

      {/* Value prop after scan */}
      {scanComplete && hasResults && (
        <p className="text-muted-foreground mt-3 shrink-0 text-center text-sm">
          Add existing projects you want to manage in DorkOS. You can assign agents, schedule tasks,
          and connect to Slack, Telegram, and more.
        </p>
      )}

      {/* Error state */}
      {error && (
        <div className="border-destructive/30 bg-destructive/5 text-destructive mt-6 shrink-0 rounded-lg border px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {/* Scrollable results area — new projects first, imported collapsed at bottom */}
      {hasResults && (
        <div className="mt-4 min-h-0 w-full flex-1 overflow-y-auto pr-1">
          <div className="space-y-3">
            {/* Bulk add bar + new candidates first */}
            {pendingCandidates.length > 0 && (
              <BulkAddBar count={pendingCandidates.length} onAddAll={handleAddAll} />
            )}
            <AnimatePresence mode="popLayout">
              {pendingCandidates.map((candidate) => (
                <CandidateCard
                  key={candidate.path}
                  candidate={candidate}
                  onApprove={handleApprove}
                  onSkip={handleSkip}
                />
              ))}
            </AnimatePresence>

            {/* Already-imported — collapsed at bottom */}
            {hasExisting && <CollapsibleImportedSection agents={existingAgents} />}
          </div>
        </div>
      )}

      {/* Continue button — visible once scan completes with results */}
      {scanComplete && hasResults && (
        <div className="mt-4 flex shrink-0 flex-col items-center gap-2 border-t pt-4">
          <Button size="lg" onClick={onStepComplete} variant={allActed ? 'default' : 'outline'}>
            Continue
          </Button>
        </div>
      )}
    </div>
  );
}
