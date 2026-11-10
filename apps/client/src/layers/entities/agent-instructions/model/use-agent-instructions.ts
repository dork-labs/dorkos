import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { InstructionsQuery } from '@dorkos/shared/agent-instructions-schemas';
import { useTransport } from '@/layers/shared/model';

/** Every agent instructions query sits under this prefix. */
const INSTRUCTIONS_KEY = ['agent-instructions'] as const;

/** The query keys the agent instructions hooks read under. */
export const instructionsKeys = {
  /** Everything instructions-shaped. */
  all: INSTRUCTIONS_KEY,
  /** `GET /api/agent-instructions`. */
  template: (query: Partial<InstructionsQuery>) =>
    [...INSTRUCTIONS_KEY, 'template', query] as const,
  /** `GET /api/agents/:id/instructions`. */
  preview: (agentId: string, query: Partial<InstructionsQuery>) =>
    [...INSTRUCTIONS_KEY, 'preview', agentId, query] as const,
};

/**
 * What every agent is told, as a template.
 *
 * Keeps the last view on screen while a switch loads the next, so changing
 * runtime does not flash the list away.
 *
 * @param query - Runtime, place and level.
 */
export function useInstructionsTemplate(query: Partial<InstructionsQuery>) {
  const transport = useTransport();
  return useQuery({
    queryKey: instructionsKeys.template(query),
    queryFn: () => transport.getAgentInstructionsTemplate(query),
    placeholderData: keepPreviousData,
  });
}

/**
 * What one agent will be told.
 *
 * @param agentId - The agent; the query waits until one is known.
 * @param query - Runtime, place and level; no runtime means the agent's own.
 */
export function useInstructionsPreview(
  agentId: string | undefined,
  query: Partial<InstructionsQuery>
) {
  const transport = useTransport();
  return useQuery({
    queryKey: instructionsKeys.preview(agentId ?? '', query),
    queryFn: () => transport.getAgentInstructionsPreview(agentId!, query),
    enabled: Boolean(agentId),
    placeholderData: keepPreviousData,
  });
}
