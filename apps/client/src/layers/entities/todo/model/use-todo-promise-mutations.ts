import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  ConfirmTodoPromiseRequest,
  CreateTodoPromiseRequest,
  UpdateTodoPromiseRequest,
} from '@dorkos/shared/todo-promise-schemas';
import { useTransport } from '@/layers/shared/model';
import { todoPromiseKeys } from './todo-promise-keys';

/** One new promise: the agent that made it, and what it was. */
export interface CreateTodoPromiseInput {
  agentId: string;
  body: CreateTodoPromiseRequest;
}

/** One change: which promise, and to what. */
export interface UpdateTodoPromiseInput {
  id: string;
  body: UpdateTodoPromiseRequest;
}

/**
 * Record a promise an agent made, as the person.
 *
 * @returns The TanStack mutation.
 */
export function useCreateTodoPromise() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, body }: CreateTodoPromiseInput) =>
      transport.createTodoPromise(agentId, body),
    onSettled: () => queryClient.invalidateQueries({ queryKey: todoPromiseKeys.all }),
  });
}

/**
 * The headline of the one failure report a change gets: the app's toast, with the server's own
 * sentence under it. Not "Try again": a refusal says why, and trying again would not change it.
 */
const CHANGE_FAILED = 'Couldn’t change the to-do';

/**
 * Mark a promise kept, missed or dropped, or move its date.
 *
 * @returns The TanStack mutation.
 */
export function useUpdateTodoPromise() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: UpdateTodoPromiseInput) => transport.updateTodoPromise(id, body),
    meta: { errorLabel: CHANGE_FAILED },
    onSettled: () => queryClient.invalidateQueries({ queryKey: todoPromiseKeys.all }),
  });
}

/** One answer: which kept promise, and Yes or Not yet. */
export interface ConfirmTodoPromiseInput {
  id: string;
  answer: ConfirmTodoPromiseRequest['answer'];
}

/**
 * Answer whether a kept promise was kept (DOR-3034): Yes confirms it, Not yet reopens it.
 *
 * @returns The TanStack mutation.
 */
export function useConfirmTodoPromise() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, answer }: ConfirmTodoPromiseInput) =>
      transport.confirmTodoPromise(id, answer),
    meta: { errorLabel: CHANGE_FAILED },
    onSettled: () => queryClient.invalidateQueries({ queryKey: todoPromiseKeys.all }),
  });
}
