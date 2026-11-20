/**
 * An agent changing several settings at once (DOR-4775): the sentence counts
 * them and names the riskiest that need a person; the detail lists every one
 * old → new, riskiest first, each a person must decide marked. The agent sent
 * the long harmless keys first; the text is what `config-patch-card.ts` builds
 * for that patch against a made-up stored config.
 *
 * @module dev/showcases/ConfigPatchCardShowcase
 */
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import { ApprovalList } from '@/layers/features/approvals';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/** Frozen at module load, so the countdown doesn't shift on every render. */
const LOADED_AT = Date.now();

/** The card's detail, one setting per line, as the server writes it. */
const CONFIG_PATCH_CARD_DETAIL = [
  'runtimes.claudeCode.projectAccounts["/Users/kai/client-app"].allow: adds "Work", removes "Main" (needs you)',
  'runtimes.doe.inference.credentialEndpoint: "https://keys.example.test/v1" → "https://keys.north-shop.test/v1" (needs you)',
  'mesh.scanRoots: adds "/Users/kai/clients" (needs you)',
  'tunnel.enabled: no → yes (needs you)',
  'connectors.rawMcpServers: adds "CRM" at "https://crm.example.test/mcp" (needs you)',
  'extensions.enabled: adds "invoice-helper" (needs you)',
  'scheduler.maxConcurrentRuns: 2 → 4 (needs you)',
  'ui.collapseFinishedToolCallsAfterTheTurnEnds: no → yes',
  'ui.highlightMentionsOfYourNameInRoomMessages: no → yes',
  'ui.keepTheComposerOpenAfterSendingAMessage: no → yes',
  'ui.showAgentActivityInTheSidebarWhileAChatIsRunning: no → yes',
  'ui.theme: "light" → "dark"',
].join('\n');

const CARD: PendingApproval = {
  approvalId: '01JZ0000000000000000000081',
  capabilityId: 'operator.config_patch',
  capabilityTitle: 'Update configuration',
  tier: 'act',
  area: null,
  requestedBy: 'Scout',
  hasAgentPath: true,
  alwaysOffered: false,
  answerNeedsStepUp: false,
  summary:
    '"Scout" wants to change 12 settings. 7 need you: projectAccounts.allow, inference.credentialEndpoint, mesh.scanRoots and 4 more',
  detail: CONFIG_PATCH_CARD_DETAIL,
  requestedAt: new Date(LOADED_AT).toISOString(),
  expiresAt: new Date(LOADED_AT + 90 * 60_000).toISOString(),
};

/** One settings card whose risky changes lead, whatever order the agent sent. */
export function ConfigPatchCardShowcase() {
  return (
    <>
      <ShowcaseLabel>
        An agent changing several settings at once, old → new, riskiest first
      </ShowcaseLabel>
      <ShowcaseDemo responsive>
        <ApprovalList approvals={[CARD]} />
      </ShowcaseDemo>
    </>
  );
}
