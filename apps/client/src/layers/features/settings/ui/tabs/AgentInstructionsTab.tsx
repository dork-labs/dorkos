/**
 * Settings › Agent instructions (spec `context-viewer` phase 3): what every
 * agent is told, as a template, in the order the model reads it.
 *
 * The person's view: it carries per-block override counts and "Preview as…",
 * which fills the template for one agent. Agents read the template through
 * their own tool, without either (Security ruling 8). Read only: editing is
 * phase 5.
 *
 * @module features/settings/ui/tabs/AgentInstructionsTab
 */
import { useState } from 'react';
import { Eye } from 'lucide-react';
import {
  InstructionsViewer,
  useInstructionsPreview,
  useInstructionsTemplate,
  type InstructionsSelection,
} from '@/layers/entities/agent-instructions';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import {
  Button,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui';

const DEFAULT_SELECTION: InstructionsSelection = { place: 'direct', level: 'act' };

/** The tab. */
export function AgentInstructionsTab() {
  const [selection, setSelection] = useState<InstructionsSelection>(DEFAULT_SELECTION);
  const [previewOpen, setPreviewOpen] = useState(false);
  const template = useInstructionsTemplate(selection);

  return (
    <>
      <InstructionsViewer
        selection={selection}
        onSelectionChange={setSelection}
        result={template}
        intro="What every agent is told, in model order. Chips fill in per agent."
        actions={
          <Button variant="outline" size="sm" onClick={() => setPreviewOpen(true)}>
            <Eye aria-hidden />
            Preview as…
          </Button>
        }
      />
      <PreviewAsDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        initial={{ place: selection.place, level: selection.level }}
      />
    </>
  );
}

/**
 * "Preview as…": pick an agent, a place and a level, and read what that agent
 * would be told.
 *
 * @param props - Whether it is open, and the place and level to start from.
 */
function PreviewAsDialog({
  open,
  onOpenChange,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: InstructionsSelection;
}) {
  const agents = useRegisteredAgents(undefined, open);
  const list = agents.data?.agents ?? [];
  const [agentId, setAgentId] = useState<string | undefined>(undefined);
  const chosen = agentId ?? list[0]?.id;
  const [selection, setSelection] = useState<InstructionsSelection>(initial);
  const preview = useInstructionsPreview(open ? chosen : undefined, selection);
  const name = list.find((agent) => agent.id === chosen);

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="max-h-[90vh] md:max-w-2xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="text-sm font-medium">Preview as…</ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="text-muted-foreground text-xs">
            The template, filled in for one agent.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="space-y-4 overflow-y-auto">
          <Select value={chosen ?? ''} onValueChange={setAgentId}>
            <SelectTrigger aria-label="Agent" className="w-full">
              <SelectValue placeholder="Pick an agent" />
            </SelectTrigger>
            <SelectContent>
              {list.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.displayName || agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {chosen ? (
            <InstructionsViewer
              selection={selection}
              onSelectionChange={setSelection}
              result={preview}
              intro={`What ${name?.displayName || name?.name || 'this agent'} is told on its next turn.`}
            />
          ) : (
            <p className="text-muted-foreground text-sm">No agents yet.</p>
          )}
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
