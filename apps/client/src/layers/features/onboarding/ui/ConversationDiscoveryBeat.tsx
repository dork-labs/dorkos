/**
 * The discovery beat's inline widget (ADR 260722-111315).
 *
 * Consent-first: no filesystem scan runs until the user taps "Sure, look
 * around". While scanning it shows an honest "Looking…" indicator; on resolution
 * it either lists the found candidates (add individually or all) or reports up an
 * honest zero/timeout outcome. All scan wiring lives here so the conversation
 * hook stays transport-free.
 *
 * @module features/onboarding/ui/ConversationDiscoveryBeat
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { TypingDots } from '@/layers/features/chat';
import {
  useDiscoveryScan,
  useDiscoveryStore,
  useActedPaths,
  buildRegistrationOverrides,
  sortCandidates,
  CandidateCard,
  BulkAddBar,
} from '@/layers/entities/discovery';
import { useRegisterAgent } from '@/layers/entities/mesh';
import type { DiscoveryCandidate } from '@dorkos/shared/mesh-schemas';
import type { DiscoveryPhase } from '../model/use-onboarding-conversation';

/**
 * How long to wait for the consented scan before giving up with an honest line.
 * Matches the onboarding budget the flow used before it became conversational.
 */
const DISCOVERY_TIMEOUT_MS = 8000;

/** Props for {@link ConversationDiscoveryBeat}. */
export interface ConversationDiscoveryBeatProps {
  /** Where the discovery beat is in its consent → scan → results arc. */
  phase: DiscoveryPhase;
  /** The user consented — the caller flips the conversation into "scanning". */
  onConsent: () => void;
  /** The user declined the scan. */
  onDecline: () => void;
  /** The scan found candidates. */
  onResults: (count: number) => void;
  /** The scan found nothing. */
  onZero: () => void;
  /** The scan exceeded its budget or errored. */
  onTimeout: () => void;
  /** The user finished reviewing the found candidates. */
  onDone: () => void;
}

/**
 * The discovery beat widget: consent chips, a scanning indicator, or the found
 * candidates with add controls.
 *
 * @param props - The current phase and the conversation callbacks.
 */
export function ConversationDiscoveryBeat({
  phase,
  onConsent,
  onDecline,
  onResults,
  onZero,
  onTimeout,
  onDone,
}: ConversationDiscoveryBeatProps) {
  const { startScan } = useDiscoveryScan();
  const { candidates, isScanning, lastScanAt, error } = useDiscoveryStore();
  const registerAgent = useRegisterAgent();
  const { actedPaths, markActed } = useActedPaths();

  // Fire the outcome exactly once — whichever of the store resolution or the
  // timeout wins first latches this so the other becomes a no-op.
  const resolvedRef = useRef(false);

  const handleConsent = useCallback(() => {
    resolvedRef.current = false;
    onConsent();
    startScan();
  }, [onConsent, startScan]);

  // Timeout guard: never trap the user behind a hung scan.
  useEffect(() => {
    if (phase !== 'scanning') return;
    const timer = setTimeout(() => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      onTimeout();
    }, DISCOVERY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [phase, onTimeout]);

  // Resolve once the consented scan settles (or errors).
  useEffect(() => {
    if (phase !== 'scanning' || resolvedRef.current) return;
    if (error) {
      resolvedRef.current = true;
      onTimeout();
      return;
    }
    if (!isScanning && lastScanAt !== null) {
      resolvedRef.current = true;
      if (candidates.length > 0) {
        onResults(candidates.length);
      } else {
        onZero();
      }
    }
  }, [phase, isScanning, lastScanAt, error, candidates.length, onResults, onZero, onTimeout]);

  const displayCandidates = useMemo(() => sortCandidates(candidates), [candidates]);
  const pending = displayCandidates.filter((c) => !actedPaths.has(c.path));

  const handleApprove = useCallback(
    (candidate: DiscoveryCandidate) => {
      markActed(candidate.path);
      registerAgent.mutate({
        path: candidate.path,
        overrides: buildRegistrationOverrides(candidate),
      });
    },
    [registerAgent, markActed]
  );

  const handleAddAll = useCallback(() => {
    for (const candidate of pending) {
      markActed(candidate.path);
      registerAgent.mutate({
        path: candidate.path,
        overrides: buildRegistrationOverrides(candidate),
      });
    }
  }, [pending, registerAgent, markActed]);

  if (phase === 'unasked') {
    return (
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={handleConsent}>
          Sure, look around
        </Button>
        <Button size="sm" variant="outline" onClick={onDecline}>
          Not now
        </Button>
      </div>
    );
  }

  if (phase === 'scanning') {
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-sm" aria-live="polite">
        <Search className="size-4" />
        Looking…
        <TypingDots />
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-col gap-2">
        {pending.map((candidate) => (
          <CandidateCard
            key={candidate.path}
            candidate={candidate}
            onApprove={handleApprove}
            onSkip={(c) => markActed(c.path)}
          />
        ))}
      </div>
      {pending.length > 0 && <BulkAddBar count={pending.length} onAddAll={handleAddAll} />}
      <div className="flex justify-start">
        <Button size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
