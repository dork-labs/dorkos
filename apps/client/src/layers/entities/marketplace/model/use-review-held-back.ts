import { useMutation } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

/**
 * Raise the approval card again for a global package held back from every
 * session (DOR-2306). The person decides on the card; the installed list
 * catches up when it next loads. Failures carry the server's own sentence
 * (why this package cannot be put on a card), so the caller shows it as is.
 */
export function useReviewHeldBackPackage() {
  const transport = useTransport();
  return useMutation<void, Error, string>({
    mutationFn: (name) => transport.reviewHeldBackPackage(name),
    // The caller reports the outcome in a toast of its own.
    meta: { suppressErrorToast: true },
  });
}
