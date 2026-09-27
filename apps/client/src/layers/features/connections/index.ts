/**
 * Connections feature — the working parts of the /connections page: the one
 * list of apps (yours, then all apps), an app account's side panel, the
 * connect flow, the shared "who can use it" access card (page and chat), the
 * "Needs you" strip with its request and review dialogs, and the claim feed
 * for chats nobody answers. Also the session view's quiet accounts group, the
 * two sections Settings › Connections renders (the ways DorkOS reaches your
 * apps and how chat apps behave), and the card an agent's request for an app
 * draws in a chat or a room.
 *
 * @module features/connections
 */
export { AppList } from './ui/app-list/AppList';
export type { AppListProps } from './ui/app-list/AppList';
export { YourAppRowView, CatalogAppRowView } from './ui/app-list/AppRow';
export { useAppList } from './model/use-app-list';
export type { AppListData } from './model/use-app-list';
export { appUses, chatAppAccount, remainingUses } from './lib/app-list';
export type {
  AppRowAction,
  AppRowTone,
  OwnedApps,
  PendingSignIn,
  YourAppRow,
} from './lib/app-list';
export { AccountPanel } from './ui/panel/AccountPanel';
export type { AccountPanelProps } from './ui/panel/AccountPanel';
export { PanelFix, PanelMoreRow, PanelSection } from './ui/panel/panel-parts';
export { ServiceMark } from './ui/ServiceMark';
export { NeedsYou } from './ui/NeedsYou';
export { AgentRequestDialog } from './ui/AgentRequestDialog';
export { ManagementReviewDialog } from './ui/ManagementReviewDialog';
export { ConnectDialog } from './ui/ConnectDialog';
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
export { AgentRequestCard } from './ui/agent-request/AgentRequestCard';
export type { AgentRequestCardProps } from './ui/agent-request/AgentRequestCard';
export { ChatAgentRequest } from './ui/agent-request/ChatAgentRequest';
export type { ChatAgentRequestProps } from './ui/agent-request/ChatAgentRequest';
export { isConnectionRequestTool } from './lib/agent-request-call';
