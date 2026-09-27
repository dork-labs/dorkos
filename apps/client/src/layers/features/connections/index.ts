/**
 * Connections feature — the working parts of the /connections surface: the
 * service grid and connect flow, the shared "who can use it" access card
 * (page and chat), the accounts list, standing per-agent accounts and the
 * claim feed for chats nobody answers. Also the session view's quiet accounts
 * group, and the two sections Settings › Connections renders: the ways DorkOS
 * reaches your apps and how chat apps behave.
 *
 * @module features/connections
 */
export { ServiceGrid } from './ui/ServiceGrid';
export { ConnectDialog } from './ui/ConnectDialog';
export { AccountsList, AccountRow } from './ui/AccountsList';
export { ConnectionDetailSheet } from './ui/ConnectionDetailSheet';
export { ClaimFeed } from './ui/ClaimFeed';
export { ClaimCard } from './ui/ClaimCard';
// The plumbing half, rendered by Settings › Connections: how DorkOS reaches
// apps, and how chat apps behave when a message arrives.
export { ConnectionWays } from './ui/ConnectionWays';
export type { ConnectionWaysProps } from './ui/ConnectionWays';
export { ChatAppSettings } from './ui/ChatAppSettings';
export { SessionConnectorsGroup } from './ui/SessionConnectorsGroup';
export { ConnectionAccessDialog } from './ui/access/ConnectionAccessDialog';
export { ConnectionAccessCard } from './ui/access/ConnectionAccessCard';
export type {
  ConnectionAccessCardProps,
  PageAccessCardProps,
  AgentAccessCardProps,
} from './ui/access/ConnectionAccessCard';
export { ManagementReviews } from './ui/ManagementReviews';
export { AgentRequests } from './ui/AgentRequests';
