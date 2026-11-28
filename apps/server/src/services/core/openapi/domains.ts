/** Keep domain-owned API registration out of the large legacy path registry. */
import { registerAccountSigninOpenApi } from '../../health/account-signin-openapi.js';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { registerFileSaveRecoveryOpenApi } from '../../canvas/doc-channel/writes/file-save-recovery/openapi.js';
import { registerDocRouteControlsOpenApi } from '../../canvas/doc-channel/route-controls/openapi.js';
import { registerConnectorEventOpenApi } from '../../connectors/events/openapi.js';
import { registerConnectorSpendingOpenApi } from '../../connectors/spending/openapi.js';
import { registerSessionContinueOpenApi } from '../../session/fleet/continue-openapi.js';
import { registerSessionLocationsOpenApi } from '../../session/resolution/session-locations-openapi.js';
import { registerProjectsOpenApi } from '../../projects/projects-openapi.js';
import { registerAccountEligibilityOpenApi } from '../usage/account-eligibility-openapi.js';
import { registerOnboardingOpenApi } from '../onboarding/onboarding-openapi.js';
import { registerComputerOpenApi } from '../../computers/computer-openapi.js';
import { registerBrowserScanOpenApi } from '../../browser/profile-scan-openapi.js';
import { registerDiscoveryScanOpenApi } from './discovery-scan-openapi.js';
import { registerLocalBrowserOpenApi } from '../../session/local-browser/openapi.js';
import { registerConnectorHoldsOpenApi } from '../../connectors/execution/holds-openapi.js';
import { registerRelayAdapterListOpenApi, registerRelayAdapterOpenApi } from './relay-adapters.js';
import { registerConnectorExclusionsOpenApi } from '../../connectors/access/exclusions-openapi.js';
import { registerMiniAppAccessOpenApi } from '../../connectors/extensions/mini-app-access-openapi.js';
import {
  registerHubComputerStreamOpenApi,
  registerHubComputersOpenApi,
} from '../hub-relay/hub-computers-openapi.js';
import { registerHubLinkOpenApi } from '../hub-relay/hub-link-openapi.js';
import { registerSessionRelayOpenApi } from '../session-relay/session-relay-openapi.js';
import { registerDirectChatOpenApi } from '../../rooms/direct-chat/direct-chat-openapi.js';
import { registerDocLinksOpenApi } from '../../docs/links/doc-links-openapi.js';
import { registerDevicesOpenApi } from '../auth/sessions/devices-openapi.js';
import { registerOwnerFactorsOpenApi } from '../auth/factors/owner-factors-openapi.js';
import { registerProblemOpenApi } from './problem-openapi.js';
import { registerEventsOpenApi } from './events-openapi.js';
import { registerPushOpenApi } from './push-openapi.js';
import { registerServedStreamsOpenApi } from './served-streams-openapi.js';
import { RelayedSessionStreamFrameSchema } from './stream-frames-openapi.js';

// The chat and room stream frames, for the hand registry's two stream routes.
export { RoomStreamFrameSchema, SessionStreamFrameSchema } from './stream-frames-openapi.js';

/** Register independent domain paths in their existing order. */
export function registerDomainOpenApi(registry: OpenAPIRegistry): void {
  registerProblemOpenApi(registry);
  registerConnectorEventOpenApi(registry);
  registerConnectorSpendingOpenApi(registry);
  registerSessionContinueOpenApi(registry);
  registerSessionLocationsOpenApi(registry);
  registerProjectsOpenApi(registry);
  registerAccountEligibilityOpenApi(registry);
  registerOnboardingOpenApi(registry);
  registerComputerOpenApi(registry);
  // The file save itself (`PUT /api/files/content`) is the `files.save` capability (DOR-4978).
  registerFileSaveRecoveryOpenApi(registry);
  registerDocRouteControlsOpenApi(registry);
  registerConnectorHoldsOpenApi(registry);
  registerRelayAdapterOpenApi(registry);
  registerRelayAdapterListOpenApi(registry);
  registerConnectorExclusionsOpenApi(registry);
  registerMiniAppAccessOpenApi(registry);
  registerLocalBrowserOpenApi(registry);
  registerBrowserScanOpenApi(registry);
  registerDiscoveryScanOpenApi(registry);
  registerHubComputersOpenApi(registry);
  registerHubLinkOpenApi(registry);
  registerSessionRelayOpenApi(registry);
  registerDirectChatOpenApi(registry);
  registerDocLinksOpenApi(registry);
  registerDevicesOpenApi(registry);
  registerOwnerFactorsOpenApi(registry);
  registerAccountSigninOpenApi(registry);
  registerEventsOpenApi(registry);
  registerPushOpenApi(registry);
}

/**
 * Register the event streams whose frames reuse the chat stream's components.
 * Call it after the chat's own stream is registered: a component takes the form
 * of the first operation that uses it, so the chat stream's form stands.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerStreamOpenApi(registry: OpenAPIRegistry): void {
  registerHubComputerStreamOpenApi(registry, RelayedSessionStreamFrameSchema);
  registerServedStreamsOpenApi(registry);
}
