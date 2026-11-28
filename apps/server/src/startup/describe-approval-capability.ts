/**
 * Name the action an approval is about, for its card and its answer records:
 * a registered capability by its title (found by its own id, or by the old
 * tool name it is gated by, C9a), else one of the asks that are not
 * capabilities anyone can invoke. Without this a card shows the raw id.
 *
 * @module startup/describe-approval-capability
 */
import type { CapabilityRegistry } from '../services/core/capabilities/index.js';
import { capabilityByActionId } from '../services/core/capabilities/declarations/gate-action.js';
import { describeAgentRaiseCapability } from '../services/core/approvals/agent-raise/agent-raise-cards.js';
import { describeComputerAskCapability } from '../services/core/approvals/computer-asks/index.js';
import { describeGlobalActivationCapability } from '../services/marketplace/consent/ask-withheld-global-plugins.js';
import {
  describeTemplateCreationCapability,
  describeWorkspaceCreationCapability,
} from '../services/marketplace-mcp/confirmation-provider.js';

/**
 * Describe the action an approval names.
 *
 * @param registry - The composed registry, or `undefined` before it exists.
 * @param capabilityId - The approval's action id: a capability id, or a moved tool's old name.
 */
export function describeApprovalCapability(
  registry: CapabilityRegistry | undefined,
  capabilityId: string
) {
  const capability = registry ? capabilityByActionId(registry, capabilityId) : undefined;
  if (capability) {
    return {
      title: capability.title,
      tier: capability.tier,
      // An extension's tool names its extension, so its card can say so.
      ...(capability.source ? { source: capability.source } : {}),
    };
  }
  // The ids that are not capabilities anyone can invoke: a package's hook-file write
  // (DOR-522), a global package's activation (DOR-2306), the template and workspace
  // creation cards, and an agent's front-door raise.
  return (
    describeComputerAskCapability(capabilityId) ??
    describeGlobalActivationCapability(capabilityId) ??
    describeTemplateCreationCapability(capabilityId) ??
    describeWorkspaceCreationCapability(capabilityId) ??
    describeAgentRaiseCapability(capabilityId)
  );
}
