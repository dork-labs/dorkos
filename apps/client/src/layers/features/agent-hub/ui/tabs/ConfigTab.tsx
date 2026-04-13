import { useState, useCallback } from 'react';
import { ChevronRight, ChevronDown, Wrench, Radio, Settings, Folder, Plus, X } from 'lucide-react';
import { cn, shortenHomePath } from '@/layers/shared/lib';
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui';
import { useRuntimeCapabilities } from '@/layers/entities/runtime';
import {
  PersonalityTab as AgentPersonalityTab,
  ChannelsTab as AgentChannelsTab,
  ToolsTab as AgentToolsTab,
} from '@/layers/features/agent-settings';
import { useAgentHubContext } from '../../model/agent-hub-context';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

// ---------------------------------------------------------------------------
// Runtime labels
// ---------------------------------------------------------------------------

const RUNTIME_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex',
  windsurf: 'Windsurf',
  gemini: 'Gemini',
  cline: 'Cline',
  'roo-code': 'Roo Code',
  copilot: 'Copilot',
  'amazon-q': 'Amazon Q',
  continue: 'Continue',
  augment: 'Augment',
  'jetbrains-ai': 'JetBrains AI',
  'kilo-code': 'Kilo Code',
  trae: 'Trae',
  other: 'Other',
  mock: 'Mock Runtime',
};

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
// Helpers
// ---------------------------------------------------------------------------

/** Retrieve agent's tags from the manifest (field is not in base schema). */
function getAgentTags(agent: AgentManifest): string[] {
  return ((agent as Record<string, unknown>).tags as string[] | undefined) ?? [];
}

/** Server GET response augments manifest with convention file content. */
type AgentWithConventions = AgentManifest & {
  soulContent?: string | null;
  nopeContent?: string | null;
};

// ---------------------------------------------------------------------------
// ConfigTab
// ---------------------------------------------------------------------------

/**
 * Config tab for the Agent Hub panel.
 *
 * Renders agent metadata (description, runtime, directory, tags) at the top,
 * followed by collapsible accordion sections for Tools & MCP, Channels,
 * and Advanced settings. Personality editing lives in the hero popover.
 */
export function ConfigTab() {
  const { agent, projectPath, onUpdate, onPersonalityUpdate } = useAgentHubContext();
  const augmented = agent as AgentWithConventions;
  const { data: capData } = useRuntimeCapabilities();
  const availableRuntimes = capData ? Object.keys(capData.capabilities) : [agent.runtime];

  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [newTag, setNewTag] = useState('');
  const [showTagInput, setShowTagInput] = useState(false);

  const startEditing = useCallback((field: string, currentValue: string) => {
    setEditingField(field);
    setEditValue(currentValue);
  }, []);

  const commitEdit = useCallback(
    (field: string) => {
      if (editValue.trim()) {
        onUpdate({ [field]: editValue.trim() } as Partial<AgentManifest>);
      }
      setEditingField(null);
    },
    [editValue, onUpdate]
  );

  const handleAddTag = useCallback(() => {
    const trimmed = newTag.trim();
    if (!trimmed) return;
    const currentTags = getAgentTags(agent);
    if (!currentTags.includes(trimmed)) {
      onUpdate({ tags: [...currentTags, trimmed] } as unknown as Partial<AgentManifest>);
    }
    setNewTag('');
    setShowTagInput(false);
  }, [newTag, agent, onUpdate]);

  const handleRemoveTag = useCallback(
    (tag: string) => {
      const currentTags = getAgentTags(agent);
      onUpdate({
        tags: currentTags.filter((t) => t !== tag),
      } as unknown as Partial<AgentManifest>);
    },
    [agent, onUpdate]
  );

  const tags = getAgentTags(agent);

  return (
    <div className="flex flex-col">
      {/* Section 1: Agent Metadata */}
      <div className="space-y-4 border-b p-4">
        {/* Description */}
        <div className="space-y-1">
          <div className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
            Description
          </div>
          {editingField === 'description' ? (
            <textarea
              autoFocus
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={() => commitEdit('description')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) commitEdit('description');
              }}
              className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              rows={3}
            />
          ) : (
            <button
              type="button"
              className="hover:bg-accent text-muted-foreground w-full rounded-md px-2 py-1 text-left text-sm transition-colors"
              onClick={() => startEditing('description', agent.description ?? '')}
              data-testid="description-field"
            >
              {agent.description || 'Add a description...'}
            </button>
          )}
        </div>

        {/* Runtime + Directory row */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <div className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
              Runtime
            </div>
            <Select
              value={agent.runtime ?? 'claude-code'}
              onValueChange={(v) => onUpdate({ runtime: v } as Partial<AgentManifest>)}
            >
              <SelectTrigger className="h-8 text-sm" responsive={false}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableRuntimes.map((type) => (
                  <SelectItem key={type} value={type} responsive={false}>
                    {RUNTIME_LABELS[type] ?? type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <div className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
              Directory
            </div>
            <div className="text-muted-foreground flex items-center gap-1.5 rounded-md px-2 py-1.5">
              <Folder className="size-3.5 shrink-0" />
              <span className="truncate font-mono text-xs">{shortenHomePath(projectPath)}</span>
            </div>
          </div>
        </div>

        {/* Tags */}
        <div className="space-y-1">
          <div className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
            Tags
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {tags.map((tag) => (
              <span
                key={tag}
                className="bg-accent text-accent-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
              >
                {tag}
                <button
                  type="button"
                  onClick={() => handleRemoveTag(tag)}
                  className="hover:text-destructive transition-colors"
                  aria-label={`Remove tag ${tag}`}
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            {showTagInput ? (
              <Input
                autoFocus
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onBlur={handleAddTag}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddTag();
                  if (e.key === 'Escape') setShowTagInput(false);
                }}
                className="h-6 w-24 text-xs"
                placeholder="tag name"
              />
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowTagInput(true)}
                className="text-muted-foreground hover:text-foreground h-auto gap-0.5 px-1 py-0 text-xs"
              >
                <Plus className="size-3" /> Add
              </Button>
            )}
          </div>
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
