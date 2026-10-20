/**
 * Where every `codex app-server` notification goes: mapped for a turn,
 * handled by the transport for the thread, or ignored. Keyed on the full
 * `ServerNotificationMethod` union, so a notification a later binary adds
 * fails compilation here until somebody decides what it means.
 *
 * @module services/runtimes/codex/app-server/notification-disposition
 */
import type { ServerNotificationMethod } from './protocol/methods.js';

/** Where a notification goes. */
export type NotificationDisposition =
  /** Mapped for the turn it names. */
  | 'turn'
  /** About the thread or process, not a turn; the transport handles it. */
  | 'thread'
  /** Not used by DorkOS (counted, ignored). */
  | 'ignored';

/**
 * Every notification the pinned binary can send, and where it goes. A
 * `Record` over the full union: adding a method to `methods.ts` without an
 * entry here is a compile error.
 */
export const NOTIFICATION_DISPOSITION: Record<ServerNotificationMethod, NotificationDisposition> = {
  error: 'turn',
  'thread/started': 'thread',
  'thread/status/changed': 'ignored',
  'thread/readState/changed': 'ignored',
  'thread/archived': 'ignored',
  'thread/deleted': 'ignored',
  'thread/unarchived': 'ignored',
  'thread/closed': 'thread',
  'thread/reverted': 'ignored',
  'skills/changed': 'ignored',
  'thread/name/updated': 'ignored',
  'thread/attachment/updated': 'ignored',
  'thread/goal/updated': 'ignored',
  'thread/prediction/updated': 'ignored',
  'thread/goal/cleared': 'ignored',
  'thread/queue/changed': 'ignored',
  'project/changed': 'ignored',
  'thread/project/updated': 'ignored',
  'thread/environment/connected': 'ignored',
  'thread/environment/disconnected': 'ignored',
  'thread/settings/updated': 'ignored',
  'thread/tokenUsage/updated': 'turn',
  'turn/started': 'turn',
  'hook/started': 'ignored',
  'turn/completed': 'turn',
  'hook/completed': 'ignored',
  'turn/diff/updated': 'ignored',
  'turn/plan/updated': 'turn',
  'item/started': 'turn',
  'item/autoApprovalReview/started': 'ignored',
  'item/autoApprovalReview/completed': 'ignored',
  'autoApprovalReview/strictReviewRequired': 'ignored',
  'item/completed': 'turn',
  'item/agentMessage/delta': 'turn',
  'item/plan/delta': 'ignored',
  'command/exec/outputDelta': 'ignored',
  'process/outputDelta': 'ignored',
  'process/exited': 'ignored',
  'item/commandExecution/outputDelta': 'turn',
  'item/commandExecution/terminalInteraction': 'ignored',
  'item/fileChange/outputDelta': 'ignored',
  'item/fileChange/patchUpdated': 'ignored',
  'serverRequest/resolved': 'thread',
  'item/mcpToolCall/progress': 'turn',
  'mcpServer/oauthLogin/completed': 'ignored',
  'mcpServer/startupStatus/updated': 'ignored',
  'mcpServer/event/stream/notification': 'ignored',
  'account/updated': 'ignored',
  'account/gatewayOAuth/changed': 'ignored',
  'account/rateLimits/updated': 'thread',
  'app/list/updated': 'ignored',
  'remoteControl/status/changed': 'ignored',
  'externalAgentConfig/import/progress': 'ignored',
  'externalAgentConfig/import/completed': 'ignored',
  'fs/changed': 'ignored',
  'item/reasoning/summaryTextDelta': 'turn',
  'item/reasoning/summaryPartAdded': 'ignored',
  'item/reasoning/textDelta': 'ignored',
  'thread/compacted': 'turn',
  'model/rerouted': 'turn',
  'model/verification': 'ignored',
  'modelProvider/authRecoveryStarted': 'ignored',
  'modelProvider/authRecoveryCompleted': 'ignored',
  'turn/moderationMetadata': 'ignored',
  'model/safetyBuffering/updated': 'ignored',
  warning: 'thread',
  guardianWarning: 'ignored',
  deprecationNotice: 'thread',
  configWarning: 'thread',
  'fuzzyFileSearch/sessionUpdated': 'ignored',
  'fuzzyFileSearch/sessionCompleted': 'ignored',
  'thread/realtime/started': 'ignored',
  'thread/realtime/itemAdded': 'ignored',
  'thread/realtime/item/started': 'ignored',
  'thread/realtime/item/transcript/delta': 'ignored',
  'thread/realtime/item/completed': 'ignored',
  'thread/realtime/transcript/delta': 'ignored',
  'thread/realtime/transcript/done': 'ignored',
  'thread/realtime/outputAudio/delta': 'ignored',
  'thread/realtime/sdp': 'ignored',
  'thread/realtime/error': 'ignored',
  'thread/realtime/closed': 'ignored',
  'windows/worldWritableWarning': 'ignored',
  'windowsSandbox/setupCompleted': 'ignored',
  'account/login/completed': 'ignored',
};
