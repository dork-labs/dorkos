import type { ConnectorManagementReviewItem } from '@dorkos/shared/connector-schemas';

/** A durable management review's dialog title and approve button label. */
export function presentManagementReview(review: ConnectorManagementReviewItem): {
  title: string;
  approveLabel: string;
} {
  const context = review.context;
  if (context.kind === 'unavailable') {
    return {
      title: 'Older connection request',
      approveLabel: 'Approve',
    };
  }
  switch (context.kind) {
    case 'connect':
      return {
        title: `Connect ${context.label ?? context.toolkit}`,
        approveLabel: 'Approve and continue',
      };
    case 'edit':
      return {
        title: `Rename ${context.connection.label}`,
        approveLabel: 'Approve rename',
      };
    case 'pause':
      return {
        title: `Pause ${context.connection.label}`,
        approveLabel: 'Approve pause',
      };
    case 'resume':
      return {
        title: `Resume ${context.connection.label}`,
        approveLabel: 'Approve resume',
      };
    case 'disconnect':
      return {
        title: `Disconnect ${context.connection.label}`,
        approveLabel: 'Approve disconnect',
      };
    case 'set_agent_access':
      return {
        title: `Change access for ${context.agent.displayName}`,
        approveLabel: 'Approve access',
      };
    case 'remove_agent_access':
      return {
        title: `Remove access for ${context.agent.displayName}`,
        approveLabel: 'Approve removal',
      };
  }
}

/** Convert an operation slug to the compact label used in review details. */
export function managementOperationLabel(slug: string): string {
  const leaf = slug.split('.').at(-1) ?? slug;
  return leaf.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
