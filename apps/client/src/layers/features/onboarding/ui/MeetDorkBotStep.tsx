import { useState, useCallback, useMemo, useDeferredValue } from 'react';
import { Bot } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { validateAgentName } from '@dorkos/shared/validation';
import {
  TRAIT_ORDER,
  DEFAULT_TRAITS,
  getPreviewText,
  hashPreviewText,
  type TraitName,
} from '@dorkos/shared/trait-renderer';
import type { Traits } from '@dorkos/shared/mesh-schemas';
import { generateFirstMessage } from '@dorkos/shared/dorkbot-templates';
import { playSliderTick, playCelebration, cn } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import { Button, Input, Label, Slider } from '@/layers/shared/ui';
import { useCreateAgent } from '@/layers/features/agent-creation';

/** Slider endpoint labels for the two extremes of each trait. */
const SLIDER_LABELS: Record<TraitName, { left: string; right: string }> = {
  tone: { left: 'Serious', right: 'Playful' },
  autonomy: { left: 'Ask first', right: 'Act alone' },
  caution: { left: 'Conservative', right: 'Bold' },
  communication: { left: 'Terse', right: 'Thorough' },
  creativity: { left: 'By the book', right: 'Inventive' },
};

interface MeetDorkBotStepProps {
  onStepComplete: () => void;
}

/**
 * Meet DorkBot onboarding step with two phases:
 * 1. Name and directory setup
 * 2. Personality trait sliders with live preview and avatar breathing animation
 */
export function MeetDorkBotStep({ onStepComplete }: MeetDorkBotStepProps) {
  const [phase, setPhase] = useState<'setup' | 'personality'>('setup');
  const [name, setName] = useState('dorkbot');
  const [nameError, setNameError] = useState<string | null>(null);
  const [traits, setTraits] = useState<Traits>({ ...DEFAULT_TRAITS });
  const [isReacting, setIsReacting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const createAgent = useCreateAgent();
  const setDorkbotFirstMessage = useAppStore((s) => s.setDorkbotFirstMessage);

  // Validation
  const nameValidation = useMemo(() => {
    if (!name) return { valid: false, error: 'Name is required' };
    return validateAgentName(name);
  }, [name]);

  const directoryPath = `~/.dork/agents/${name || '...'}/`;

  // Preview text with deferred updates for smooth slider scrubbing
  const previewText = useDeferredValue(getPreviewText(traits));
  const previewKey = useMemo(() => hashPreviewText(previewText), [previewText]);

  const handleNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setName(val);
    if (val) {
      const result = validateAgentName(val);
      setNameError(result.valid ? null : (result.error ?? null));
    } else {
      setNameError('Name is required');
    }
  }, []);

  const handleAdvanceToPersonality = useCallback(() => {
    if (nameValidation.valid) {
      setPhase('personality');
    }
  }, [nameValidation.valid]);

  const handleTraitChange = useCallback((traitName: TraitName, value: number) => {
    playSliderTick();
    setTraits((prev) => ({ ...prev, [traitName]: value }));
  }, []);

  const handleSliderPointerDown = useCallback(() => {
    setIsReacting(true);
  }, []);

  const handleSliderPointerUp = useCallback(() => {
    setTimeout(() => setIsReacting(false), 600);
  }, []);

  const handleCreate = useCallback(() => {
    if (!nameValidation.valid) return;
    setCreateError(null);

    createAgent.mutate(
      {
        name,
        traits,
        conventions: { soul: true, nope: true, dorkosKnowledge: true },
      },
      {
        onSuccess: () => {
          setDorkbotFirstMessage(generateFirstMessage(traits));
          playCelebration();
          onStepComplete();
        },
        onError: (error) => {
          setCreateError(error instanceof Error ? error.message : 'Failed to create agent');
        },
      }
    );
  }, [nameValidation.valid, name, traits, createAgent, onStepComplete, setDorkbotFirstMessage]);

  if (phase === 'setup') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
        <div className="bg-muted flex size-16 items-center justify-center rounded-2xl">
          <Bot className="text-muted-foreground size-8" />
        </div>
        <div className="space-y-2">
          <h2 className="text-2xl font-semibold tracking-tight">Meet DorkBot</h2>
          <p className="text-muted-foreground max-w-sm">
            DorkBot is your default AI agent. Give it a name and shape its personality.
          </p>
        </div>

        <div className="w-full max-w-sm space-y-4 text-left">
          <div className="space-y-2">
            <Label htmlFor="dorkbot-name">Name</Label>
            <Input
              id="dorkbot-name"
              value={name}
              onChange={handleNameChange}
              aria-invalid={!!nameError}
              aria-describedby={nameError ? 'dorkbot-name-error' : undefined}
              autoFocus
            />
            {nameError && (
              <p id="dorkbot-name-error" className="text-destructive text-xs" role="alert">
                {nameError}
              </p>
            )}
          </div>

          <p className="text-muted-foreground text-xs" data-testid="directory-path">
            {directoryPath}
          </p>
        </div>

        <Button onClick={handleAdvanceToPersonality} disabled={!nameValidation.valid}>
          Next: Personality
        </Button>
      </div>
    );
  }

  // Phase 2: Personality sliders
  return (
    <div className="flex flex-1 flex-col items-center gap-6 overflow-y-auto py-4">
      {/* Avatar with breathing animation */}
      <div
        className={cn(
          'dorkbot-avatar bg-muted flex size-16 items-center justify-center rounded-2xl',
          isReacting && 'reacting'
        )}
        data-testid="dorkbot-avatar"
      >
        <Bot className="text-muted-foreground size-8" />
      </div>

      <div className="space-y-1 text-center">
        <h2 className="text-2xl font-semibold tracking-tight">Shape {name}&rsquo;s Personality</h2>
        <p className="text-muted-foreground text-sm">Adjust the sliders to tune behavior.</p>
      </div>

      {/* Live preview — layoutId enables morph animation into ChatPanel's first message */}
      <motion.div
        layoutId="dorkbot-first-message"
        className="bg-muted/50 w-full max-w-md rounded-lg border p-4"
        data-testid="personality-preview"
      >
        <AnimatePresence mode="wait">
          <motion.p
            key={previewKey}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
            className="text-muted-foreground text-sm"
          >
            {previewText}
          </motion.p>
        </AnimatePresence>
      </motion.div>

      {/* Trait sliders */}
      <div className="w-full max-w-md space-y-5" data-testid="personality-sliders">
        {TRAIT_ORDER.map((traitName) => {
          const level = traits[traitName] ?? 3;
          const labels = SLIDER_LABELS[traitName];

          return (
            <div key={traitName} className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{labels.left}</span>
                <span className="font-medium capitalize">{traitName}</span>
                <span className="text-muted-foreground">{labels.right}</span>
              </div>
              <Slider
                min={1}
                max={5}
                step={1}
                value={[level]}
                onValueChange={([val]) => handleTraitChange(traitName, val)}
                onPointerDown={handleSliderPointerDown}
                onPointerUp={handleSliderPointerUp}
                aria-label={`${traitName} trait level`}
              />
            </div>
          );
        })}
      </div>

      {/* Error message */}
      {createError && (
        <p className="text-destructive text-sm" role="alert" data-testid="create-error">
          {createError}
        </p>
      )}

      {/* Create button */}
      <Button
        onClick={handleCreate}
        disabled={createAgent.isPending}
        className="mt-2"
        data-testid="create-dorkbot"
      >
        {createAgent.isPending ? 'Creating...' : `Create ${name}`}
      </Button>
    </div>
  );
}
