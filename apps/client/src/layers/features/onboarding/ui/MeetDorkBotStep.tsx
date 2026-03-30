import { useState, useCallback, useMemo, useDeferredValue } from 'react';
import { Bot } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
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
import { Button, Slider } from '@/layers/shared/ui';
import { useUpdateAgent } from '@/layers/entities/agent';
import { useOnboarding } from '../model/use-onboarding';

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
 * Meet DorkBot onboarding step — personality trait sliders with live preview
 * and avatar breathing animation. Updates the existing DorkBot agent's traits.
 */
export function MeetDorkBotStep({ onStepComplete }: MeetDorkBotStepProps) {
  const [traits, setTraits] = useState<Traits>({ ...DEFAULT_TRAITS });
  const [isReacting, setIsReacting] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const updateAgent = useUpdateAgent();
  const { config } = useOnboarding();
  const setDorkbotFirstMessage = useAppStore((s) => s.setDorkbotFirstMessage);

  // Preview text with deferred updates for smooth slider scrubbing
  const previewText = useDeferredValue(getPreviewText(traits));
  const previewKey = useMemo(() => hashPreviewText(previewText), [previewText]);

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

  const handleContinue = useCallback(() => {
    setUpdateError(null);

    const defaultDir = config?.agents?.defaultDirectory || '~/.dork/agents';
    const agentPath = `${defaultDir}/dorkbot`;

    updateAgent.mutate(
      { path: agentPath, updates: { traits } },
      {
        onSuccess: () => {
          setDorkbotFirstMessage(generateFirstMessage(traits));
          playCelebration();
          onStepComplete();
        },
        onError: (error) => {
          setUpdateError(error instanceof Error ? error.message : 'Failed to update personality');
        },
      }
    );
  }, [traits, config, updateAgent, onStepComplete, setDorkbotFirstMessage]);

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
        <h2 className="text-2xl font-semibold tracking-tight">Meet DorkBot</h2>
        <p className="text-muted-foreground max-w-sm text-sm">
          DorkBot is your guide to DorkOS. It helps you learn the platform and handles background
          jobs like scheduled tasks and summaries.
        </p>
        <p className="text-muted-foreground max-w-sm text-sm">
          Shape DorkBot&rsquo;s personality to match your style.
        </p>
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
      {updateError && (
        <p className="text-destructive text-sm" role="alert" data-testid="update-error">
          {updateError}
        </p>
      )}

      {/* Continue button */}
      <Button
        onClick={handleContinue}
        disabled={updateAgent.isPending}
        className="mt-2"
        data-testid="continue-dorkbot"
      >
        {updateAgent.isPending ? 'Saving...' : 'Continue'}
      </Button>
    </div>
  );
}
