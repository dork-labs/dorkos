import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

export const SIGNIN_POLICY_KEY = ['claude-signin-policy'] as const;
/** The server only returns this view to the signed-in owner, on any device. */
export function useSigninPolicy() {
  const transport = useTransport();
  return useQuery({
    queryKey: SIGNIN_POLICY_KEY,
    queryFn: () => transport.getClaudeSigninPolicy(),
    retry: false,
  });
}
