import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  CreateCommitmentRequest,
  UpdateCommitmentRequest,
} from '@dorkos/shared/commitment-schemas';
import { useTransport } from '@/layers/shared/model';
import { commitmentKeys } from './commitment-keys';

/** One new promise: the agent that made it, and what it was. */
export interface CreateCommitmentInput {
  agentId: string;
  body: CreateCommitmentRequest;
}

/** One change: which promise, and to what. */
export interface UpdateCommitmentInput {
  id: string;
  body: UpdateCommitmentRequest;
}

/**
 * Record a promise an agent made, as the person.
 *
 * @returns The TanStack mutation.
 */
export function useCreateCommitment() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, body }: CreateCommitmentInput) =>
      transport.createCommitment(agentId, body),
    onSettled: () => queryClient.invalidateQueries({ queryKey: commitmentKeys.all }),
  });
}

/**
 * Mark a promise kept, missed or dropped, or move its date.
 *
 * @returns The TanStack mutation.
 */
export function useUpdateCommitment() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: UpdateCommitmentInput) => transport.updateCommitment(id, body),
    onSettled: () => queryClient.invalidateQueries({ queryKey: commitmentKeys.all }),
  });
}
