/**
 * Every capability that declares a caller bar (`http.callerBar`, DOR-4978),
 * with its bar, pinned by `owner-authority.test.ts`. Joining this list is a
 * reviewed edit: the mount runs the bar before the handler, and the handler
 * acts on what the bar let through.
 *
 * @module services/core/capabilities/__tests__/caller-bar-capabilities
 */
import type { HttpCallerBar } from '@dorkos/shared/capabilities';

export const CALLER_BAR_CAPABILITIES: Readonly<Record<string, HttpCallerBar>> = {
  'connectors.disconnect_impact': 'account-decision',
  'connectors.rename_connection': 'account-decision',
  'connectors.remove_connection': 'account-decision',
  'connectors.get_sign_in': 'account-decision',
  'connectors.get_review': 'account-decision',
  'connectors.get_agent_request_sign_in': 'account-decision',
  'connectors.stop_every_agent_share': 'account-decision',
  'connectors.leave_agent_out': 'account-decision',
  'connectors.list_usage': 'account-decision',
  'extensions.dismiss_approval': 'person',
  'extensions.remove': 'person',
  'extensions.forget_approval': 'person',
  'extensions.restart': 'person',
};
