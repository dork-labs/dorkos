import { useCallback, useRef, useState } from 'react';
import type { DiscoveryCandidate } from '@dorkos/shared/mesh-schemas';

interface CandidateRegistrationOptions {
  /** Perform the caller-specific registration, including any scan-root context. */
  register: (candidate: DiscoveryCandidate) => Promise<unknown>;
  /** Record the caller-specific success after registration settles. */
  onSuccess: (candidate: DiscoveryCandidate) => void;
}

/**
 * Keep one component-local registration lifecycle per discovered path.
 *
 * The ref is the synchronous duplicate-submit fence; the Sets drive only the
 * pending and retry UI. Registration itself intentionally continues if the
 * surface unmounts. React ignores the local state updates after unmount, while
 * the completed mutation can still refresh shared query state.
 *
 * @param options - Caller-owned registration and success behavior.
 */
export function useCandidateRegistration({ register, onSuccess }: CandidateRegistrationOptions) {
  const pendingRef = useRef<Set<string>>(new Set());
  const [pendingPaths, setPendingPaths] = useState<Set<string>>(new Set());
  const [failedPaths, setFailedPaths] = useState<Set<string>>(new Set());

  const registerCandidate = useCallback(
    async (candidate: DiscoveryCandidate) => {
      if (pendingRef.current.has(candidate.path)) return;
      pendingRef.current.add(candidate.path);
      setPendingPaths((current) => new Set(current).add(candidate.path));
      setFailedPaths((current) => {
        const next = new Set(current);
        next.delete(candidate.path);
        return next;
      });

      try {
        await register(candidate);
        onSuccess(candidate);
      } catch {
        setFailedPaths((current) => new Set(current).add(candidate.path));
      } finally {
        pendingRef.current.delete(candidate.path);
        setPendingPaths((current) => {
          const next = new Set(current);
          next.delete(candidate.path);
          return next;
        });
      }
    },
    [onSuccess, register]
  );

  const resetFailures = useCallback(() => setFailedPaths(new Set()), []);

  return { failedPaths, pendingPaths, registerCandidate, resetFailures } as const;
}
