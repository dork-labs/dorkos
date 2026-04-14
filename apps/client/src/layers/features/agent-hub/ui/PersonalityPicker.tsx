import { useState, useCallback } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Settings } from 'lucide-react';
import { cn, playSliderTick } from '@/layers/shared/lib';
import { TraitSliders, PresetPill } from '@/layers/entities/agent';
import { PersonalityRadar } from './PersonalityRadar';
import {
  PERSONALITY_PRESETS,
  DEFAULT_PRESET_COLORS,
  findMatchingPreset,
} from '../model/personality-presets';
import type { Traits } from '@dorkos/shared/mesh-schemas';

export interface PersonalityPickerProps {
  /** Current personality traits (controlled). */
  traits: Traits;
  /** Callback when traits change via preset selection or slider. */
  onTraitsChange: (traits: Traits) => void;
  /** Use compact sizing for inline panels. @default false */
  compact?: boolean;
  /** Label above the sample response preview. @default 'How this agent talks' */
  sampleLabel?: string;
  /** Container className. */
  className?: string;
}

const FADE_TRANSITION = { duration: 0.2, ease: 'easeInOut' } as const;

/**
 * Personality picker body — radar, archetype label, preset pills,
 * custom sliders toggle, and sample response preview.
 *
 * Uses a "Custom" pill at the end of the preset row to toggle into
 * custom mode (sliders). A "Presets" pill in custom mode switches back.
 * Layout flips from vertical to horizontal via `@container` query
 * on the parent width (not viewport).
 *
 * Controlled component: consumers own the traits state and provide
 * their own chrome (headers, action buttons, error displays).
 */
export function PersonalityPicker({
  traits,
  onTraitsChange,
  compact = false,
  sampleLabel = 'How this agent talks',
  className,
}: PersonalityPickerProps) {
  const [mode, setMode] = useState<'presets' | 'custom'>('presets');

  const activePreset = findMatchingPreset(traits);
  const presetColors = activePreset?.colors ?? DEFAULT_PRESET_COLORS;

  const handlePresetSelect = useCallback(
    (preset: (typeof PERSONALITY_PRESETS)[number]) => {
      onTraitsChange(preset.traits as Traits);
      setMode('presets');
      playSliderTick();
    },
    [onTraitsChange]
  );

  const handleEnterCustom = useCallback(() => {
    setMode('custom');
    playSliderTick();
  }, []);

  const handleBackToPresets = useCallback(() => {
    setMode('presets');
    playSliderTick();
  }, []);

  return (
    <div className={cn('@container/picker w-full', className)}>
      <div
        className={cn(
          'flex flex-col items-center gap-3',
          '@[480px]/picker:flex-row @[480px]/picker:items-center @[480px]/picker:gap-6'
        )}
      >
        {/* Radar + archetype label — pinned left at wide sizes */}
        <div
          className={cn(
            'flex flex-col items-center gap-1',
            '@[480px]/picker:w-[200px] @[480px]/picker:shrink-0'
          )}
        >
          <div data-testid="personality-radar">
            <PersonalityRadar
              traits={traits}
              colors={presetColors}
              size={compact ? 180 : 200}
              className={compact ? 'w-[90%] max-w-[240px]' : 'w-full max-w-[200px]'}
            />
          </div>

          <div className="text-center">
            <h3
              className="bg-clip-text text-sm font-bold text-transparent"
              style={{
                backgroundImage: `linear-gradient(135deg, ${presetColors.stroke}, ${presetColors.strokeEnd})`,
              }}
            >
              {activePreset?.name ?? 'Custom'}
            </h3>
            <p className="text-muted-foreground mt-0.5 text-[11px]">
              {activePreset?.tagline ?? 'A custom blend of personality traits.'}
            </p>
          </div>
        </div>

        {/* Pills or sliders — fills remaining space at wide sizes */}
        <div className="flex w-full min-w-0 flex-col items-center gap-3 @[480px]/picker:items-start">
          <AnimatePresence mode="wait" initial={false}>
            {mode === 'presets' ? (
              <motion.div
                key="presets"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={FADE_TRANSITION}
                className="flex max-w-sm flex-wrap justify-center gap-1.5 @[480px]/picker:justify-start"
                data-testid="preset-pills"
              >
                {PERSONALITY_PRESETS.map((preset) => (
                  <PresetPill
                    key={preset.id}
                    emoji={preset.emoji}
                    name={preset.name}
                    colors={preset.colors}
                    active={activePreset?.id === preset.id}
                    size={compact ? 'sm' : 'default'}
                    glow
                    onClick={() => handlePresetSelect(preset)}
                  />
                ))}
                {/* Custom pill — enters custom mode */}
                <button
                  type="button"
                  onClick={handleEnterCustom}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1.5 rounded-full border border-dashed font-medium transition-all',
                    'text-muted-foreground hover:text-foreground hover:border-foreground/20 border-border',
                    compact ? 'px-2.5 py-1 text-[11px]' : 'px-3 py-1 text-xs'
                  )}
                  data-testid="custom-toggle"
                >
                  <Settings className="size-3" />
                  <span>Custom</span>
                </button>
              </motion.div>
            ) : (
              <motion.div
                key="custom"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={FADE_TRANSITION}
                className="flex w-full flex-col items-center gap-3 @[480px]/picker:items-start"
              >
                {/* Mode pills: Presets escape + Custom active */}
                <div className="flex gap-1.5" data-testid="custom-mode-pills">
                  <button
                    type="button"
                    onClick={handleBackToPresets}
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1.5 rounded-full border border-dashed font-medium transition-all',
                      'text-muted-foreground hover:text-foreground hover:border-foreground/20 border-border',
                      compact ? 'px-2.5 py-1 text-[11px]' : 'px-3 py-1 text-xs'
                    )}
                    data-testid="presets-toggle"
                  >
                    <span>&larr;</span>
                    <span>Presets</span>
                  </button>
                  <span
                    className={cn(
                      'bg-accent text-foreground inline-flex shrink-0 items-center gap-1.5 rounded-full border font-medium',
                      'border-foreground/15',
                      compact ? 'px-2.5 py-1 text-[11px]' : 'px-3 py-1 text-xs'
                    )}
                  >
                    <Settings className="size-3" />
                    <span>Custom</span>
                  </span>
                </div>

                {/* Trait sliders */}
                <div
                  className={cn('w-full', compact ? 'max-w-sm' : 'max-w-md')}
                  onPointerDown={() => playSliderTick()}
                >
                  <TraitSliders
                    traits={traits}
                    onChange={onTraitsChange}
                    onSliderChange={() => playSliderTick()}
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Sample response preview (hidden for now) */}
      <div className="hidden w-full max-w-sm">
        <span className="text-muted-foreground text-[9px] font-medium tracking-wider uppercase">
          {sampleLabel}
        </span>
        <div className="bg-accent/50 mt-1 rounded-lg p-3">
          <p className="text-muted-foreground text-xs leading-relaxed italic">
            {activePreset?.sampleResponse ??
              'This agent uses a custom personality blend. Select a preset to see a sample response.'}
          </p>
        </div>
      </div>
    </div>
  );
}
