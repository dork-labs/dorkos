import { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  buildSoulContent,
  TRAIT_SECTION_START,
  extractCustomProse,
} from '@dorkos/shared/convention-files';
import { renderTraits, DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import type { Traits, Conventions } from '@dorkos/shared/mesh-schemas';

interface InjectionPreviewProps {
  /** Agent display name */
  agentName: string;
  /** Agent ID */
  agentId: string;
  /** Agent description */
  agentDescription?: string;
  /** Agent capabilities */
  agentCapabilities?: string[];
  /** Current trait values */
  traits: Traits;
  /** Convention toggle states */
  conventions: Conventions;
  /** Current SOUL.md content */
  soulContent: string;
  /** Current NOPE.md content */
  nopeContent: string;
}

/**
 * Expandable preview showing exactly what gets injected into the agent's system prompt.
 * Renders the combined output of identity, traits, SOUL.md, and NOPE.md as monospace XML.
 */
export function InjectionPreview({
  agentName,
  agentId,
  agentDescription,
  agentCapabilities,
  traits,
  conventions,
  soulContent,
  nopeContent,
}: InjectionPreviewProps) {
  const [expanded, setExpanded] = useState(false);

  const preview = useMemo(() => {
    const identityLines = [
      `Name: ${agentName}`,
      `ID: ${agentId}`,
      agentDescription && `Description: ${agentDescription}`,
      agentCapabilities?.length && `Capabilities: ${agentCapabilities.join(', ')}`,
    ].filter(Boolean);

    const blocks: string[] = [
      `<agent_identity>\n${identityLines.join('\n')}\n</agent_identity>`,
    ];

    if (conventions.soul) {
      // Render SOUL.md with current trait values
      let renderedSoul = soulContent;
      if (soulContent.includes(TRAIT_SECTION_START)) {
        const customProse = extractCustomProse(soulContent);
        const traitBlock = renderTraits({ ...DEFAULT_TRAITS, ...traits });
        renderedSoul = buildSoulContent(traitBlock, customProse);
      } else if (soulContent.trim()) {
        // No trait markers — just show raw content
        renderedSoul = soulContent;
      }

      if (renderedSoul.trim()) {
        blocks.push(`<agent_persona>\n${renderedSoul}\n</agent_persona>`);
      }
    }

    if (conventions.nope && nopeContent.trim()) {
      blocks.push(
        `<agent_safety_boundaries>\n${nopeContent}\n</agent_safety_boundaries>`
      );
    }

    return blocks.join('\n\n');
  }, [
    agentName,
    agentId,
    agentDescription,
    agentCapabilities,
    traits,
    conventions,
    soulContent,
    nopeContent,
  ]);

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-sm font-medium"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="size-4" />
        ) : (
          <ChevronRight className="size-4" />
        )}
        Preview injected prompt
      </button>

      {expanded && (
        <pre className="bg-muted max-h-64 overflow-auto rounded-md p-3">
          <code className="text-xs">{preview}</code>
        </pre>
      )}
    </div>
  );
}
