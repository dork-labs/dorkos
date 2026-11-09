/**
 * "Allow all" for a plugin's extensions (DOR-3583): the one answer that
 * approves each member on its own. Person-only on the server. The sets waiting
 * are read in `entities/extension` (`useApprovalSets`), where ⌘K reads them too.
 *
 * @module features/extensions/api/approval-set-queries
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  ApprovalSetResult,
  ExtensionApprovalSet,
} from '@dorkos/shared/extension-approval-schemas';
import { extensionQueryKeys } from '@/layers/entities/extension';
import { extensionApiUrl } from '../model/extension-api-url';

/** A refusal from the server, with its code when it sent one. */
export class ApprovalSetError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = 'ApprovalSetError';
  }
}

/** Read the server's answer, or throw its sentence and code. */
async function answer<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ApprovalSetError(
      body.error ?? `${fallback} The server answered ${res.status}.`,
      body.code
    );
  }
  return res.json() as Promise<T>;
}

/** What "Allow all" answers: each member's result. */
export interface ApprovalSetOutcome {
  results: ApprovalSetResult[];
  allAllowed: boolean;
}

/** Allow every waiting member of the set the card showed. */
export function useApproveExtensionSet() {
  const queryClient = useQueryClient();
  return useMutation<ApprovalSetOutcome, Error, ExtensionApprovalSet>({
    mutationFn: async (set) =>
      answer(
        await fetch(extensionApiUrl('/extensions/approve-set'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            plugin: set.plugin,
            members: set.members.flatMap((member) => (member.echo ? [member.echo] : [])),
            setHash: set.setHash,
          }),
        }),
        'Couldn’t allow these extensions.'
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: extensionQueryKeys.all }),
  });
}
