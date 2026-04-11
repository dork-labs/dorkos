import { useState } from 'react';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  DirectoryPicker,
  Label,
  Input,
  Button,
  PathInput,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/layers/shared/ui';
import { useRegisterAgent } from '@/layers/entities/mesh';
import type { AgentRuntime } from '@dorkos/shared/mesh-schemas';

const RUNTIME_OPTIONS: { value: AgentRuntime; label: string }[] = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'codex', label: 'Codex' },
  { value: 'other', label: 'Other' },
];

const MAX_NAME_LENGTH = 100;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Dialog form for manually registering a mesh agent. */
export function RegisterAgentDialog({ open, onOpenChange }: Props) {
  const registerAgent = useRegisterAgent();

  const [agentPath, setAgentPath] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [runtime, setRuntime] = useState<AgentRuntime>('claude-code');
  const [capabilities, setCapabilities] = useState('');
  const [cwdPickerOpen, setCwdPickerOpen] = useState(false);

  const isValid = agentPath.trim() && name.trim();
  const isPending = registerAgent.isPending;

  function resetForm() {
    setAgentPath('');
    setName('');
    setDescription('');
    setRuntime('claude-code');
    setCapabilities('');
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid || isPending) return;

    const parsedCapabilities = capabilities
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);

    registerAgent.mutate(
      {
        path: agentPath.trim(),
        overrides: {
          name: name.trim(),
          ...(description.trim() && { description: description.trim() }),
          runtime,
          ...(parsedCapabilities.length > 0 && { capabilities: parsedCapabilities }),
        },
      },
      {
        onSuccess: () => {
          onOpenChange(false);
          resetForm();
        },
      }
    );
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="max-h-[85vh] max-w-md gap-0 p-0">
        <ResponsiveDialogHeader className="border-b px-4 py-3">
          <ResponsiveDialogTitle>Register Agent</ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="sr-only">
            Manually register an agent into the mesh
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <form onSubmit={handleSubmit} id="register-agent-form">
          <div className="space-y-5 overflow-y-auto px-4 py-5">
            {/* Path */}
            <div className="space-y-1.5">
              <Label htmlFor="agent-path">Agent Path *</Label>
              <PathInput
                id="agent-path"
                value={agentPath}
                onChange={setAgentPath}
                placeholder="/path/to/agent/workspace"
                onBrowse={() => setCwdPickerOpen(true)}
                required
              />
            </div>

            {/* Name */}
            <div className="space-y-1.5">
              <Label htmlFor="agent-name">Name *</Label>
              <Input
                id="agent-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={MAX_NAME_LENGTH}
                placeholder="my-code-agent"
                required
              />
            </div>

            {/* Description */}
            <div className="space-y-1.5">
              <Label htmlFor="agent-description">Description</Label>
              <Input
                id="agent-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Handles code reviews and testing"
              />
            </div>

            {/* Runtime */}
            <div className="space-y-1.5">
              <Label htmlFor="agent-runtime">Runtime</Label>
              <Select value={runtime} onValueChange={(v) => setRuntime(v as AgentRuntime)}>
                <SelectTrigger id="agent-runtime" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RUNTIME_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Capabilities */}
            <div className="space-y-1.5">
              <Label htmlFor="agent-capabilities">Capabilities</Label>
              <Input
                id="agent-capabilities"
                value={capabilities}
                onChange={(e) => setCapabilities(e.target.value)}
                placeholder="code-review, testing, refactoring"
              />
              <p className="text-muted-foreground text-xs">Comma-separated list of capabilities</p>
            </div>
          </div>
        </form>

        <ResponsiveDialogFooter className="border-t px-4 py-3">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            form="register-agent-form"
            disabled={!isValid || isPending}
          >
            {isPending ? 'Registering...' : 'Register'}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
      <DirectoryPicker
        open={cwdPickerOpen}
        onOpenChange={setCwdPickerOpen}
        onSelect={(path) => setAgentPath(path)}
      />
    </ResponsiveDialog>
  );
}
