/**
 * An agent changing several settings at once (DOR-4775): the sentence counts
 * them and the detail lists every one, riskiest first. The agent sent the long
 * harmless keys first; the text is exactly what `config-patch-card.ts` builds
 * for that patch.
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
  'mesh.scanRoots',
  'tunnel.enabled: yes',
  'extensions.enabled',
  'scheduler.maxConcurrentRuns: 4',
  'ui.collapseFinishedToolCallsAfterTheTurnEnds: yes',
  'ui.highlightMentionsOfYourNameInRoomMessages: yes',
  'ui.keepTheComposerOpenAfterSendingAMessage: yes',
  'ui.showAgentActivityInTheSidebarWhileAChatIsRunning: yes',
  'ui.theme: "dark"',
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
  summary: 'Scout wants to run "Update configuration" with changes: "9 settings, 4 need you"',
  detail: CONFIG_PATCH_CARD_DETAIL,
  requestedAt: new Date(LOADED_AT).toISOString(),
  expiresAt: new Date(LOADED_AT + 90 * 60_000).toISOString(),
};

/** One settings card whose risky changes lead, whatever order the agent sent. */
export function ConfigPatchCardShowcase() {
  return (
    <>
      <ShowcaseLabel>An agent changing several settings at once, riskiest first</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <ApprovalList approvals={[CARD]} />
      </ShowcaseDemo>
    </>
  );
}
