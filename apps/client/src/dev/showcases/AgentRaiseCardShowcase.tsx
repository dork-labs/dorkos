/**
 * An agent's front-door raise on a card (DOR-4355 M4): the effect the server
 * read, from → to, the connection named by its type and id, and a name an
 * agent could have set kept to its own quoted line. The text is exactly what
 * `agent-raise-cards.ts` and the route describers build.
 *
 * @module dev/showcases/AgentRaiseCardShowcase
 */
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import { ApprovalList } from '@/layers/features/approvals';

/** Frozen at module load, so the countdown doesn't shift on every render. */
const LOADED_AT = Date.now();

/** One agent-raise card, as the server stores it. */
function raiseCard(overrides: Partial<PendingApproval>): PendingApproval {
  return {
    approvalId: '01JZ0000000000000000000061',
    capabilityId: 'agent-raise.relay.allowlist',
    capabilityTitle: 'Let someone reach your agents',
    tier: 'act',
    area: null,
    requestedBy: 'Porter',
    hasAgentPath: true,
    alwaysOffered: false,
    answerNeedsStepUp: true,
    requestCode: 'K7QD-M2XP-9HTA',
    summary: 'Let U0NEWBIE1 approve your agents’ requests on the Slack connection northwind-sl.',
    detail: 'Who may approve: U0OWNER01 → U0OWNER01, U0NEWBIE1',
    requestedAt: new Date(LOADED_AT).toISOString(),
    expiresAt: new Date(LOADED_AT + 10 * 60_000).toISOString(),
    ...overrides,
  };
}

/** The two cards an agent can raise today: a list addition and a chat-route raise. */
export function AgentRaiseCardShowcase() {
  return (
    <ApprovalList
      approvals={[
        // An agent named this connection, so its name sits under the box.
        raiseCard({ detailNote: 'Its name, which an agent can set: “Your own Telegram, alre…”' }),
        raiseCard({
          approvalId: '01JZ0000000000000000000062',
          capabilityId: 'agent-raise.relay.binding',
          capabilityTitle: 'Let a chat connection do more',
          requestCode: 'R4WN-8CJE-T6YB',
          summary: 'Let a chat route on the Telegram connection support-tg do more.',
          detail: ['May start chats: No → Yes', 'Permission level: Ask first → Act'].join('\n'),
        }),
      ]}
    />
  );
}
