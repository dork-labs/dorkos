import { useState, useCallback, useRef, useEffect } from 'react';
import type { AgentManifest, Traits, Conventions } from '@dorkos/shared/mesh-schemas';
import {
  SOUL_MAX_CHARS,
  NOPE_MAX_CHARS,
  extractCustomProse,
  buildSoulContent,
  TRAIT_SECTION_START,
} from '@dorkos/shared/convention-files';
import { renderTraits, DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import { PersonalitySliders } from './PersonalitySliders';
import { ConventionFileEditor } from './ConventionFileEditor';
import { InjectionPreview } from './InjectionPreview';

const DEBOUNCE_MS = 500;

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
    soulContent?: string;
    nopeContent?: string;
  }) => void;
  /** Called to trigger persona-to-SOUL.md migration */
  onMigrate?: () => void;
}

/**
 * Personality configuration tab — trait sliders, SOUL.md editor, NOPE.md editor,
 * and injection preview. Composes PersonalitySliders, ConventionFileEditor,
 * and InjectionPreview components.
 */
export function PersonalityTab({
  agent,
  soulContent: initialSoulContent,
  nopeContent: initialNopeContent,
  onUpdate,
  onMigrate,
}: PersonalityTabProps) {
  // Extract manifest fields with type widening for optional fields
  const agentAny = agent as AgentManifest & {
    traits?: Traits;
    conventions?: Conventions;
    persona?: string;
  };

  const [traits, setTraits] = useState<Traits>(
    agentAny.traits ?? { tone: 3, autonomy: 3, caution: 3, communication: 3, creativity: 3 }
  );
  const [conventions, setConventions] = useState<Conventions>(
    agentAny.conventions ?? { soul: true, nope: true }
  );

  // Initialize SOUL.md content: use server content, or build from traits if none exists
  const [soulContent, setSoulContent] = useState<string>(() => {
    if (initialSoulContent) return initialSoulContent;
    const traitBlock = renderTraits({ ...DEFAULT_TRAITS, ...traits });
    return buildSoulContent(traitBlock, '');
  });
  const [nopeContent, setNopeContent] = useState<string>(initialNopeContent ?? '');

  // Separate debounce timers per editor to prevent cross-cancellation
  const soulTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nopeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (soulTimerRef.current) clearTimeout(soulTimerRef.current);
      if (nopeTimerRef.current) clearTimeout(nopeTimerRef.current);
    };
  }, []);

  // Trigger migration for legacy agents (has persona but no SOUL.md)
  const hasLegacyPersona = !initialSoulContent && !!agentAny.persona;
  useEffect(() => {
    if (hasLegacyPersona && onMigrate) {
      onMigrate();
    }
  }, [hasLegacyPersona, onMigrate]);

  // --- Handlers ---

  const handleTraitsChange = useCallback(
    (newTraits: Traits) => {
      setTraits(newTraits);

      // Regenerate trait section in SOUL.md
      if (soulContent.includes(TRAIT_SECTION_START)) {
        const customProse = extractCustomProse(soulContent);
        const traitBlock = renderTraits({ ...DEFAULT_TRAITS, ...newTraits });
        const newSoul = buildSoulContent(traitBlock, customProse);
        setSoulContent(newSoul);
        onUpdate({ traits: newTraits, soulContent: newSoul });
      } else {
        onUpdate({ traits: newTraits });
      }
    },
    [soulContent, onUpdate]
  );

  const handleSoulToggle = useCallback(
    (enabled: boolean) => {
      const newConventions = { ...conventions, soul: enabled };
      setConventions(newConventions);
      onUpdate({ conventions: newConventions });
    },
    [conventions, onUpdate]
  );

  const handleNopeToggle = useCallback(
    (enabled: boolean) => {
      const newConventions = { ...conventions, nope: enabled };
      setConventions(newConventions);
      onUpdate({ conventions: newConventions });
    },
    [conventions, onUpdate]
  );

  const handleSoulChange = useCallback(
    (content: string) => {
      setSoulContent(content);
      if (soulTimerRef.current) clearTimeout(soulTimerRef.current);
      soulTimerRef.current = setTimeout(() => {
        onUpdate({ soulContent: content });
      }, DEBOUNCE_MS);
    },
    [onUpdate]
  );

  const handleNopeChange = useCallback(
    (content: string) => {
      setNopeContent(content);
      if (nopeTimerRef.current) clearTimeout(nopeTimerRef.current);
      nopeTimerRef.current = setTimeout(() => {
        onUpdate({ nopeContent: content });
      }, DEBOUNCE_MS);
    },
    [onUpdate]
  );

  return (
    <div className="space-y-6">
      {/* Guidance */}
      <p className="text-muted-foreground text-sm">
        Configure your agent&apos;s personality, communication style, and safety boundaries. Changes
        take effect on the next session.
      </p>

      {/* 1. Personality Sliders */}
      <PersonalitySliders traits={traits} onChange={handleTraitsChange} />

      {/* 2. SOUL.md Editor */}
      <ConventionFileEditor
        title="Custom Instructions (SOUL.md)"
        content={soulContent}
        enabled={conventions.soul}
        maxChars={SOUL_MAX_CHARS}
        onChange={handleSoulChange}
        onToggle={handleSoulToggle}
      />

      {/* 3. NOPE.md Editor */}
      <ConventionFileEditor
        title="Safety Boundaries (NOPE.md)"
        content={nopeContent}
        enabled={conventions.nope}
        maxChars={NOPE_MAX_CHARS}
        disclaimer={NOPE_DISCLAIMER}
        onChange={handleNopeChange}
        onToggle={handleNopeToggle}
      />

      {/* 4. Injection Preview */}
      <InjectionPreview
        agentName={agent.name}
        agentId={agent.id}
        agentDescription={agent.description}
        agentCapabilities={agent.capabilities}
        traits={traits}
        conventions={conventions}
        soulContent={soulContent}
        nopeContent={nopeContent}
      />
    </div>
  );
}
