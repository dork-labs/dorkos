import { useMutation } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { BindingTestResult } from '@dorkos/shared/relay-schemas';

/**
 * Sends a synthetic test probe through a binding. The server short-circuits
 * before invoking the agent; no real messages are delivered to any platform.
 */
export function useTestBinding() {
  const transport = useTransport();
  return useMutation<BindingTestResult, Error, string>({
    mutationFn: (bindingId) => transport.testBinding(bindingId),
  });
}
