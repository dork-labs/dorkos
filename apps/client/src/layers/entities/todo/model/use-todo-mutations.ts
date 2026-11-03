import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  CreateTodoRequest,
  ListTodosResponse,
  UpdateTodoRequest,
} from '@dorkos/shared/todo-schemas';
import { PERSON_SESSION_REQUIRED_CODE } from '@dorkos/shared/person-session';
import { useTransport } from '@/layers/shared/model';
import { todoKeys } from './todo-keys';

/**
 * A sign-in the person chose not to give: the app's own prompt already asked, nothing changed,
 * so it is not a failure to toast.
 */
function declinedSignIn(error: Error): boolean {
  return (error as Error & { code?: unknown }).code === PERSON_SESSION_REQUIRED_CODE;
}

/** One change: which to-do, and to what. */
export interface UpdateTodoInput {
  id: string;
  body: UpdateTodoRequest;
}

/**
 * Make a to-do as the person. A window without the owner's sign-in is asked for it by the
 * app's own `fetch` and the call goes again, so nothing here handles that refusal.
 *
 * @returns The TanStack mutation.
 */
export function useCreateTodo() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTodoRequest) => transport.createTodo(body),
    meta: { errorLabel: 'Couldn’t add the to-do. Try again.', isShownInline: declinedSignIn },
    onSettled: () => queryClient.invalidateQueries({ queryKey: todoKeys.all }),
  });
}

/**
 * Change a to-do: complete it, reopen it, decline it, or edit it.
 *
 * A change of state shows at once in every cached list and is put back if the server refuses.
 * Every list is read again afterwards, so where the server files the row wins.
 *
 * @returns The TanStack mutation.
 */
export function useUpdateTodo() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: UpdateTodoInput) => transport.updateTodo(id, body),
    meta: { errorLabel: 'Couldn’t change the to-do. Try again.', isShownInline: declinedSignIn },
    onMutate: async ({ id, body }: UpdateTodoInput) => {
      const state = body.state;
      if (state === undefined) return { previous: [] };
      await queryClient.cancelQueries({ queryKey: todoKeys.lists() });
      const previous = queryClient.getQueriesData<ListTodosResponse>({
        queryKey: todoKeys.lists(),
      });
      queryClient.setQueriesData<ListTodosResponse>({ queryKey: todoKeys.lists() }, (data) =>
        data ? { ...data, todos: data.todos.map((t) => (t.id === id ? { ...t, state } : t)) } : data
      );
      return { previous };
    },
    onError: (_error, _input, context) => {
      for (const [key, data] of context?.previous ?? []) queryClient.setQueryData(key, data);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: todoKeys.all }),
  });
}
