/**
 * Pull requests — every pull request this agent's chats opened, claimed or
 * worked on, newest first (W5, DOR-4971).
 *
 * @module features/profile/ui/pages/PullRequestsPage
 */
import { useAgentPullRequests, WorkItemList } from '@/layers/entities/work-graph';
import type { ProfilePageContentProps } from './types';

/**
 * This agent's pull requests, each a link to GitHub when its repository is
 * known.
 */
export function PullRequestsPage({ member }: ProfilePageContentProps) {
  const query = useAgentPullRequests(member.agent?.manifestId ?? null);
  return (
    <div data-slot="profile-pull-requests">
      <WorkItemList query={query} emptyText={`${member.displayName} has no pull requests yet.`} />
    </div>
  );
}
