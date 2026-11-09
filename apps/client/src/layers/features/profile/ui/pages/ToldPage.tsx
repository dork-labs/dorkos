/**
 * What this agent is told (spec `context-viewer` phase 3): the instructions
 * one agent receives, in the order the model reads them, with a switcher for
 * runtime, place and level.
 *
 * The server writes it with the same builders a real turn uses, so it is the
 * effective result, not a copy. It replaces the old in-editor preview, which
 * rebuilt four blocks in the browser and could drift from the server.
 * Per-turn values (memory, the fence code) stay chips: they change each turn.
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
import type { ProfilePageContentProps } from './types';

/** One agent's instructions. */
export function ToldPage({ member }: ProfilePageContentProps) {
  const level = useAgentLevel(member.id).data?.effective ?? undefined;
  const [selection, setSelection] = useState<InstructionsSelection | null>(null);
  // Starts at the agent's own runtime and level; a person's pick then holds.
  const current: InstructionsSelection = selection ?? { place: 'direct', level: level ?? 'act' };
  const preview = useInstructionsPreview(member.id, current);

  return (
    <div data-slot="profile-told">
      <InstructionsViewer
        selection={current}
        onSelectionChange={setSelection}
        result={preview}
        intro="Its next turn, in model order. Chips change each turn."
      />
    </div>
  );
}
