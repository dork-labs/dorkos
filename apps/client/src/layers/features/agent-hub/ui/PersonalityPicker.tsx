import { useState, useCallback } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Settings } from 'lucide-react';
import { generateVoiceSample } from '@dorkos/shared/dorkbot-templates';
import { cn, playSliderTick } from '@/layers/shared/lib';
import { TraitSliders, PresetPill } from '@/layers/entities/agent';
import { PersonalityRadar } from './PersonalityRadar';
import {
  PERSONALITY_PRESETS,
  DEFAULT_PRESET_COLORS,
  findMatchingPreset,
} from '../model/personality-presets';
import type { Traits } from '@dorkos/shared/mesh-schemas';

/**
 * How the picker arranges itself.
 *
 * - `inline`: radar + label pinned left of the presets at wide sizes (the
 *   settings popover). The sample line stays hidden.
 * - `stacked`: a larger radar + label centered above the presets, with a
 *   distinct sample-voice block below (the onboarding conversation card).
 */
export type PersonalityPickerLayout = 'inline' | 'stacked';

export interface PersonalityPickerProps {
  /** Current personality traits (controlled). */
  traits: Traits;
  /** Callback when traits change via preset selection or slider. */
  onTraitsChange: (traits: Traits) => void;
  /** Use compact sizing for inline panels. @default false */
  compact?: boolean;
  /** How the picker arranges its parts. @default 'inline' */
  layout?: PersonalityPickerLayout;
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
 * In `inline` layout the arrangement flips from vertical to horizontal via an
 * `@container` query on the parent width (not viewport); in `stacked` layout the
 * radar sits large and centered above the presets and the sample line shows.
 *
 * Controlled component: consumers own the traits state and provide
 * their own chrome (headers, action buttons, error displays).
 */
export function PersonalityPicker({
  traits,
  onTraitsChange,
  compact = false,
  layout = 'inline',
  sampleLabel = 'How this agent talks',
  className,
}: PersonalityPickerProps) {
  const [mode, setMode] = useState<'presets' | 'custom'>('presets');
  const reducedMotion = useReducedMotion() ?? false;
  const stacked = layout === 'stacked';

  const activePreset = findMatchingPreset(traits);
  const presetColors = activePreset?.colors ?? DEFAULT_PRESET_COLORS;
  // Only the stacked layout renders the sample voice, so skip the lookup inline.
  const sampleText = stacked ? generateVoiceSample(traits, activePreset?.id) : '';

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
          !stacked && '@[480px]/picker:flex-row @[480px]/picker:items-center @[480px]/picker:gap-6',
          stacked && 'gap-4'
        )}
      >
        {/* Radar + archetype label — pinned left at wide sizes (inline), or large
            and centered on top (stacked). */}
        <div
          className={cn(
            'flex flex-col items-center gap-1',
            !stacked && '@[480px]/picker:w-[200px] @[480px]/picker:shrink-0',
            stacked && 'gap-1.5'
          )}
        >
          <div data-testid="personality-radar">
            <PersonalityRadar
              traits={traits}
              colors={presetColors}
              size={stacked ? 240 : compact ? 180 : 200}
              className={cn(
                stacked && 'w-full max-w-[240px]',
                !stacked && (compact ? 'w-[90%] max-w-[240px]' : 'w-full max-w-[200px]')
              )}
            />
          </div>

          <div className="text-center">
            <h3
              className={cn(
                'bg-clip-text font-bold text-transparent',
                stacked ? 'text-base' : 'text-sm'
              )}
              style={{
                backgroundImage: `linear-gradient(135deg, ${presetColors.stroke}, ${presetColors.strokeEnd})`,
              }}
            >
              {activePreset?.name ?? 'Custom'}
            </h3>
            <p className={cn('text-muted-foreground mt-0.5', stacked ? 'text-xs' : 'text-[11px]')}>
              {activePreset?.tagline ?? 'A custom blend of personality traits.'}
            </p>
          </div>
        </div>

        {/* Pills or sliders — fills remaining space at wide sizes (inline), or
            centered below the radar (stacked). */}
        <div
          className={cn(
            'flex w-full min-w-0 flex-col items-center gap-3',
            !stacked && '@[480px]/picker:items-start'
          )}
        >
          <AnimatePresence mode="wait" initial={false}>
            {mode === 'presets' ? (
              <motion.div
                key="presets"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={FADE_TRANSITION}
                className={cn(
                  'flex max-w-sm flex-wrap justify-center gap-1.5',
                  !stacked && '@[480px]/picker:justify-start'
                )}
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
                className={cn(
                  'flex w-full flex-col items-center gap-3',
                  !stacked && '@[480px]/picker:items-start'
                )}
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

      {/* Sample voice — DorkBot "speaking" in the chosen personality. Shown as a
          distinct quote block in the stacked layout; the inline (settings) layout
          keeps it hidden. */}
      <div
        className={cn('w-full max-w-sm', stacked ? 'mt-4 flex flex-col items-center' : 'hidden')}
      >
        <span className="text-muted-foreground self-start text-[9px] font-medium tracking-wider uppercase">
          {sampleLabel}
        </span>
        <div className="border-primary/40 bg-accent/40 mt-1 w-full rounded-md border-l-2 py-2 pr-3 pl-3">
          {stacked ? (
            <AnimatePresence mode="wait" initial={false}>
              <motion.p
                key={sampleText}
                data-testid="personality-sample"
                initial={reducedMotion ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reducedMotion ? undefined : { opacity: 0, y: -4 }}
                transition={FADE_TRANSITION}
                className="text-muted-foreground text-xs leading-relaxed italic"
              >
                &ldquo;{sampleText}&rdquo;
              </motion.p>
            </AnimatePresence>
          ) : (
            <p className="text-muted-foreground text-xs leading-relaxed italic">
              {activePreset?.sampleResponse ??
                'This agent uses a custom personality blend. Select a preset to see a sample response.'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
