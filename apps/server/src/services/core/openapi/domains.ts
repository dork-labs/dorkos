/** Keep domain-owned API registration out of the large legacy path registry. */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { registerFileWriteOpenApi } from '../../canvas/doc-channel/writes/file-writes-openapi.js';
import { registerDocRouteControlsOpenApi } from '../../canvas/doc-channel/route-controls/openapi.js';
import { registerConnectorEventOpenApi } from '../../connectors/events/openapi.js';
import { registerSessionContinueOpenApi } from '../../session/fleet/continue-openapi.js';
import { registerSessionLocationsOpenApi } from '../../session/resolution/session-locations-openapi.js';
import { registerProjectsOpenApi } from '../../projects/projects-openapi.js';
import { registerAccountEligibilityOpenApi } from '../usage/account-eligibility-openapi.js';
import { registerKeepAwakeOpenApi } from '../keep-awake/keep-awake-openapi.js';
import { registerCommitmentsOpenApi } from '../../commitments/commitments-openapi.js';
import { registerHeartbeatsOpenApi } from '../../heartbeats/heartbeats-openapi.js';
import { registerOnboardingOpenApi } from '../onboarding/onboarding-openapi.js';
import { registerComputerOpenApi } from '../../computers/computer-openapi.js';
import { registerLocalBrowserOpenApi } from '../../session/local-browser/openapi.js';
import { registerConnectorHoldsOpenApi } from '../../connectors/execution/holds-openapi.js';
import { registerHubComputersOpenApi } from '../hub-relay/hub-computers-openapi.js';
import { registerHubLinkOpenApi } from '../hub-relay/hub-link-openapi.js';
import { registerSessionRelayOpenApi } from '../session-relay/session-relay-openapi.js';

/** Register independent domain paths in their existing order. */
export function registerDomainOpenApi(registry: OpenAPIRegistry): void {
  registerConnectorEventOpenApi(registry);
  registerSessionContinueOpenApi(registry);
  registerSessionLocationsOpenApi(registry);
  registerProjectsOpenApi(registry);
  registerAccountEligibilityOpenApi(registry);
  registerKeepAwakeOpenApi(registry);
  registerCommitmentsOpenApi(registry);
  registerHeartbeatsOpenApi(registry);
  registerOnboardingOpenApi(registry);
  registerComputerOpenApi(registry);
  registerFileWriteOpenApi(registry);
  registerDocRouteControlsOpenApi(registry);
  registerConnectorHoldsOpenApi(registry);
  registerLocalBrowserOpenApi(registry);
  registerHubComputersOpenApi(registry);
  registerHubLinkOpenApi(registry);
  registerSessionRelayOpenApi(registry);
}
