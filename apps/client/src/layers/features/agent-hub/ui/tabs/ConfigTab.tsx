import { useState, useCallback } from 'react';
import { ChevronRight, ChevronDown, Wrench, Radio, Settings } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import {
  PersonalityTab as AgentPersonalityTab,
  ChannelsTab as AgentChannelsTab,
  ToolsTab as AgentToolsTab,
} from '@/layers/features/agent-settings';
import { useAgentHubContext } from '../../model/agent-hub-context';
import { PersonalityRadar } from '../PersonalityRadar';
import {
  PERSONALITY_PRESETS,
  DEFAULT_PRESET_COLORS,
  findMatchingPreset,
  type PersonalityPreset,
} from '../../model/personality-presets';
import type { AgentManifest, Traits } from '@dorkos/shared/mesh-schemas';

// ---------------------------------------------------------------------------
// Accordion section component
// ---------------------------------------------------------------------------

interface AccordionSectionProps {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  meta?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function AccordionSection({
  title,
  icon: Icon,
  meta,
  defaultOpen = false,
  children,
}: AccordionSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          'hover:bg-accent/50 flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors'
        )}
        aria-expanded={isOpen}
      >
        {isOpen ? (
          <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
        ) : (
          <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
        )}
        <Icon className="text-muted-foreground size-3.5 shrink-0" />
        <span className="text-[11px] font-semibold">{title}</span>
        {meta && <span className="text-muted-foreground ml-auto text-[9px]">{meta}</span>}
      </button>
      {isOpen && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConfigTab
// ---------------------------------------------------------------------------

/** Server GET response augments manifest with convention file content. */
type AgentWithConventions = AgentManifest & {
  soulContent?: string | null;
  nopeContent?: string | null;
};

/**
 * Config tab for the Agent Hub panel.
 *
 * Renders the Personality Theater at the top (placeholder for Phase 3),
 * followed by collapsible accordion sections for Tools & MCP, Channels,
 * and Advanced settings.
 */
export function ConfigTab() {
  const { agent, projectPath, onUpdate, onPersonalityUpdate } = useAgentHubContext();
  const augmented = agent as AgentWithConventions;

  const traits = agent.traits ?? {
    tone: 3,
    autonomy: 3,
    caution: 3,
    communication: 3,
    creativity: 3,
  };
  const activePreset = findMatchingPreset(traits);
  const presetColors = activePreset?.colors ?? DEFAULT_PRESET_COLORS;

  const handlePresetSelect = useCallback(
    (preset: PersonalityPreset) => {
      onPersonalityUpdate({ traits: preset.traits as Traits });
    },
    [onPersonalityUpdate]
  );

  return (
    <div className="flex flex-col">
      {/* Section 1: Personality Theater */}
      <div className="border-b px-4 py-4">
        {/* Radar chart — centered */}
        <div className="flex justify-center">
          <PersonalityRadar traits={traits} colors={presetColors} />
        </div>

        {/* Archetype name + tagline */}
        <div className="mt-3 text-center">
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

        {/* Preset pill selector — horizontal scrollable row */}
        <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1">
          {PERSONALITY_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => handlePresetSelect(preset)}
              className={cn(
                'shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-all',
                activePreset?.id === preset.id
                  ? 'text-foreground'
                  : 'bg-accent text-muted-foreground hover:text-foreground border-transparent'
              )}
              style={
                activePreset?.id === preset.id
                  ? {
                      borderColor: preset.colors.stroke,
                      background: `linear-gradient(135deg, ${preset.colors.nebula}22, ${preset.colors.wisp}15)`,
                      boxShadow: `0 0 12px ${preset.colors.nebula}33`,
                    }
                  : undefined
              }
            >
              {preset.emoji} {preset.name}
            </button>
          ))}
          {/* Custom pill — shown only when traits don't match any preset */}
          {!activePreset && (
            <span className="bg-accent text-muted-foreground border-primary shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium">
              Custom
            </span>
          )}
        </div>

        {/* Response preview bubble */}
        <div className="mt-3">
          <span className="text-muted-foreground text-[9px] font-medium tracking-wider uppercase">
            How this agent talks
          </span>
          <div className="bg-accent/50 mt-1.5 rounded-lg p-3">
            <p className="text-muted-foreground text-xs leading-relaxed italic">
              {activePreset?.sampleResponse ??
                'This agent uses a custom personality blend. Adjust traits or select a preset to see a sample response.'}
            </p>
          </div>
          <span className="text-muted-foreground mt-1 block text-[9px]">
            sample response · updates with personality
          </span>
        </div>
      </div>

      {/* Section 2: Tools & MCP */}
      <AccordionSection title="Tools & MCP" icon={Wrench}>
        <AgentToolsTab agent={agent} projectPath={projectPath} onUpdate={onUpdate} />
      </AccordionSection>

      {/* Section 3: Channels */}
      <AccordionSection title="Channels" icon={Radio}>
        <AgentChannelsTab agent={agent} />
      </AccordionSection>

      {/* Section 4: Advanced */}
      <AccordionSection title="Advanced" icon={Settings}>
        <AgentPersonalityTab
          agent={agent}
          soulContent={augmented.soulContent ?? null}
          nopeContent={augmented.nopeContent ?? null}
          onUpdate={onPersonalityUpdate}
        />
      </AccordionSection>
    </div>
  );
}
