import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { AgentManifest, Traits, Conventions } from '@dorkos/shared/mesh-schemas';
import {
  SOUL_MAX_CHARS,
  NOPE_MAX_CHARS,
  extractCustomProse,
  buildSoulContent,
} from '@dorkos/shared/convention-files';
import {
  renderTraits,
  DEFAULT_TRAITS,
  TRAIT_ORDER,
  TRAIT_PREVIEWS,
} from '@dorkos/shared/trait-renderer';
import { getAgentDisplayName, playSliderTick } from '@/layers/shared/lib';
import { useDebouncedInput } from '@/layers/shared/model';
import {
  Button,
  FieldCard,
  FieldCardContent,
  Field,
  FieldLabel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingRow,
  Switch,
} from '@/layers/shared/ui';
import { TraitSliders } from '@/layers/entities/agent';
import { ConventionFileEditor } from './ConventionFileEditor';
import { InjectionPreview } from './InjectionPreview';

const NOPE_DISCLAIMER =
  'These boundaries guide agent behavior but are not enforced at the tool level. They serve as strong instructions, not hard blocks.';

interface PersonalityTabProps {
  agent: AgentManifest;
  /** Convention file content loaded from server (null if file does not exist) */
  soulContent: string | null;
  /** Convention file content loaded from server (null if file does not exist) */
  nopeContent: string | null;
  /** Called with updated manifest fields, convention file content, or both */
  onUpdate: (updates: {
    traits?: Traits;
    conventions?: Conventions;
    behavior?: AgentManifest['behavior'];
    soulContent?: string;
    nopeContent?: string;
  }) => void;
}

/**
 * Personality configuration tab — personality summary, trait sliders,
 * custom prose editor (SOUL.md), safety boundaries (NOPE.md),
 * DorkOS knowledge toggle, and injection preview.
 */
export function PersonalityTab({
  agent,
  soulContent: initialSoulContent,
  nopeContent: initialNopeContent,
  onUpdate,
}: PersonalityTabProps) {
  const [traits, setTraits] = useState<Traits>(
    agent.traits ?? { tone: 3, autonomy: 3, caution: 3, communication: 3, creativity: 3 }
  );
  const [conventions, setConventions] = useState<Conventions>(
    agent.conventions ?? { soul: true, nope: true, dorkosKnowledge: true }
  );

  // Ref ensures debounced prose commit always has current trait values
  const traitsRef = useRef(traits);
  useEffect(() => {
    traitsRef.current = traits;
  }, [traits]);

  // Custom prose — everything after <!-- TRAITS:END --> in SOUL.md
  const proseInput = useDebouncedInput(
    extractCustomProse(initialSoulContent ?? ''),
    agent.id,
    (prose) => {
      const traitBlock = renderTraits({ ...DEFAULT_TRAITS, ...traitsRef.current });
      onUpdate({ soulContent: buildSoulContent(traitBlock, prose) });
    }
  );

  // NOPE.md content
  const nopeInput = useDebouncedInput(initialNopeContent ?? '', agent.id, (content) => {
    onUpdate({ nopeContent: content });
  });

  // Full soulContent for character count and injection preview
  const fullSoulContent = useMemo(() => {
    const traitBlock = renderTraits({ ...DEFAULT_TRAITS, ...traits });
    return buildSoulContent(traitBlock, proseInput.value);
  }, [traits, proseInput.value]);

  // --- Handlers ---

  const handleTraitsChange = useCallback(
    (newTraits: Traits) => {
      setTraits(newTraits);
      const traitBlock = renderTraits({ ...DEFAULT_TRAITS, ...newTraits });
      onUpdate({ traits: newTraits, soulContent: buildSoulContent(traitBlock, proseInput.value) });
    },
    [proseInput.value, onUpdate]
  );

  const handleResetTraits = useCallback(() => {
    const defaults: Traits = { ...DEFAULT_TRAITS } as Traits;
    setTraits(defaults);
    const traitBlock = renderTraits(defaults);
    onUpdate({ traits: defaults, soulContent: buildSoulContent(traitBlock, proseInput.value) });
  }, [proseInput.value, onUpdate]);

  const handleConventionToggle = useCallback(
    (key: keyof Conventions, enabled: boolean) => {
      const newConventions = { ...conventions, [key]: enabled };
      setConventions(newConventions);
      onUpdate({ conventions: newConventions });
    },
    [conventions, onUpdate]
  );

  // Personality summary from TRAIT_PREVIEWS
  const personalitySummary = TRAIT_ORDER.map(
    (name) => TRAIT_PREVIEWS[name][traits[name] ?? 3]
  ).join(' ');

  const allDefault = TRAIT_ORDER.every((name) => traits[name] === DEFAULT_TRAITS[name]);

  return (
    <div className="space-y-6">
      {/* Personality Summary */}
      <p className="text-muted-foreground text-sm leading-relaxed">{personalitySummary}</p>

      {/* Trait Sliders */}
      <FieldCard>
        <FieldCardContent>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Traits</h3>
            {!allDefault && (
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleResetTraits}>
                Reset to defaults
              </Button>
            )}
          </div>
          <TraitSliders
            traits={traits}
            onChange={handleTraitsChange}
            onSliderChange={() => playSliderTick()}
            showEndpoints
            showPreviews
          />
        </FieldCardContent>
      </FieldCard>

      {/* Custom Instructions (SOUL.md) — custom prose only */}
      <ConventionFileEditor
        title="Custom Instructions (SOUL.md)"
        content={proseInput.value}
        enabled={conventions.soul}
        maxChars={SOUL_MAX_CHARS}
        charCount={fullSoulContent.length}
        onChange={(v) => proseInput.onChange(v)}
        onBlur={proseInput.onBlur}
        onToggle={(enabled) => handleConventionToggle('soul', enabled)}
      />

      {/* Safety Boundaries (NOPE.md) */}
      <ConventionFileEditor
        title="Safety Boundaries (NOPE.md)"
        content={nopeInput.value}
        enabled={conventions.nope}
        maxChars={NOPE_MAX_CHARS}
        disclaimer={NOPE_DISCLAIMER}
        onChange={(v) => nopeInput.onChange(v)}
        onBlur={nopeInput.onBlur}
        onToggle={(enabled) => handleConventionToggle('nope', enabled)}
      />

      {/* DorkOS Knowledge Base toggle */}
      <FieldCard>
        <FieldCardContent>
          <Field orientation="horizontal" className="items-center justify-between">
            <div>
              <FieldLabel className="text-sm font-medium">DorkOS Knowledge Base</FieldLabel>
              <p className="text-muted-foreground text-xs">
                Inject DorkOS platform documentation into the agent&apos;s context
              </p>
            </div>
            <Switch
              checked={conventions.dorkosKnowledge}
              onCheckedChange={(checked) => handleConventionToggle('dorkosKnowledge', checked)}
              aria-label="Toggle DorkOS knowledge base injection"
            />
          </Field>
        </FieldCardContent>
      </FieldCard>

      {/* Response Mode */}
      <FieldCard>
        <FieldCardContent>
          <SettingRow
            label="Response Mode"
            description="Controls when this agent responds to messages automatically"
          >
            <Select
              value={agent.behavior?.responseMode ?? 'always'}
              onValueChange={(v) =>
                onUpdate({
                  behavior: {
                    ...agent.behavior,
                    responseMode: v as AgentManifest['behavior']['responseMode'],
                  },
                })
              }
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="always">Always respond</SelectItem>
                <SelectItem value="direct-only">Direct messages only</SelectItem>
                <SelectItem value="mention-only">Only when mentioned</SelectItem>
                <SelectItem value="silent">Never respond automatically</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
        </FieldCardContent>
      </FieldCard>

      {/* Injection Preview */}
      <InjectionPreview
        agentName={getAgentDisplayName(agent)}
        agentId={agent.id}
        agentDescription={agent.description}
        agentCapabilities={agent.capabilities}
        traits={traits}
        conventions={conventions}
        soulContent={fullSoulContent}
        nopeContent={nopeInput.value}
      />
    </div>
  );
}
