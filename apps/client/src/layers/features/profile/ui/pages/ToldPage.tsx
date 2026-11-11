/**
 * What this agent knows (DOR-4115; spec `context-viewer` phase 3): first what
 * it can do in DorkOS, in plain words with each live level, and a way to ask
 * it cold; then the instructions it receives, in the order the model reads
 * them, with a switcher for runtime, place and level.
 *
 * The server writes the instructions with the same builders a real turn uses,
 * so they are the effective result, not a copy. Per-turn values (memory, the
 * fence code) stay chips: they change each turn.
 *
 * @module features/profile/ui/pages/ToldPage
 */
import { useState } from 'react';
import {
  InstructionsViewer,
  useInstructionsPreview,
  type InstructionsSelection,
} from '@/layers/entities/agent-instructions';
import { useAgentLevel } from '@/layers/entities/permissions';
import { AgentCanDo } from '@/layers/features/permissions';
import { newSessionTarget, reportClientError } from '@/layers/shared/lib';
import { useSafeNavigate, useTransport } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { coldCheckPrompt } from '../../lib/cold-check';
import type { ProfilePageContentProps } from './types';

/**
 * "Ask {agent}": a new chat in the agent's folder whose first message is the
 * cold check, sent at once. A new chat, never the one open now, so the answer
 * comes from what the agent is told and not from this conversation.
 */
function AskCard({ member }: Pick<ProfilePageContentProps, 'member'>) {
  const navigate = useSafeNavigate();
  const transport = useTransport();
  const projectPath = member.agent?.projectPath;
  const [starting, setStarting] = useState(false);
  // Outside a router (a preview) there is nowhere to go, so no button.
  if (!projectPath || !navigate) return null;

  const ask = () => {
    setStarting(true);
    void newSessionTarget(transport, {
      dir: projectPath,
      ...(member.agent?.effectiveRuntimeId && { runtime: member.agent.effectiveRuntimeId }),
      prompt: coldCheckPrompt(member.displayName),
      send: '1',
    })
      .then((target) => navigate(target))
      .catch((error) => reportClientError(transport, error))
      .finally(() => setStarting(false));
  };

  return (
    <div
      className="bg-muted/40 flex items-center justify-between gap-4 rounded-lg p-3"
      data-testid="agent-cold-check"
    >
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium">Check what {member.displayName} thinks it can do</p>
        <p className="text-muted-foreground text-sm">
          Starts a new chat that asks cold, then compares with this list.
        </p>
      </div>
      <Button variant="secondary" size="sm" onClick={ask} disabled={starting}>
        Ask {member.displayName}
      </Button>
    </div>
  );
}

/** What one agent can do, and everything it is told. */
export function ToldPage({ member, onPush }: ProfilePageContentProps) {
  const level = useAgentLevel(member.id).data?.effective ?? undefined;
  const [selection, setSelection] = useState<InstructionsSelection | null>(null);
  // Starts at the agent's own runtime and level; a person's pick then holds.
  const current: InstructionsSelection = selection ?? { place: 'direct', level: level ?? 'act' };
  const preview = useInstructionsPreview(member.id, current);

  return (
    <div className="space-y-6" data-slot="profile-told">
      <AgentCanDo
        agentId={member.id}
        agentName={member.displayName}
        onOpenPermissions={() => onPush({ kind: 'page', page: 'permissions' })}
      />
      <AskCard member={member} />
      <InstructionsViewer
        selection={current}
        onSelectionChange={setSelection}
        result={preview}
        intro="Its next turn, in model order. Chips change each turn."
      />
    </div>
  );
}
