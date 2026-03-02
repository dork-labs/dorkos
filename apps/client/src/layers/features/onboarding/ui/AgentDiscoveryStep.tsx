import { useState, useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { Search } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { useRegisterAgent } from '@/layers/entities/mesh';
import { useDiscoveryScan } from '../model/use-discovery-scan';
import { AgentCard } from './AgentCard';

interface AgentDiscoveryStepProps {
  onStepComplete: () => void;
}

/**
 * Step 1 of onboarding — discovers AI agent projects on the user's machine.
 *
 * Auto-starts scanning on mount. Shows progressive results as they arrive,
 * with staggered entrance animations. All discovered agents are selected
 * by default.
 *
 * @param onStepComplete - Called when the user confirms their agent selection
 */
export function AgentDiscoveryStep({ onStepComplete }: AgentDiscoveryStepProps) {
  const { candidates, isScanning, progress, error, startScan } = useDiscoveryScan();
  const registerAgent = useRegisterAgent();
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [hasScanned, setHasScanned] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const reducedMotion = useReducedMotion();
  const autoStarted = useRef(false);

  // Auto-start scan on mount
  useEffect(() => {
    if (!autoStarted.current) {
      autoStarted.current = true;
      startScan();
    }
  }, [startScan]);

  // Select all agents by default when scan completes
  useEffect(() => {
    if (!isScanning && candidates.length > 0 && !hasScanned) {
      setSelectedPaths(new Set(candidates.map((c) => c.path)));
      setHasScanned(true);
    }
  }, [isScanning, candidates, hasScanned]);

  // Also select newly arriving candidates during scanning
  useEffect(() => {
    if (isScanning && candidates.length > 0) {
      setSelectedPaths(new Set(candidates.map((c) => c.path)));
    }
  }, [isScanning, candidates]);

  const handleToggle = useCallback((path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleRescan = useCallback(() => {
    setHasScanned(false);
    startScan();
  }, [startScan]);

  const handleConfirm = useCallback(async () => {
    setIsRegistering(true);
    const paths = Array.from(selectedPaths);
    try {
      await Promise.all(paths.map((p) => registerAgent.mutateAsync({ path: p })));
    } catch {
      // Continue even if some registrations fail — agents can be registered later
    } finally {
      setIsRegistering(false);
      onStepComplete();
    }
  }, [selectedPaths, registerAgent, onStepComplete]);

  const hasResults = candidates.length > 0;
  const showNoResults = !isScanning && !hasResults && hasScanned;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center px-4 sm:px-6">
      {/* Header */}
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {isScanning && !hasResults ? 'Searching your projects...' : 'Discovered Agents'}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          We&rsquo;ll find AI-configured projects on your machine.
        </p>
      </div>

      {/* Scanning animation */}
      {isScanning && !hasResults && (
        <div className="mt-8 flex flex-col items-center gap-4">
          <motion.div
            animate={reducedMotion ? {} : { scale: [1, 1.15, 1] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
          >
            <Search className="size-8 text-muted-foreground" />
          </motion.div>
          {progress && (
            <p className="text-sm text-muted-foreground">
              Scanned {progress.scannedDirs} directories
            </p>
          )}
        </div>
      )}

      {/* Progress indicator during scan with results */}
      {isScanning && hasResults && progress && (
        <div className="mt-4 text-center text-sm text-muted-foreground">
          Scanning... {progress.scannedDirs} directories &middot; Found {progress.foundAgents} agent
          {progress.foundAgents === 1 ? '' : 's'}
        </div>
      )}

      {/* Summary after scan */}
      {!isScanning && hasResults && (
        <p className="mt-4 text-center text-sm text-muted-foreground">
          Found {candidates.length} project{candidates.length === 1 ? '' : 's'}. Select the ones
          you want to register.
        </p>
      )}

      {/* Error state */}
      {error && (
        <div className="mt-6 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Agent cards list with staggered entrance */}
      {hasResults && (
        <motion.div
          className="mt-8 w-full space-y-3"
          initial="hidden"
          animate="visible"
          variants={
            reducedMotion
              ? {}
              : { visible: { transition: { staggerChildren: 0.1 } } }
          }
        >
          <AnimatePresence mode="popLayout">
            {candidates.map((candidate) => (
              <motion.div
                key={candidate.path}
                variants={
                  reducedMotion
                    ? {}
                    : {
                        hidden: { opacity: 0, y: 16 },
                        visible: { opacity: 1, y: 0 },
                      }
                }
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.25, ease: 'easeOut' }}
              >
                <AgentCard
                  candidate={{ ...candidate, hasDorkManifest: false }}
                  selected={selectedPaths.has(candidate.path)}
                  onToggle={() => handleToggle(candidate.path)}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>
      )}

      {/* No results placeholder */}
      {showNoResults && (
        <div className="mt-8 text-center text-sm text-muted-foreground">
          <p>No agent projects were found. Try creating a CLAUDE.md file in one of your project directories.</p>
          <div className="mt-4">
            <Button variant="outline" onClick={handleRescan}>
              Scan Again
            </Button>
          </div>
        </div>
      )}

      {/* Confirm & Register button */}
      {!isScanning && hasResults && (
        <div className="mt-8">
          <Button size="lg" onClick={handleConfirm} disabled={selectedPaths.size === 0 || isRegistering}>
            {isRegistering ? 'Registering...' : `Confirm & Register (${selectedPaths.size})`}
          </Button>
        </div>
      )}
    </div>
  );
}
