import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { validateAgentName } from '@dorkos/shared/validation';
import { TRAIT_ORDER, TRAIT_LEVELS, type TraitName } from '@dorkos/shared/trait-renderer';
import type { Traits } from '@dorkos/shared/mesh-schemas';
import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { playCelebration, playSliderTick } from '@/layers/shared/lib';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Button,
  Input,
  Label,
  Slider,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useAgentCreationStore } from '../model/store';
import { useCreateAgent } from '../model/use-create-agent';
import { TemplatePicker } from './TemplatePicker';

const DEFAULT_TRAITS: Traits = {
  tone: 3,
  autonomy: 3,
  caution: 3,
  communication: 3,
  creativity: 3,
};

/**
 * Global dialog for creating a new agent. Controlled by useAgentCreationStore.
 * Renders name input, auto-generated directory path, directory override,
 * collapsible personality sliders, and create/cancel actions.
 */
export function CreateAgentDialog() {
  const { isOpen, close } = useAgentCreationStore();
  const createAgent = useCreateAgent();
  const transport = useTransport();
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Focus name input when dialog opens (avoids jsx-a11y/no-autofocus)
  useEffect(() => {
    if (isOpen) nameInputRef.current?.focus();
  }, [isOpen]);

  // Fetch config for default directory
  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 30_000,
  });

  const defaultDirectory = config?.agents?.defaultDirectory ?? '~/.dork/agents';

  // Form state
  const [name, setName] = useState('');
  const [directoryOverride, setDirectoryOverride] = useState('');
  const [template, setTemplate] = useState<string | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [traits, setTraits] = useState<Traits>({ ...DEFAULT_TRAITS });
  const [personalityOpen, setPersonalityOpen] = useState(false);

  // Validation
  const nameValidation = useMemo(() => {
    if (!name) return { valid: false, error: undefined };
    return validateAgentName(name);
  }, [name]);

  const showNameError = name.length > 0 && !nameValidation.valid;
  const resolvedDirectory = directoryOverride || `${defaultDirectory}/${name}`;
  const canSubmit = name.length > 0 && nameValidation.valid && !createAgent.isPending;

  const handleTraitChange = useCallback((traitName: TraitName, value: number) => {
    playSliderTick();
    setTraits((prev) => ({ ...prev, [traitName]: value }));
  }, []);

  function resetForm() {
    setName('');
    setDirectoryOverride('');
    setTemplate(null);
    setTemplateOpen(false);
    setTraits({ ...DEFAULT_TRAITS });
    setPersonalityOpen(false);
  }

  const handleCreate = useCallback(() => {
    if (!canSubmit) return;

    createAgent.mutate(
      {
        name,
        ...(directoryOverride ? { directory: directoryOverride } : {}),
        ...(template ? { template } : {}),
        traits,
      },
      {
        onSuccess: () => {
          playCelebration();
          close();
          resetForm();
        },
        onError: (error) => {
          toast.error(error instanceof Error ? error.message : 'Failed to create agent');
        },
      }
    );
  }, [canSubmit, name, directoryOverride, template, traits, createAgent, close]);

  function handleOpenChange(open: boolean) {
    if (!open) {
      close();
      resetForm();
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Agent</DialogTitle>
          <DialogDescription>
            Set up a new agent with a name and optional personality configuration.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Name input */}
          <div className="space-y-2">
            <Label htmlFor="agent-name">Name</Label>
            <Input
              ref={nameInputRef}
              id="agent-name"
              placeholder="my-agent"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={showNameError}
              aria-describedby={showNameError ? 'agent-name-error' : undefined}
            />
            {showNameError && (
              <p id="agent-name-error" className="text-destructive text-xs" role="alert">
                {nameValidation.error}
              </p>
            )}
          </div>

          {/* Auto-generated directory display */}
          <div className="space-y-2">
            <Label htmlFor="agent-directory">Directory</Label>
            <p className="text-muted-foreground truncate text-xs" data-testid="directory-preview">
              {name ? resolvedDirectory : `${defaultDirectory}/...`}
            </p>
            <Input
              id="agent-directory"
              placeholder="Override directory (optional)"
              value={directoryOverride}
              onChange={(e) => setDirectoryOverride(e.target.value)}
            />
          </div>

          {/* Template section (collapsible) */}
          <Collapsible open={templateOpen} onOpenChange={setTemplateOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1 text-sm transition-colors"
                data-testid="template-toggle"
              >
                <ChevronDown
                  className={cn('size-4 transition-transform', templateOpen && 'rotate-180')}
                />
                Template
                {template && (
                  <span className="bg-primary/10 text-primary ml-1 rounded px-1.5 py-0.5 text-xs">
                    selected
                  </span>
                )}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="pt-3" data-testid="template-section">
                <TemplatePicker selectedTemplate={template} onSelect={setTemplate} />
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Personality section (collapsible) */}
          <Collapsible open={personalityOpen} onOpenChange={setPersonalityOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1 text-sm transition-colors"
                data-testid="personality-toggle"
              >
                <ChevronDown
                  className={cn('size-4 transition-transform', personalityOpen && 'rotate-180')}
                />
                Personality
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="space-y-4 pt-3" data-testid="personality-section">
                {TRAIT_ORDER.map((traitName) => {
                  const level = traits[traitName] ?? 3;
                  const entry = TRAIT_LEVELS[traitName][level];

                  return (
                    <div key={traitName} className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-sm font-medium capitalize">{traitName}</Label>
                        <span className="text-muted-foreground text-xs">
                          {level}/5 {entry.label}
                        </span>
                      </div>
                      <Slider
                        value={[level]}
                        onValueChange={([v]) => handleTraitChange(traitName, v)}
                        min={1}
                        max={5}
                        step={1}
                        aria-label={`${traitName} trait level`}
                      />
                    </div>
                  );
                })}
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!canSubmit}>
            {createAgent.isPending ? 'Creating...' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
