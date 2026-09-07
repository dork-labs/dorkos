import type { ConnectorManagementReviewItem } from '@dorkos/shared/connector-schemas';

/** Present a durable management review with short owner-facing labels. */
export function presentManagementReview(review: ConnectorManagementReviewItem): {
  title: string;
  summary: string;
  approveLabel: string;
} {
  const context = review.context;
  if (context.kind === 'unavailable') {
    return {
      title: 'Older connection request',
      summary: 'Verified details are unavailable',
      approveLabel: 'Approve',
    };
  }
  switch (context.kind) {
    case 'connect':
      return {
        title: `Connect ${context.label ?? context.toolkit}`,
        summary: `${context.toolkit} through ${context.providerDisplayName}`,
        approveLabel: 'Approve and continue',
      };
    case 'edit':
      return {
        title: `Rename ${context.connection.label}`,
        summary: 'Change account label',
        approveLabel: 'Approve rename',
      };
    case 'pause':
      return {
        title: `Pause ${context.connection.label}`,
        summary: 'Stop agent access until resumed',
        approveLabel: 'Approve pause',
      };
    case 'resume':
      return {
        title: `Resume ${context.connection.label}`,
        summary: 'Allow approved agent access again',
        approveLabel: 'Approve resume',
      };
    case 'disconnect':
      return {
        title: `Disconnect ${context.connection.label}`,
        summary: `${context.affectedAgentCount} affected ${context.affectedAgentCount === 1 ? 'agent' : 'agents'}`,
        approveLabel: 'Approve disconnect',
      };
    case 'set_agent_access':
      return {
        title: `Change access for ${context.agent.displayName}`,
        summary: `${context.connection.label} · ${context.requestedOperations.length} actions`,
        approveLabel: 'Approve access',
      };
    case 'remove_agent_access':
      return {
        title: `Remove access for ${context.agent.displayName}`,
        summary: context.connection.label,
        approveLabel: 'Approve removal',
      };
  }
}

/** Convert an operation slug to the compact label used in review details. */
export function managementOperationLabel(slug: string): string {
  const leaf = slug.split('.').at(-1) ?? slug;
  return leaf.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
