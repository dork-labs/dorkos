/** Keep domain-owned API registration out of the large legacy path registry. */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { registerFileWriteOpenApi } from '../../canvas/doc-channel/writes/file-writes-openapi.js';
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
import { registerConnectorHoldsOpenApi } from '../../connectors/execution/holds-openapi.js';

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
  registerConnectorHoldsOpenApi(registry);
}
