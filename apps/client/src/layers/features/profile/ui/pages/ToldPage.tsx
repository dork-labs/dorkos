/**
 * What {agent} knows (DOR-4115; spec `context-viewer` phase 3): first what the
 * agent can do in DorkOS, each area with its live level; then the instructions
 * it receives, in the order the model reads them, with a switcher for runtime,
 * place and level.
 *
 * The server writes the instructions with the same builders a real turn uses,
 * so they are the effective result, not a copy. It replaces the old in-editor
 * preview, which rebuilt four blocks in the browser and could drift from the
 * server. Per-turn values (memory, the fence code) stay chips: they change
 * each turn.
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
import type { ProfilePageContentProps } from './types';

/** What one agent can do, and everything it is told. */
export function ToldPage({ member, onPush }: ProfilePageContentProps) {
  const level = useAgentLevel(member.id).data?.effective ?? undefined;
  const [selection, setSelection] = useState<InstructionsSelection | null>(null);
  // Starts at the agent's own runtime and level; a person's pick then holds.
  const current: InstructionsSelection = selection ?? { place: 'direct', level: level ?? 'act' };
  const preview = useInstructionsPreview(member.id, current);

  return (
    <div className="space-y-8" data-slot="profile-told">
      <AgentCanDo
        agentId={member.id}
        agentName={member.displayName}
        onOpenPermissions={() => onPush({ kind: 'page', page: 'permissions' })}
      />
      <InstructionsViewer
        selection={current}
        onSelectionChange={setSelection}
        result={preview}
        intro="Its next turn, in model order. Chips change each turn."
      />
    </div>
  );
}
