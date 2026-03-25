import { useState, useEffect } from 'react';
import { useTransport } from '@/layers/shared/model';
import { PasscodeGate } from './PasscodeGate';

type GateState = 'checking' | 'locked' | 'unlocked';

interface PasscodeGateWrapperProps {
  children: React.ReactNode;
}

/**
 * Orchestrates session check and conditional passcode gate rendering.
 *
 * On non-localhost hostnames, checks the server for an active tunnel session.
 * Renders `PasscodeGate` when a passcode is required and no valid session exists.
 * Renders children immediately on localhost or when the session check passes.
 * Fails open on network errors to avoid locking out users on transient failures.
 */
export function PasscodeGateWrapper({ children }: PasscodeGateWrapperProps) {
  const transport = useTransport();
  const [state, setState] = useState<GateState>('checking');

  useEffect(() => {
    // Only gate if we're on a tunnel URL (not localhost)
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      setState('unlocked');
      return;
    }

    transport
      .checkTunnelSession()
      .then((result) => {
        if (!result.passcodeRequired || result.authenticated) {
          setState('unlocked');
        } else {
          setState('locked');
        }
      })
      .catch(() => {
        // If session check fails, fail-open to avoid locking out users
        setState('unlocked');
      });
  }, [transport]);

  if (state === 'checking') {
    // Brief blank during session check
    return null;
  }

  if (state === 'locked') {
    return <PasscodeGate onSuccess={() => setState('unlocked')} />;
  }

  return <>{children}</>;
}
