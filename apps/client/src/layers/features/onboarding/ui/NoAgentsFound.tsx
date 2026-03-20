import { useState, useCallback } from 'react';
import { Button, Input, Textarea, DirectoryPicker, Label } from '@/layers/shared/ui';
import { useCreateAgent } from '@/layers/entities/agent';
import { FolderOpen, Loader2, CheckCircle2, Bot } from 'lucide-react';
import { shortenHomePath } from '@/layers/shared/lib';

interface NoAgentsFoundProps {
  /** Called after an agent is successfully created. */
  onAgentCreated: () => void;
}

/**
 * Fallback UI shown when the onboarding discovery scan finds zero agent candidates.
 * Guides the user through creating their first agent with a simple form.
 *
 * @param onAgentCreated - Called after successful agent creation
 */
export function NoAgentsFound({ onAgentCreated }: NoAgentsFoundProps) {
  const [directory, setDirectory] = useState('');
  const [name, setName] = useState('');
  const [persona, setPersona] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [created, setCreated] = useState(false);

  const createAgent = useCreateAgent();

  const handleCreate = useCallback(() => {
    if (!directory || !name.trim()) return;

    createAgent.mutate(
      {
        path: directory,
        name: name.trim(),
        description: persona.trim() || undefined,
      },
      {
        onSuccess: () => {
          setCreated(true);
          // Brief delay so user sees the success state before callback
          setTimeout(onAgentCreated, 1200);
        },
      }
    );
  }, [directory, name, persona, createAgent, onAgentCreated]);

  if (created) {
    return (
      <div className="flex flex-col items-center justify-center space-y-4 py-12 text-center">
        <CheckCircle2 className="text-primary size-12" />
        <h3 className="text-lg font-semibold">Agent created</h3>
        <p className="text-muted-foreground text-sm">
          <span className="font-medium">{name}</span> is ready at{' '}
          <span className="font-mono text-xs">{shortenHomePath(directory)}</span>
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center space-y-6 py-8">
      {/* Header */}
      <div className="space-y-2 text-center">
        <div className="bg-muted mx-auto flex size-12 items-center justify-center rounded-full">
          <Bot className="text-muted-foreground size-6" />
        </div>
        <h3 className="text-lg font-semibold">No agents found</h3>
        <p className="text-muted-foreground mx-auto max-w-sm text-sm">
          Agents give your projects an identity. Each agent lives in a project directory and can
          have its own name, persona, and scheduled tasks.
        </p>
      </div>

      {/* Creation form */}
      <div className="w-full max-w-sm space-y-4">
        {/* Directory picker */}
        <div className="space-y-1.5">
          <Label htmlFor="agent-directory">Project directory</Label>
          <button
            id="agent-directory"
            type="button"
            onClick={() => setPickerOpen(true)}
            className={`border-input bg-background hover:bg-accent flex h-10 w-full items-center gap-2 rounded-md border px-3 text-sm transition-colors ${
              directory ? 'text-foreground' : 'text-muted-foreground'
            }`}
          >
            <FolderOpen className="size-4 flex-shrink-0" />
            <span className="truncate">
              {directory ? shortenHomePath(directory) : 'Select a directory...'}
            </span>
          </button>
          <DirectoryPicker open={pickerOpen} onOpenChange={setPickerOpen} onSelect={setDirectory} />
        </div>

        {/* Agent name */}
        <div className="space-y-1.5">
          <Label htmlFor="agent-name">Agent name</Label>
          <Input
            id="agent-name"
            type="text"
            placeholder="e.g. my-project"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        {/* Persona */}
        <div className="space-y-1.5">
          <Label htmlFor="agent-persona">
            Persona <span className="text-muted-foreground font-normal">(optional)</span>
          </Label>
          <Textarea
            id="agent-persona"
            placeholder="Describe what this agent does..."
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            rows={3}
          />
        </div>

        {/* Create button */}
        <Button
          className="w-full"
          onClick={handleCreate}
          disabled={!directory || !name.trim() || createAgent.isPending}
        >
          {createAgent.isPending ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Creating...
            </>
          ) : (
            'Create agent'
          )}
        </Button>

        {/* Error message */}
        {createAgent.isError && (
          <p className="text-destructive text-center text-sm">
            Failed to create agent. {createAgent.error?.message ?? 'Please try again.'}
          </p>
        )}
      </div>
    </div>
  );
}
