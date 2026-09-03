import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

/** Delete an agent and its `.dork` directory by ID. */
export function useDeleteAgentData() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    // Without a label the shared mutation toast throws the server's sentence
    // away and says "Action failed. Please try again." — which is a dead end
    // for the one refusal this route has: the agent's file is tracked by git,
    // so its folder is not DorkOS's to delete. That sentence tells the person
    // what to do instead, and it only reaches them through here (DOR-1019).
    meta: { errorLabel: `Couldn't delete this agent's files` },
    mutationFn: (id: string) => transport.deleteAgentData(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mesh', 'agents'] });
      queryClient.invalidateQueries({ queryKey: ['mesh', 'topology'] });
      // A deleted agent has to leave the Team roster too. A raw literal: one
      // entity may not import a sibling entity's constant.
      queryClient.invalidateQueries({ queryKey: ['team'] });
    },
  });
}
